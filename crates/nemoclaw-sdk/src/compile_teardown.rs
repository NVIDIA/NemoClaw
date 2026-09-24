// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::*;
use std::collections::BTreeSet;

/// Teardown configuration and the established resources it keeps tracked.
pub struct CompiledTeardown {
    pub graph: Value,
    pub retained: BTreeSet<String>,
}

/// Compile removal of workloads while keeping established storage tracked.
///
/// `established` contains resource addresses from the selected stage's saved
/// OpenTofu state. The caller must verify that bindings belong to this deployment
/// and agree with its retained intent before applying the graph. Missing retained
/// resources are omitted so teardown cannot create storage after partial apply.
pub fn compile_teardown(
    document: &Document,
    generations: &Generations,
    version: &str,
    established: &BTreeSet<String>,
    runtime: bool,
) -> Result<CompiledTeardown, crate::Error> {
    let mut graph = if runtime {
        compile_runtime(document, generations, version)?
    } else {
        compile(document, generations, version)?
    };
    let mut retained: BTreeSet<String> = crate::services::remove_plans(document, generations)?
        .into_iter()
        .flat_map(|plan| plan.retained)
        .collect();
    retained.insert(if runtime {
        "nemoclaw_gateway_storage.runtime".into()
    } else {
        "nemoclaw_workspace.deployment".into()
    });
    retained.retain(|address| {
        established.contains(address)
            && address.split_once('.').is_some_and(|(kind, name)| {
                graph["resource"]
                    .get(kind)
                    .and_then(|instances| instances.get(name))
                    .is_some()
            })
    });

    // Reuse the compiler's literal escaping and provider aliases. Teardown has
    // no workload readiness prerequisites and must not create absent storage.
    graph
        .as_object_mut()
        .expect("compiled graph")
        .remove("data");
    graph
        .as_object_mut()
        .expect("compiled graph")
        .remove("output");
    graph["provider"]["nemoclaw"]["destroy"] = json!(true);
    let resources = graph["resource"]
        .as_object_mut()
        .expect("compiled resources");
    for (kind, instances) in resources.iter_mut() {
        let instances = instances.as_object_mut().expect("compiled instances");
        instances.retain(|name, _| retained.contains(&format!("{kind}.{name}")));
        for attrs in instances.values_mut() {
            attrs["lifecycle"] = json!({"prevent_destroy":true});
            if let Some(dependencies) = attrs.get_mut("depends_on").and_then(Value::as_array_mut) {
                dependencies.retain(|dependency| {
                    dependency
                        .as_str()
                        .is_some_and(|address| retained.contains(address))
                });
            }
        }
    }
    resources.retain(|_, instances| {
        !instances
            .as_object()
            .expect("compiled instances")
            .is_empty()
    });
    Ok(CompiledTeardown { graph, retained })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (Document, Generations) {
        let document =
            Document::parse(include_bytes!("../tests/fixtures/config/spark.yaml").as_slice())
                .unwrap();
        let mut value = serde_json::to_value(document).unwrap();
        value["spec"]["services"]["qwen"]["authentication"] = json!("bearer");
        value["spec"]["gateway"]["engine"] = json!("unix:///tmp/${engine}%{literal}.sock");
        let document = Document::parse(value.to_string().as_bytes()).unwrap();
        let generations = [
            "workspace",
            "provider",
            "sandbox",
            "managed_gateway",
            "inference_service",
        ]
        .map(|kind| (kind.into(), "a".repeat(32)))
        .into();
        (document, generations)
    }

    fn addresses(graph: &Value) -> BTreeSet<String> {
        graph["resource"]
            .as_object()
            .unwrap()
            .iter()
            .flat_map(|(kind, resources)| {
                resources
                    .as_object()
                    .unwrap()
                    .keys()
                    .map(move |name| format!("{kind}.{name}"))
            })
            .collect()
    }

    #[test]
    fn teardown_compiles_only_established_storage_without_readiness_or_dangling_dependencies() {
        let (document, generations) = fixture();
        let full = compile_runtime(&document, &generations, "0.1.0").unwrap();
        let retained: BTreeSet<String> = addresses(&full)
            .into_iter()
            .filter(|address| {
                address.starts_with("docker_volume.")
                    || address.starts_with("nemoclaw_inference_storage.")
                    || address == "nemoclaw_gateway_storage.runtime"
            })
            .collect();
        assert_eq!(
            retained.len(),
            3,
            "fixture has cache, credentials, and gateway storage"
        );
        for established in [
            BTreeSet::new(),
            BTreeSet::from(["nemoclaw_gateway_storage.runtime".into()]),
            retained.clone(),
        ] {
            let compiled =
                compile_teardown(&document, &generations, "0.1.0", &established, true).unwrap();
            assert_eq!(compiled.retained, established);
            let graph = compiled.graph;
            assert_eq!(
                addresses(&graph),
                established,
                "partial teardown must never create unfinished storage"
            );
            assert!(graph.get("data").is_none());
            assert!(
                graph.get("output").is_none(),
                "teardown must not retain discovery references"
            );
            assert_eq!(graph["provider"]["nemoclaw"]["destroy"], true);
            assert_eq!(graph["provider"]["docker"], full["provider"]["docker"]);
            for address in &established {
                let (kind, name) = address.split_once('.').unwrap();
                let attrs = &graph["resource"][kind][name];
                assert_eq!(attrs["lifecycle"], json!({"prevent_destroy":true}));
                if let Some(dependencies) = attrs["depends_on"].as_array() {
                    assert!(
                        dependencies
                            .iter()
                            .all(|dependency| established.contains(dependency.as_str().unwrap()))
                    );
                }
                assert_eq!(attrs["provider"], full["resource"][kind][name]["provider"]);
            }
            if established.contains("nemoclaw_gateway_storage.runtime") {
                let spec = graph["resource"]["nemoclaw_gateway_storage"]["runtime"]["spec"]
                    .as_str()
                    .unwrap();
                assert!(
                    spec.contains("$${engine}%%{literal}"),
                    "literal templates must survive OpenTofu evaluation"
                );
            }
        }
    }

    #[test]
    fn reported_retention_matches_the_selected_stage_graph() {
        let (document, generations) = fixture();
        let established: BTreeSet<_> =
            addresses(&compile(&document, &generations, "0.1.0").unwrap())
                .union(&addresses(
                    &compile_runtime(&document, &generations, "0.1.0").unwrap(),
                ))
                .cloned()
                .collect();
        for runtime in [false, true] {
            let compiled =
                compile_teardown(&document, &generations, "0.1.0", &established, runtime).unwrap();
            assert_eq!(compiled.retained, addresses(&compiled.graph));
            assert_eq!(compiled.retained.len(), if runtime { 3 } else { 1 });
            let repeated = compile_teardown(
                &document,
                &generations,
                "0.1.0",
                &compiled.retained,
                runtime,
            )
            .unwrap();
            assert_eq!(repeated.retained, compiled.retained);
            assert_eq!(repeated.graph, compiled.graph);
        }
    }

    #[test]
    fn teardown_retains_workspace_only_when_established() {
        let (document, generations) = fixture();
        for established in [
            BTreeSet::new(),
            BTreeSet::from([
                "nemoclaw_workspace.deployment".into(),
                "nemoclaw_sandbox.assistant".into(),
            ]),
        ] {
            let compiled =
                compile_teardown(&document, &generations, "0.1.0", &established, false).unwrap();
            let graph = compiled.graph;
            let expected = established
                .into_iter()
                .filter(|address| address == "nemoclaw_workspace.deployment")
                .collect();
            assert_eq!(addresses(&graph), expected);
            assert_eq!(compiled.retained, expected);
            assert!(graph.get("data").is_none());
        }
    }
}
