// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::*;

// Teardown uses gateway authentication but never invokes inference. Keep the
// retained document and resource graph intact; narrow only subprocess secrets.
pub(super) fn destroy_environment(document: &Document) -> Document {
    let mut environment = document.clone();
    for provider in environment.provider_definitions_mut() {
        provider.credential = None;
    }
    for sandbox in environment.spec.sandboxes.values_mut() {
        // Destroy never reads the image, so it needs no metadata path.
        sandbox.image.metadata = None;
        sandbox.integrations.clear();
        sandbox.agent.integrations.clear();
        sandbox.agent.integration_refs.clear();
    }
    environment.spec.integrations.clear();
    environment
}

impl Deployment {
    pub(in crate::deployment) async fn teardown_deployment(
        &self,
        cancel: &CancellationToken,
        preview: bool,
    ) -> Result<OperationResult, Error> {
        let (bundle, store) = self.open()?;
        let mut record = store.load()?.ok_or(Error::Conflict(
            "destroy requires existing deployment state",
        ))?;
        let runtime = record.document.has_runtime();
        if runtime {
            self.recover_helm_binding(&bundle, &store, &record, preview, cancel)
                .await?;
        }
        let bindings = self
            .state_bindings(
                &bundle,
                &store,
                &record.document,
                &record.generations,
                cancel,
            )
            .await?;
        record.reconcile_pending_creations(&bindings);
        validate_teardown_state(&record, &bindings)?;
        let compiled = compile::compile_teardown(
            &record.document,
            &record.generations,
            &bundle.manifest.version,
            &bindings.keys().cloned().collect(),
        )?;
        let mut result = OperationResult::planned(Vec::new());
        result.describe_sources(&record.document)?;
        result.retained.extend(compiled.retained.iter().cloned());
        if record.destroyed() {
            if !preview {
                result.outcome = Outcome::Destroyed;
            }
            return Ok(result);
        }
        // Observe and validate the complete saved plan before the first delete.
        let (changes, planned) = self
            .plan_teardown(&bundle, &store, &record, &bindings, &compiled, cancel)
            .await?;
        result.changes = changes;
        if preview {
            return Ok(result);
        }
        // The teardown plan now accounts for every saved identity, so destroy
        // owns recovery from this point.
        record.begin_destroy();
        store.save(&record)?;
        (self.progress)(Progress::Destroying);
        if planned {
            if runtime {
                self.checkpoint_helm_binding(&bundle, &store, &record, cancel)
                    .await?;
            }
            let applied = self
                .tofu(
                    &bundle,
                    &store,
                    &destroy_environment(&record.document),
                    &["apply", "-input=false", "-no-color", "destroy.plan"],
                    cancel,
                )
                .await;
            // Cancellation keeps the durable checkpoint for the next destroy.
            // Otherwise repair lost state before returning the original error,
            // without retrying any remote mutation.
            if runtime {
                if cancel.is_cancelled() {
                    return Err(Error::Cancelled);
                }
                let restored = self
                    .recover_helm_binding(&bundle, &store, &record, false, cancel)
                    .await?;
                if restored && applied.is_ok() {
                    return Err(Error::Conflict(
                        "Helm release deletion was not confirmed; its binding was restored, rerun destroy",
                    ));
                }
            }
            applied?;
        }
        record.finish_destroy();
        store.save(&record)?;
        result.outcome = Outcome::Destroyed;
        Ok(result)
    }

    /// Plan teardown from the bindings already read from state; nothing has
    /// changed that state since.
    async fn plan_teardown(
        &self,
        bundle: &Bundle,
        store: &Store,
        record: &Record,
        bindings: &BTreeMap<String, StateBinding>,
        compiled: &compile::CompiledTeardown,
        cancel: &CancellationToken,
    ) -> Result<(Vec<Change>, bool), Error> {
        if bindings.is_empty() {
            if record.succeeded() || record.destroying() {
                return Err(Error::Conflict(
                    "established state is missing; destroy cannot infer unbound resources",
                ));
            }
            return Ok((Vec::new(), false));
        }
        let expected = with_observations(
            &teardown_expected(record, bindings)?,
            &compiled.observations,
        );
        self.initialize(bundle, store, &compiled.graph, cancel)
            .await?;
        let plan = self
            .saved_plan(
                bundle,
                store,
                &destroy_environment(&record.document),
                "destroy.plan",
                cancel,
            )
            .await?;
        Ok((
            check_destroy_plan(&plan, &expected, bindings, &compiled.retained)?,
            true,
        ))
    }
}

fn teardown_expected(
    record: &Record,
    bindings: &BTreeMap<String, StateBinding>,
) -> Result<BTreeMap<String, Row>, Error> {
    let objects = compile::targets(&record.document, &record.generations)?;
    let mut runtime = if record.document.has_runtime() {
        compile::runtime_targets(&record.document, &record.generations)?
    } else {
        Vec::new()
    };
    bind_teardown_processes(record, &mut runtime, bindings)?;
    let object_addresses: BTreeSet<&str> = objects
        .iter()
        .map(|target| target.address.as_str())
        .collect();
    if bindings.keys().any(|address| {
        object_addresses.contains(address.as_str()) || plan::reconstructible(address)
    }) && !bindings.contains_key("openshell_workspace.deployment")
    {
        return Err(Error::Conflict(
            "destroy requires the retained workspace binding",
        ));
    }
    let runtime_addresses: BTreeSet<String> = runtime
        .iter()
        .map(|target| target.address.clone())
        .collect();
    let mut expected = allowed(&objects);
    expected.extend(allowed(&runtime));
    for (address, binding) in bindings {
        if plan::disposable(address) || plan::reconstructible(address) {
            expected.entry(address.clone()).or_default();
            continue;
        }
        let want = expected.get(address).ok_or(Error::Conflict(
            "destroy encountered an undeclared resource binding",
        ))?;
        if runtime_addresses.contains(address) {
            if address != crate::kubernetes::gateway::ADDRESS && binding.differs(want) {
                return Err(Error::Conflict(
                    "destroy storage configuration disagrees with retained intent",
                ));
            }
        } else if !binding.spec.is_empty() {
            return Err(Error::Conflict(
                "unexpected specification in OpenShell state",
            ));
        }
    }
    Ok(expected)
}

fn bind_teardown_processes(
    record: &Record,
    targets: &mut [Target],
    bindings: &BTreeMap<String, StateBinding>,
) -> Result<(), Error> {
    for target in targets {
        kubernetes_binding(target, bindings)?;
        if target.address == crate::kubernetes::gateway::ADDRESS {
            continue;
        }
        if matches!(
            target.kind.as_str(),
            crate::kubernetes::GATEWAY_KIND | crate::kubernetes::AUTH_KIND
        ) {
            if let Some(binding) = bindings.get(&target.address)
                && binding.differs(&target.values)
            {
                return Err(Error::Conflict(
                    "Kubernetes gateway binding differs from retained intent",
                ));
            }
            continue;
        }
        let storage = if target.kind == GATEWAY_KIND {
            Some(GATEWAY_STORAGE.to_owned())
        } else if crate::services::resource_behavior(&target.kind).runtime_process {
            crate::services::required_storage_address(
                &record.document,
                &record.generations,
                &target.address,
            )?
        } else {
            None
        };
        let Some(storage) = storage else { continue };
        if bindings.contains_key(&target.address) && !bindings.contains_key(&storage) {
            return Err(Error::Conflict(
                "destroy requires independent storage bindings before removing a managed process",
            ));
        }
        let want = Spec::from_values(&target.kind, &target.values)
            .map_err(|_| Error::State("invalid runtime intent"))?;
        if plan::disposable(&target.address) {
            continue;
        }
        bound_spec(&target.kind, &want, bindings.get(&target.address))?
            .write_values(&target.kind, &mut target.values)?;
    }
    Ok(())
}

fn validate_teardown_state(
    record: &Record,
    bindings: &BTreeMap<String, StateBinding>,
) -> Result<(), Error> {
    if record.pending() {
        return Err(Error::Conflict(
            "unfinished apply may have created resources whose IDs were not saved; apply the original configuration again before destroy",
        ));
    }
    for (service, storage) in crate::services::remove_plans(&record.document, &record.generations)?
        .into_iter()
        .flat_map(|plan| plan.required_storage)
    {
        if bindings.contains_key(&crate::docker_compute::address(&service))
            && !bindings.contains_key(&storage)
        {
            return Err(Error::Conflict(
                "apply once to establish independent service storage binding before destroy",
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn teardown_keeps_provisioning_identity_without_requesting_image_metadata() {
        let (document, _) = crate::deployment::tests::kubernetes_context();
        assert!(document.credential_names().contains(&"TEST_IMAGE_METADATA"));
        let environment = destroy_environment(&document);
        assert_eq!(environment.credential_names(), ["TEST_KUBECONFIG"]);
        assert!(
            document.spec.sandboxes["assistant"]
                .image
                .metadata
                .is_some()
        );
    }

    #[tokio::test]
    async fn failed_kubernetes_platform_creation_skips_empty_agent_teardown_without_credentials() {
        struct NoSecrets;
        impl Secrets for NoSecrets {
            fn resolve(&self, _: &str) -> Result<String, crate::ObservationError> {
                panic!("an empty agent teardown must not resolve gateway credentials")
            }
        }
        let (document, _) = crate::deployment::tests::kubernetes_context();
        let record = Record::new(document).unwrap();
        let directory = tempfile::tempdir().unwrap();
        let store = Store::open(directory.path()).unwrap();
        let bundle = Bundle {
            directory: directory.path().join("unavailable-bundle"),
            manifest: crate::bundle::Manifest {
                version: "0.1.0".into(),
                rust: "fixture".into(),
                opentofu: compile::OPENTOFU_VERSION.into(),
                files: BTreeMap::new(),
            },
        };
        let deployment =
            Deployment::new(directory.path(), &bundle.directory).with_secrets(Arc::new(NoSecrets));
        let compiled = compile::compile_teardown(
            &record.document,
            &record.generations,
            &bundle.manifest.version,
            &BTreeSet::new(),
        )
        .unwrap();
        let (changes, planned) = deployment
            .plan_teardown(
                &bundle,
                &store,
                &record,
                &BTreeMap::new(),
                &compiled,
                &CancellationToken::new(),
            )
            .await
            .unwrap();
        assert!(changes.is_empty());
        assert!(!planned);
        assert!(!store.directory.join("main.tf.json").exists());
    }

    #[test]
    fn kubernetes_destroy_retains_storage_and_rejects_an_unbound_gateway() {
        let (document, _) = crate::deployment::tests::kubernetes_context();
        let record = Record::new(document).unwrap();
        let targets = compile::runtime_targets(&record.document, &record.generations).unwrap();
        let bindings: BTreeMap<String, StateBinding> = targets
            .iter()
            .map(|target| {
                let mut values = serde_json::to_value(&target.values).unwrap();
                values["id"] = json!(if target.kind == "helm_release" {
                    target.values["name"].clone()
                } else {
                    format!("physical-{}", target.kind)
                });
                (
                    target.address.clone(),
                    serde_json::from_value(values).unwrap(),
                )
            })
            .collect();
        teardown_expected(&record, &bindings).unwrap();
        let compiled = compile::compile_teardown(
            &record.document,
            &record.generations,
            "0.1.0",
            &bindings.keys().cloned().collect(),
        )
        .unwrap();
        assert_eq!(
            compiled.retained,
            BTreeSet::from([KUBERNETES_STORAGE.into()])
        );
        let graph = compiled.graph;
        assert_eq!(graph["provider"]["openshell"], json!({"destroy": true}));
        assert_eq!(graph["resource"].as_object().unwrap().len(), 1);
        assert_eq!(
            graph["resource"]["openshell_kubernetes_storage"]["runtime"]["lifecycle"]["prevent_destroy"],
            true
        );
        assert!(graph.get("data").is_none());
        let mut invalid = bindings;
        invalid.remove(KUBERNETES_STORAGE);
        assert!(teardown_expected(&record, &invalid).is_err());
    }

    #[test]
    fn unfinished_apply_without_complete_runtime_state_explains_how_to_recover() {
        let document = Document::parse(
            include_bytes!("../../../../../examples/fabric-openclaw.yaml").as_slice(),
        )
        .unwrap();
        let mut record = Record::new(document).unwrap();
        let bindings = BTreeMap::new();
        validate_teardown_state(&record, &bindings).unwrap();
        let target = compile::targets(&record.document, &record.generations)
            .unwrap()
            .remove(0);
        record.begin_apply(
            &record.document.clone(),
            [(target.address, target.values)].into(),
        );
        assert_eq!(
            validate_teardown_state(&record, &bindings)
                .unwrap_err()
                .to_string(),
            "unfinished apply may have created resources whose IDs were not saved; apply the original configuration again before destroy"
        );
    }

    #[test]
    fn teardown_can_finish_a_failed_removal_of_a_reconstructible_resource() {
        let document = Document::parse(
            include_bytes!("../../../../../examples/fabric-openclaw.yaml").as_slice(),
        )
        .unwrap();
        let mut record = Record::new(document).unwrap();
        record.begin_apply(&record.document.clone(), BTreeMap::new());
        let bindings = [
            (
                "openshell_workspace.deployment".into(),
                StateBinding {
                    id: "workspace".into(),
                    ..Default::default()
                },
            ),
            (
                "openshell_inference.removed".into(),
                StateBinding {
                    id: "provider".into(),
                    ..Default::default()
                },
            ),
        ]
        .into();
        validate_teardown_state(&record, &bindings).unwrap();
        assert!(
            teardown_expected(&record, &bindings)
                .unwrap()
                .contains_key("openshell_inference.removed")
        );
    }

    /// A state binding that records a compiled target's configuration.
    fn bound(target: &crate::compile::Target) -> StateBinding {
        let value = |attribute: &str| target.values.get(attribute).cloned().unwrap_or_default();
        if plan::disposable(&target.address) {
            return StateBinding {
                id: format!("id-{}", target.address),
                ..Default::default()
            };
        }
        StateBinding {
            id: format!("id-{}", target.address),
            spec: value("spec"),
            name: value("name"),
            owner: value("owner"),
            generation: value("generation"),
            engine: value("engine"),
            compute_driver: value("compute_driver"),
            endpoint: value("endpoint"),
            image: value("image"),
            network_cidr: value("network_cidr"),
            ..Default::default()
        }
    }

    fn runtime_state() -> (Record, BTreeMap<String, StateBinding>) {
        let document =
            Document::parse(include_str!("../../../tests/fixtures/config/spark.yaml").as_bytes())
                .unwrap();
        let mut value = serde_json::to_value(document).unwrap();
        value["spec"]["services"]["qwen"]["authentication"] = json!("bearer");
        let document = Document::parse(value.to_string().as_bytes()).unwrap();
        let record = Record::new(document).unwrap();
        let bindings = compile::runtime_targets(&record.document, &record.generations)
            .unwrap()
            .into_iter()
            .filter(|target| !target.address.starts_with("data."))
            .map(|target| (target.address.clone(), bound(&target)))
            .collect();
        (record, bindings)
    }

    fn service_resource(record: &Record, select: impl Fn(&str) -> bool) -> String {
        compile::runtime_targets(&record.document, &record.generations)
            .unwrap()
            .into_iter()
            .find(|target| select(&target.kind))
            .unwrap()
            .address
    }

    fn service_process(record: &Record) -> String {
        service_resource(record, |kind| {
            crate::services::resource_behavior(kind).runtime_process
        })
    }

    fn service_storage(record: &Record) -> String {
        service_resource(record, |kind| {
            crate::services::resource_behavior(kind).retained_storage
        })
    }

    fn update_service(
        definition: &mut crate::services::ServiceDefinition,
        pointer: &str,
        update: impl FnOnce(&mut serde_json::Value),
    ) {
        let mut value = serde_json::to_value(&*definition).unwrap();
        update(value.pointer_mut(pointer).unwrap());
        *definition = serde_json::from_value(value).unwrap();
    }

    #[test]
    fn multiple_services_retain_each_volume_and_require_its_own_binding() {
        let (mut record, _) = runtime_state();
        let mut provider = record.document.spec.inference_providers["qwen"].clone();
        provider.service_ref = Some("other".into());
        let mut definition = record.document.spec.services["qwen"].clone();
        update_service(&mut definition, "/serving/port", |port| {
            *port = serde_json::json!(port.as_i64().unwrap() + 1);
        });
        record
            .document
            .spec
            .services
            .insert("other".into(), definition);
        record
            .document
            .spec
            .inference_providers
            .insert("other".into(), provider);
        let mut sandbox = record.document.spec.sandboxes["assistant"].clone();
        sandbox.agent.inference.as_mut().unwrap().routes[0].provider_ref = Some("other".into());
        record
            .document
            .spec
            .sandboxes
            .insert("other".into(), sandbox);
        let bindings: BTreeMap<_, _> =
            compile::runtime_targets(&record.document, &record.generations)
                .unwrap()
                .into_iter()
                .filter(|target| !target.address.starts_with("data."))
                .map(|target| (target.address.clone(), bound(&target)))
                .collect();
        teardown_expected(&record, &bindings).unwrap();
        let storage_kind = service_storage(&record)
            .split_once('.')
            .unwrap()
            .0
            .to_owned();
        let process_kind = service_process(&record)
            .split_once('.')
            .unwrap()
            .0
            .to_owned();
        let compiled = compile::compile_teardown(
            &record.document,
            &record.generations,
            "0.1.0",
            &bindings.keys().cloned().collect(),
        )
        .unwrap();
        let graph = compiled.graph;
        let retained = compiled.retained;
        assert_eq!(retained.len(), 5);
        assert_eq!(
            graph["resource"][&storage_kind].as_object().unwrap().len(),
            2
        );
        assert!(graph["resource"].get(&process_kind).is_none());
        for address in retained
            .into_iter()
            .filter(|address| !address.starts_with("docker_volume."))
        {
            let mut missing = bindings.clone();
            missing.remove(&address);
            assert!(teardown_expected(&record, &missing).is_err(), "{address}");
        }
    }

    #[test]
    fn teardown_requires_independent_storage_for_each_bound_process() {
        let (record, bindings) = runtime_state();
        let retained_storage = service_storage(&record);
        for missing in [GATEWAY_STORAGE, retained_storage.as_str()] {
            let mut incomplete = bindings.clone();
            incomplete.remove(missing);
            assert!(
                teardown_expected(&record, &incomplete).is_err(),
                "{missing}"
            );
        }
        let sandbox = compile::targets(&record.document, &record.generations)
            .unwrap()
            .into_iter()
            .find(|target| target.kind == "sandbox")
            .unwrap();
        let objects = BTreeMap::from([(
            sandbox.address,
            StateBinding {
                id: "sandbox".into(),
                ..Default::default()
            },
        )]);
        assert!(
            teardown_expected(&record, &objects).is_err(),
            "bound objects require the retained workspace"
        );
    }

    #[test]
    fn teardown_preserves_bound_process_specs_and_retains_only_storage_in_the_graph() {
        let (mut record, bindings) = runtime_state();
        update_service(
            record.document.spec.services.get_mut("qwen").unwrap(),
            "/image",
            |image| *image = serde_json::json!(format!("local@sha256:{}", "a".repeat(64))),
        );
        let expected = teardown_expected(&record, &bindings).unwrap();
        let process = service_process(&record);
        let retained_storage = service_storage(&record);
        assert!(bindings[&process].spec.is_empty());
        assert!(!expected[&process]["spec"].is_empty());
        let compiled = compile::compile_teardown(
            &record.document,
            &record.generations,
            "0.1.0",
            &bindings.keys().cloned().collect(),
        )
        .unwrap();
        let graph = compiled.graph;
        assert!(graph.get("data").is_none());
        assert_eq!(graph["provider"]["openshell"]["destroy"], true);
        assert_eq!(graph["resource"].as_object().unwrap().len(), 3);
        for address in [GATEWAY_STORAGE, retained_storage.as_str()] {
            let (kind, name) = address.split_once('.').unwrap();
            let attributes = graph["resource"][kind][name]
                .as_object()
                .unwrap()
                .iter()
                .filter_map(|(key, value)| Some((key.clone(), value.as_str()?.to_owned())))
                .collect();
            assert!(!bindings[address].differs(&attributes), "{address}");
            assert_eq!(
                graph["resource"][kind][name]["lifecycle"]["prevent_destroy"],
                true
            );
        }
    }

    #[test]
    fn teardown_rejects_undeclared_bindings_and_changed_storage_or_process_ownership() {
        let (record, bindings) = runtime_state();
        let mut undeclared = bindings.clone();
        undeclared.insert("foreign.resource".into(), StateBinding::default());
        assert!(teardown_expected(&record, &undeclared).is_err());
        let mut changed_storage = bindings.clone();
        let retained_storage = service_storage(&record);
        changed_storage
            .get_mut(&retained_storage)
            .unwrap()
            .generation = "c".repeat(32);
        assert!(teardown_expected(&record, &changed_storage).is_err());
        let mut changed_compute = bindings;
        changed_compute
            .get_mut(&service_process(&record))
            .unwrap()
            .id = "replacement-provider-id".into();
        assert!(teardown_expected(&record, &changed_compute).is_ok());
    }
}
