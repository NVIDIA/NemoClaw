// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::*;

// Teardown uses gateway authentication but never invokes inference. Keep the
// retained document and resource graph intact; narrow only subprocess secrets.
fn destroy_environment(document: &Document) -> Document {
    let mut environment = document.clone();
    for provider in &mut environment.spec.inference_providers {
        provider.credential = None;
    }
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
        let bindings = store.bindings()?;
        validate_teardown_state(&record, &bindings)?;
        let runtime = if record.document.has_runtime() {
            Some(Store::open(&store.directory.join("runtime"))?)
        } else {
            None
        };
        let mut result = OperationResult::planned(Vec::new());
        result.retained.extend(retained_bindings(&bindings, false));
        if let Some(stage) = &runtime {
            result
                .retained
                .extend(retained_bindings(&stage.bindings()?, true));
        }
        if record.destroyed {
            if !preview {
                result.outcome = Outcome::Destroyed;
            }
            return Ok(result);
        }
        // Observe and validate both complete saved plans before the first delete.
        let mut stages = Vec::new();
        if !record.destroy_runtime {
            let (changes, planned) = self
                .plan_teardown_stage(&bundle, &store, &record, false, cancel)
                .await?;
            result.changes.extend(changes);
            stages.push((&store, false, planned));
        }
        if let Some(stage) = &runtime {
            let (changes, planned) = self
                .plan_teardown_stage(&bundle, stage, &record, true, cancel)
                .await?;
            result.changes.extend(changes);
            stages.push((stage, true, planned));
        }
        if preview {
            return Ok(result);
        }
        record.destroying = true;
        record.succeeded = false;
        store.save(&record)?;
        (self.progress)(Progress::Destroying);
        for (stage, is_runtime, planned) in stages {
            if planned {
                self.tofu(
                    &bundle,
                    stage,
                    &destroy_environment(&record.document),
                    &[
                        "apply",
                        "-input=false",
                        "-no-color",
                        "-parallelism=1",
                        "destroy.plan",
                    ],
                    cancel,
                )
                .await?;
            }
            if !is_runtime {
                record.destroy_runtime = true;
                store.save(&record)?;
            }
        }
        record.destroying = false;
        record.destroyed = true;
        record.plan_digest.clear();
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
        cancel: &CancellationToken,
    ) -> Result<(Vec<Change>, bool), Error> {
        let bindings = store.bindings()?;
        if bindings.is_empty() {
            if record.succeeded || record.destroying {
                return Err(Error::Conflict(
                    "established state is missing; destroy cannot infer unbound resources",
                ));
            }
            return Ok((Vec::new(), false));
        }
        let expected = teardown_expected(record, &bindings, runtime)?;
        let retained = retained_addresses(runtime);
        let graph = teardown_graph(
            record,
            &bundle.manifest.version,
            &expected,
            &bindings,
            &retained,
        )?;
        self.prepare(bundle, store, &graph)?;
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
            check_destroy_plan(&plan, &expected, &bindings, &retained)?,
            true,
        ))
    }
}

fn retained_addresses(runtime: bool) -> BTreeSet<String> {
    if runtime {
        [GATEWAY_STORAGE.into(), MODEL_STORAGE.into()].into()
    } else {
        [
            "nemoclaw_workspace.deployment".into(),
            crate::deployment::ollama::STORAGE.into(),
        ]
        .into()
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
        bind_teardown_processes(&mut targets, bindings)?;
    } else if !bindings.contains_key("nemoclaw_workspace.deployment") {
        return Err(Error::Conflict(
            "destroy requires the retained workspace binding",
        ));
    }
    let mut expected = allowed(&targets);
    if !runtime {
        crate::deployment::ollama::extend_allowed(
            &record.document,
            &record.generations,
            &mut expected,
        )?;
    }
    for (address, binding) in bindings {
        let want = expected.get(address).ok_or(Error::Conflict(
            "destroy encountered an undeclared resource binding",
        ))?;
        if runtime && want["spec"] != binding.spec {
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
    targets: &mut [Target],
    bindings: &BTreeMap<String, StateBinding>,
) -> Result<(), Error> {
    for target in targets {
        let storage = match target.kind.as_str() {
            GATEWAY_KIND => GATEWAY_STORAGE,
            SERVICE_KIND => MODEL_STORAGE,
            _ => continue,
        };
        if bindings.contains_key(&target.address) && !bindings.contains_key(storage) {
            return Err(Error::Conflict(
                "destroy requires independent storage bindings before removing a managed process",
            ));
        }
        let want: Spec = serde_json::from_str(&target.values["spec"])
            .map_err(|_| Error::State("invalid runtime intent"))?;
        target.values.insert(
            "spec".into(),
            bound_spec(&want, bindings.get(&target.address))?.json()?,
        );
    }
    Ok(())
}

fn teardown_graph(
    record: &Record,
    version: &str,
    expected: &BTreeMap<String, Row>,
    bindings: &BTreeMap<String, StateBinding>,
    retained: &BTreeSet<String>,
) -> Result<Value, Error> {
    let mut graph = compile::compile(&record.document, &record.generations, version)?;
    graph["provider"]["nemoclaw"]["destroy"] = json!(true);
    let resources = graph["resource"].take();
    graph["resource"] = json!({});
    for address in retained {
        if bindings.contains_key(address) {
            let (kind, name) = address
                .split_once('.')
                .ok_or(Error::State("invalid resource address"))?;
            let retained_values = if address == crate::deployment::ollama::STORAGE {
                resources["nemoclaw_ollama_storage"]["models"].clone()
            } else {
                serde_json::to_value(&expected[address])
                    .map_err(|_| Error::State("cannot encode retained resource"))?
            };
            let mut attrs = retained_values;
            attrs["lifecycle"] = json!({"prevent_destroy":true});
            graph["resource"][kind][name] = attrs;
        }
    }
    Ok(graph)
}

fn validate_teardown_state(
    record: &Record,
    bindings: &BTreeMap<String, StateBinding>,
) -> Result<(), Error> {
    if record.pending {
        return Err(Error::Conflict(
            "unfinished apply may have unbound effects; reconcile its original configuration before destroy",
        ));
    }
    if record.document.spec.inference_providers[0].ollama.is_some()
        && bindings.contains_key("nemoclaw_ollama.service")
        && !bindings.contains_key(crate::deployment::ollama::STORAGE)
    {
        return Err(Error::Conflict(
            "apply once to establish independent Ollama storage binding before destroy",
        ));
    }
    Ok(())
}

fn retained_bindings(bindings: &BTreeMap<String, StateBinding>, runtime: bool) -> Vec<String> {
    let addresses = if runtime {
        [GATEWAY_STORAGE, MODEL_STORAGE]
    } else {
        [
            "nemoclaw_workspace.deployment",
            crate::deployment::ollama::STORAGE,
        ]
    };
    addresses
        .into_iter()
        .filter(|address| bindings.contains_key(*address))
        .map(str::to_owned)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn runtime_state() -> (Record, BTreeMap<String, StateBinding>) {
        let document =
            Document::parse(include_str!("../../../tests/fixtures/config/spark.yaml").as_bytes())
                .unwrap();
        let record = Record::new(document).unwrap();
        let bindings = compile::runtime_targets(&record.document, &record.generations)
            .unwrap()
            .into_iter()
            .map(|target| {
                (
                    target.address.clone(),
                    StateBinding {
                        id: format!("id-{}", target.address),
                        spec: target.values["spec"].clone(),
                    },
                )
            })
            .collect();
        (record, bindings)
    }

    #[test]
    fn teardown_requires_independent_storage_for_each_bound_process() {
        let (record, bindings) = runtime_state();
        for missing in [GATEWAY_STORAGE, MODEL_STORAGE] {
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
        record.document.spec.inference_providers[0]
            .service
            .as_mut()
            .unwrap()
            .image = format!("local@sha256:{}", "a".repeat(64));
        let expected = teardown_expected(&record, &bindings, true).unwrap();
        let process = "nemoclaw_inference_service.runtime";
        assert_eq!(expected[process]["spec"], bindings[process].spec);
        let retained = retained_addresses(true);
        let graph = teardown_graph(&record, "0.1.0", &expected, &bindings, &retained).unwrap();
        assert_eq!(graph["provider"]["nemoclaw"]["destroy"], true);
        assert_eq!(graph["resource"].as_object().unwrap().len(), 2);
        for address in [GATEWAY_STORAGE, MODEL_STORAGE] {
            let (kind, name) = address.split_once('.').unwrap();
            assert_eq!(
                graph["resource"][kind][name]["spec"],
                bindings[address].spec
            );
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
        changed_storage.get_mut(MODEL_STORAGE).unwrap().spec = "{}".into();
        assert!(teardown_expected(&record, &changed_storage, true).is_err());
        let mut changed_owner = bindings.clone();
        let binding = changed_owner
            .get_mut("nemoclaw_inference_service.runtime")
            .unwrap();
        let mut spec: Spec = serde_json::from_str(&binding.spec).unwrap();
        spec.generation = "a".repeat(32);
        binding.spec = spec.json().unwrap();
        assert!(teardown_expected(&record, &changed_owner, true).is_err());
    }
}
