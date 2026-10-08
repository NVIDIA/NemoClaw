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
    for sandbox in &mut environment.spec.sandboxes {
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
    pub(in crate::deployment) async fn teardown_stages(
        &self,
        cancel: &CancellationToken,
        preview: bool,
    ) -> Result<OperationResult, Error> {
        let (bundle, store) = self.open()?;
        let mut record = store.load()?.ok_or(Error::Conflict(
            "destroy requires existing deployment state",
        ))?;
        let bindings = self
            .state_bindings(
                &bundle,
                &store,
                &record.document,
                &record.generations,
                false,
                cancel,
            )
            .await?;
        let runtime = if record.document.has_runtime() {
            Some(Store::open(&store.directory.join("runtime"))?)
        } else {
            None
        };
        if let Some(stage) = &runtime {
            self.recover_helm_binding(&bundle, stage, &record, preview, cancel)
                .await?;
        }
        let runtime_bindings = if let Some(stage) = &runtime {
            self.state_bindings(
                &bundle,
                stage,
                &record.document,
                &record.generations,
                true,
                cancel,
            )
            .await?
        } else {
            BTreeMap::new()
        };
        record.reconcile_pending_creations(&bindings);
        validate_teardown_state(&record, &bindings, &runtime_bindings)?;
        let root_graph = compile::compile_teardown(
            &record.document,
            &record.generations,
            &bundle.manifest.version,
            &bindings.keys().cloned().collect(),
            false,
        )?;
        let runtime_graph = runtime
            .as_ref()
            .map(|_| {
                compile::compile_teardown(
                    &record.document,
                    &record.generations,
                    &bundle.manifest.version,
                    &runtime_bindings.keys().cloned().collect(),
                    true,
                )
            })
            .transpose()?;
        let mut result = OperationResult::planned(Vec::new());
        result.describe_sources(&record.document)?;
        result.retained.extend(root_graph.retained.iter().cloned());
        if let Some(graph) = &runtime_graph {
            result.retained.extend(graph.retained.iter().cloned());
        }
        if record.destroyed() {
            if !preview {
                result.outcome = Outcome::Destroyed;
            }
            return Ok(result);
        }
        // Observe and validate both complete saved plans before the first delete.
        let (operation, _connection) = if !record.root_destroyed() && !bindings.is_empty() {
            self.connected(&record.document, &record.generations, cancel)
                .await?
        } else {
            (self.clone(), None)
        };
        let mut stages = Vec::new();
        if !record.root_destroyed() {
            let (changes, planned) = operation
                .plan_teardown_stage(&bundle, &store, &record, false, &root_graph, cancel)
                .await?;
            result.changes.extend(changes);
            stages.push((&store, false, planned));
        }
        if let Some((stage, graph)) = runtime.as_ref().zip(runtime_graph.as_ref()) {
            let (changes, planned) = operation
                .plan_teardown_stage(&bundle, stage, &record, true, graph, cancel)
                .await?;
            result.changes.extend(changes);
            stages.push((stage, true, planned));
        }
        if preview {
            return Ok(result);
        }
        // Both teardown graphs now account for every saved identity, so destroy
        // owns recovery from this point and can resume at its recorded boundary.
        record.begin_destroy();
        store.save(&record)?;
        (self.progress)(Progress::Destroying);
        for (stage, is_runtime, planned) in stages {
            if planned {
                if is_runtime {
                    operation
                        .checkpoint_helm_binding(&bundle, stage, &record, cancel)
                        .await?;
                }
                let applied = operation
                    .tofu(
                        &bundle,
                        stage,
                        &destroy_environment(&record.document),
                        &["apply", "-input=false", "-no-color", "destroy.plan"],
                        cancel,
                    )
                    .await;
                // Cancellation keeps the durable checkpoint for the next
                // destroy. Otherwise repair lost state before returning the
                // original error, without retrying any remote mutation.
                if is_runtime {
                    if cancel.is_cancelled() {
                        return Err(Error::Cancelled);
                    }
                    let restored = operation
                        .recover_helm_binding(&bundle, stage, &record, false, cancel)
                        .await?;
                    if restored && applied.is_ok() {
                        return Err(Error::Conflict(
                            "Helm release deletion was not confirmed; its binding was restored, rerun destroy",
                        ));
                    }
                }
                applied?;
            }
            if !is_runtime {
                record.finish_root_destroy();
                store.save(&record)?;
            }
        }
        record.finish_destroy();
        store.save(&record)?;
        result.outcome = Outcome::Destroyed;
        Ok(result)
    }
    async fn plan_teardown_stage(
        &self,
        bundle: &Bundle,
        store: &Store,
        record: &Record,
        runtime: bool,
        compiled: &compile::CompiledTeardown,
        cancel: &CancellationToken,
    ) -> Result<(Vec<Change>, bool), Error> {
        let bindings = self
            .state_bindings(
                bundle,
                store,
                &record.document,
                &record.generations,
                runtime,
                cancel,
            )
            .await?;
        if bindings.is_empty() {
            if record.succeeded() || record.destroying() {
                return Err(Error::Conflict(
                    "established state is missing; destroy cannot infer unbound resources",
                ));
            }
            return Ok((Vec::new(), false));
        }
        let expected = with_observations(
            &teardown_expected(record, &bindings, runtime)?,
            &compiled.observations,
        );
        self.prepare(bundle, store, &compiled.graph)?;
        self.tofu(
            bundle,
            store,
            &destroy_environment(&record.document),
            &["init", "-upgrade", "-input=false", "-no-color"],
            cancel,
        )
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
            check_destroy_plan(&plan, &expected, &bindings, &compiled.retained)?,
            true,
        ))
    }
}

fn teardown_expected(
    record: &Record,
    bindings: &BTreeMap<String, StateBinding>,
    runtime: bool,
) -> Result<BTreeMap<String, Row>, Error> {
    let mut targets = if runtime {
        compile::runtime_targets(&record.document, &record.generations)?
    } else {
        compile::targets(&record.document, &record.generations)?
    };
    if runtime {
        bind_teardown_processes(record, &mut targets, bindings)?;
    } else if !bindings.contains_key("openshell_workspace.deployment") {
        return Err(Error::Conflict(
            "destroy requires the retained workspace binding",
        ));
    }
    let mut expected = allowed(&targets);
    for (address, binding) in bindings {
        if plan::disposable(address) || plan::reconstructible(address) {
            expected.entry(address.clone()).or_default();
            continue;
        }
        let want = expected.get(address).ok_or(Error::Conflict(
            "destroy encountered an undeclared resource binding",
        ))?;
        if runtime
            && address != crate::kubernetes::gateway::ADDRESS
            && !plan::disposable(address)
            && binding.differs(want)
        {
            return Err(Error::Conflict(
                "destroy storage configuration disagrees with retained intent",
            ));
        }
        if !runtime && !binding.spec.is_empty() {
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
                && binding.spec != target.values["spec"]
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
        let want: Spec = serde_json::from_str(&target.values["spec"])
            .map_err(|_| Error::State("invalid runtime intent"))?;
        if plan::disposable(&target.address) {
            continue;
        }
        target.values.insert(
            "spec".into(),
            bound_spec(&want, bindings.get(&target.address))?.json()?,
        );
    }
    Ok(())
}

fn validate_teardown_state(
    record: &Record,
    bindings: &BTreeMap<String, StateBinding>,
    runtime_bindings: &BTreeMap<String, StateBinding>,
) -> Result<(), Error> {
    if record.pending() {
        let applicable_state_is_safe = record.runtime_pending()
            && record.document.has_runtime()
            && runtime_bindings_safe(record, runtime_bindings)?;
        if !applicable_state_is_safe {
            return Err(Error::Conflict(
                "unfinished apply may have created resources whose IDs were not saved; apply the original configuration again before destroy",
            ));
        }
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

fn runtime_bindings_safe(
    record: &Record,
    bindings: &BTreeMap<String, StateBinding>,
) -> Result<bool, Error> {
    if bindings.is_empty() {
        return Ok(false);
    }
    teardown_expected(record, bindings, true)?;
    Ok(true)
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
        assert!(document.spec.sandboxes[0].image.metadata.is_some());
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
        let mut record = Record::new(document).unwrap();
        record.begin_runtime_apply(&record.document.clone());
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
            false,
        )
        .unwrap();
        let (changes, planned) = deployment
            .plan_teardown_stage(
                &bundle,
                &store,
                &record,
                false,
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
        teardown_expected(&record, &bindings, true).unwrap();
        let compiled = compile::compile_teardown(
            &record.document,
            &record.generations,
            "0.1.0",
            &bindings.keys().cloned().collect(),
            true,
        )
        .unwrap();
        assert_eq!(
            compiled.retained,
            BTreeSet::from([KUBERNETES_STORAGE.into()])
        );
        let graph = compiled.graph;
        assert_eq!(graph["provider"]["nemoclaw"], json!({"destroy": true}));
        assert!(graph["provider"].get("openshell").is_none());
        assert!(graph["provider"].get("fabric").is_none());
        assert_eq!(graph["resource"].as_object().unwrap().len(), 1);
        assert_eq!(
            graph["resource"]["nemoclaw_kubernetes_storage"]["runtime"]["lifecycle"]["prevent_destroy"],
            true
        );
        assert!(graph.get("data").is_none());
        let mut invalid = bindings;
        invalid.remove(KUBERNETES_STORAGE);
        assert!(teardown_expected(&record, &invalid, true).is_err());
    }

    #[test]
    fn unfinished_apply_without_complete_runtime_state_explains_how_to_recover() {
        let document = Document::parse(
            include_bytes!("../../../../../examples/fabric-openclaw.yaml").as_slice(),
        )
        .unwrap();
        let mut record = Record::new(document).unwrap();
        let bindings = BTreeMap::new();
        validate_teardown_state(&record, &bindings, &bindings).unwrap();
        let target = compile::targets(&record.document, &record.generations)
            .unwrap()
            .remove(0);
        record.begin_apply(
            &record.document.clone(),
            [(target.address, target.values)].into(),
        );
        assert_eq!(
            validate_teardown_state(&record, &bindings, &bindings)
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
                "openshell_provider_registration.removed".into(),
                StateBinding {
                    id: "provider".into(),
                    ..Default::default()
                },
            ),
        ]
        .into();
        validate_teardown_state(&record, &bindings, &BTreeMap::new()).unwrap();
        assert!(
            teardown_expected(&record, &bindings, false)
                .unwrap()
                .contains_key("openshell_provider_registration.removed")
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

    #[test]
    fn runtime_recovery_uses_current_bindings_without_the_failed_apply_plan() {
        let (mut record, runtime_bindings) = runtime_state();
        record.begin_runtime_apply(&record.document.clone());
        // A preview can replace apply.plan after a failed apply. Current resource
        // bindings and a fresh teardown plan must determine the next operation.
        validate_teardown_state(&record, &BTreeMap::new(), &runtime_bindings)
            .expect("an obsolete or missing apply plan cannot veto bound-resource recovery");
    }

    #[test]
    fn unfinished_runtime_apply_can_destroy_only_its_safe_saved_bindings() {
        let (mut record, runtime_bindings) = runtime_state();
        record.begin_runtime_apply(&record.document.clone());
        let bindings = BTreeMap::new();
        validate_teardown_state(&record, &bindings, &runtime_bindings).unwrap();

        assert!(
            validate_teardown_state(&record, &bindings, &BTreeMap::new()).is_err(),
            "an empty state cannot prove that a successful mutation was recorded"
        );

        let storage = service_storage(&record);
        let partial = BTreeMap::from([(
            storage.clone(),
            runtime_bindings.get(&storage).unwrap().clone(),
        )]);
        validate_teardown_state(&record, &bindings, &partial)
            .expect("a recorded retained volume is a safe partial runtime state");

        let process = service_process(&record);
        let missing_storage = BTreeMap::from([(
            process.clone(),
            runtime_bindings.get(&process).unwrap().clone(),
        )]);
        assert!(
            validate_teardown_state(&record, &bindings, &missing_storage).is_err(),
            "a process cannot be removed without its independent storage binding"
        );

        let mut root_bindings = bindings;
        root_bindings.insert(
            "openshell_workspace.deployment".into(),
            StateBinding {
                id: "possibly-partial-root-resource".into(),
                ..Default::default()
            },
        );
        validate_teardown_state(&record, &root_bindings, &runtime_bindings)
            .expect("root bindings predate a pending runtime-stage apply");
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
        let mut provider = record.document.spec.inference_providers[0].clone();
        provider.name = "other".into();
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
        record.document.spec.inference_providers.push(provider);
        let mut sandbox = record.document.spec.sandboxes[0].clone();
        sandbox.name = "other".into();
        sandbox.agent.inference.as_mut().unwrap().routes[0].provider_ref = Some("other".into());
        record.document.spec.sandboxes.push(sandbox);
        let bindings: BTreeMap<_, _> =
            compile::runtime_targets(&record.document, &record.generations)
                .unwrap()
                .into_iter()
                .filter(|target| !target.address.starts_with("data."))
                .map(|target| (target.address.clone(), bound(&target)))
                .collect();
        teardown_expected(&record, &bindings, true).unwrap();
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
            true,
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
            assert!(
                teardown_expected(&record, &missing, true).is_err(),
                "{address}"
            );
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
                teardown_expected(&record, &incomplete, true).is_err(),
                "{missing}"
            );
        }
        assert!(teardown_expected(&record, &BTreeMap::new(), false).is_err());
    }

    #[test]
    fn teardown_preserves_bound_process_specs_and_retains_only_storage_in_the_graph() {
        let (mut record, bindings) = runtime_state();
        update_service(
            record.document.spec.services.get_mut("qwen").unwrap(),
            "/image",
            |image| *image = serde_json::json!(format!("local@sha256:{}", "a".repeat(64))),
        );
        let expected = teardown_expected(&record, &bindings, true).unwrap();
        let process = service_process(&record);
        let retained_storage = service_storage(&record);
        assert!(bindings[&process].spec.is_empty());
        assert!(!expected[&process]["spec"].is_empty());
        let compiled = compile::compile_teardown(
            &record.document,
            &record.generations,
            "0.1.0",
            &bindings.keys().cloned().collect(),
            true,
        )
        .unwrap();
        let graph = compiled.graph;
        assert!(graph.get("data").is_none());
        assert_eq!(graph["provider"]["nemoclaw"]["destroy"], true);
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
        assert!(teardown_expected(&record, &undeclared, true).is_err());
        let mut changed_storage = bindings.clone();
        let retained_storage = service_storage(&record);
        changed_storage
            .get_mut(&retained_storage)
            .unwrap()
            .generation = "c".repeat(32);
        assert!(teardown_expected(&record, &changed_storage, true).is_err());
        let mut changed_compute = bindings;
        changed_compute
            .get_mut(&service_process(&record))
            .unwrap()
            .id = "replacement-provider-id".into();
        assert!(teardown_expected(&record, &changed_compute, true).is_ok());
    }
}
