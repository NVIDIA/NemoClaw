// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::*;
use std::collections::BTreeSet;

/// Teardown configuration and the established resources it keeps tracked.
pub struct CompiledTeardown {
    pub graph: Value,
    pub retained: BTreeSet<String>,
    /// Observations the applied graph read; a destroy plan may only discard these.
    pub observations: BTreeSet<String>,
}

/// Compile removal of workloads while keeping established storage tracked.
///
/// `established` contains resource addresses from the deployment's saved
/// OpenTofu state. The caller must verify that bindings belong to this deployment
/// and agree with its retained intent before applying the graph. Missing retained
/// resources are omitted so teardown cannot create storage after partial apply.
pub fn compile_teardown(
    document: &Document,
    generations: &Generations,
    version: &str,
    established: &BTreeSet<String>,
) -> Result<CompiledTeardown, crate::Error> {
    let mut graph = compile(document, generations, version)?;
    let mut retained: BTreeSet<String> = crate::services::remove_plans(document, generations)?
        .into_iter()
        .flat_map(|plan| plan.retained)
        .collect();
    // Only data survives teardown. The workspace lives in the gateway, which
    // teardown removes, so it's destroyed with the deployment's other objects.
    retained.extend([
        "openshell_kubernetes_storage.runtime".into(),
        "openshell_gateway_storage.runtime".into(),
    ]);
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
    let observations = observations(&graph);
    graph
        .as_object_mut()
        .expect("compiled graph")
        .remove("data");
    graph
        .as_object_mut()
        .expect("compiled graph")
        .remove("output");
    // Explicit teardown is the only graph that permits deletion. Docker and
    // Helm configurations are left as compiled.
    for name in crate::compile::NEMOCLAW_PROVIDERS {
        if graph["provider"].get(name).is_some() {
            graph["provider"][name]["destroy"] = json!(true);
        }
    }
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
    if resources.is_empty() {
        // An image-only failure has no retained storage. OpenTofu JSON syntax
        // requires omitting resource blocks rather than emitting an empty one.
        graph
            .as_object_mut()
            .expect("compiled graph")
            .remove("resource");
    }
    Ok(CompiledTeardown {
        graph,
        retained,
        observations,
    })
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
        let Some(resources) = graph.get("resource").and_then(Value::as_object) else {
            return BTreeSet::new();
        };
        resources
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
                    || address.starts_with("vllm_credential_storage.")
                    || address == "openshell_gateway_storage.runtime"
            })
            .collect();
        assert_eq!(
            retained.len(),
            3,
            "fixture has cache, credentials, and gateway storage"
        );
        for established in [
            BTreeSet::new(),
            BTreeSet::from(["openshell_gateway_storage.runtime".into()]),
            retained.clone(),
        ] {
            let compiled =
                compile_teardown(&document, &generations, "0.1.0", &established).unwrap();
            assert_eq!(compiled.retained, established);
            let graph = compiled.graph;
            if established.is_empty() {
                assert!(
                    graph.get("resource").is_none(),
                    "OpenTofu rejects an empty resource block after image-only failure"
                );
            }
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
            for provider in ["openshell", "fabric"] {
                assert_eq!(graph["provider"][provider]["destroy"], true, "{provider}");
            }
            assert!(graph["provider"].get("nemoclaw").is_none());
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
            if established.contains("openshell_gateway_storage.runtime") {
                let engine = graph["resource"]["openshell_gateway_storage"]["runtime"]["engine"]
                    .as_str()
                    .unwrap();
                assert!(
                    engine.contains("$${engine}%%{literal}"),
                    "literal templates must survive OpenTofu evaluation"
                );
            }
        }
    }

    #[test]
    fn kubernetes_teardown_retains_only_established_storage_without_gateway_dependencies() {
        let document = Document::parse(
            include_bytes!("../../../examples/kubernetes/managed-development.yaml").as_slice(),
        )
        .unwrap();
        let generations = crate::state::Record::new(document.clone())
            .unwrap()
            .generations;
        let storage = "openshell_kubernetes_storage.runtime".to_owned();
        for established in [
            BTreeSet::new(),
            BTreeSet::from([storage.clone()]),
            BTreeSet::from([
                storage.clone(),
                "openshell_kubernetes_gateway.runtime".into(),
            ]),
        ] {
            let compiled =
                compile_teardown(&document, &generations, "0.1.0", &established).unwrap();
            let expected = established
                .into_iter()
                .filter(|address| address == &storage)
                .collect();
            assert_eq!(compiled.retained, expected);
            assert_eq!(addresses(&compiled.graph), expected);
            for provider in ["openshell", "fabric"] {
                assert_eq!(
                    compiled.graph["provider"][provider],
                    json!({"destroy": true}),
                    "{provider}"
                );
            }
            assert!(compiled.graph.get("data").is_none());
            assert!(compiled.graph.get("output").is_none());
            if compiled.retained.contains(&storage) {
                assert_eq!(
                    compiled.graph["resource"]["openshell_kubernetes_storage"]["runtime"]["lifecycle"],
                    json!({"prevent_destroy":true})
                );
            }
        }
    }

    #[test]
    fn reported_retention_matches_the_teardown_graph() {
        let (document, generations) = fixture();
        let established = addresses(&compile(&document, &generations, "0.1.0").unwrap());
        let compiled = compile_teardown(&document, &generations, "0.1.0", &established).unwrap();
        assert_eq!(compiled.retained, addresses(&compiled.graph));
        // Gateway storage, and the model cache and credentials: data only.
        assert_eq!(compiled.retained.len(), 3);
        assert!(!compiled.retained.contains("openshell_workspace.deployment"));
        let repeated =
            compile_teardown(&document, &generations, "0.1.0", &compiled.retained).unwrap();
        assert_eq!(repeated.retained, compiled.retained);
        assert_eq!(repeated.graph, compiled.graph);
    }

    /// The `label=KEY=VALUE` filter of Remove Retained Resources' Docker
    /// steps, with the deployment's UID in place of `$deployment_uid`.
    fn documented_owner_filter(uid: &str) -> (String, String) {
        let usage = include_str!("../../../docs/build-deploy/usage.md");
        let (_, cleanup) = usage
            .split_once("### Remove Retained Resources")
            .expect("usage.md has Remove Retained Resources");
        let docker = cleanup
            .split_once("#### On Docker")
            .and_then(|(_, rest)| rest.split_once("#### On Podman"))
            .expect("Remove Retained Resources has Docker steps, then Podman's")
            .0;
        let assignment = |name: &str| {
            docker
                .lines()
                .find_map(|line| line.strip_prefix(&format!("{name}=")))
                .unwrap_or_else(|| panic!("the Docker steps set {name}"))
                .trim_matches('"')
        };
        assert_eq!(
            assignment("deployment_uid"),
            "REPLACE_WITH_METADATA_UID",
            "the Docker steps select by metadata.uid"
        );
        for object in ["container", "volume", "network"] {
            let filtered = docker
                .lines()
                .filter(|line| {
                    line.contains(&format!("\"$deployment_engine\" {object} ls"))
                        && line.contains("--filter \"$owner_label\"")
                })
                .count();
            assert_eq!(
                filtered, 2,
                "{object} list and removal filter on $owner_label"
            );
        }
        let filter = assignment("owner_label");
        assert!(filter.ends_with("=$deployment_uid"), "{filter}");
        let (key, value) = filter
            .replace("$deployment_uid", uid)
            .strip_prefix("label=")
            .and_then(|selector| selector.split_once('='))
            .map(|(key, value)| (key.to_owned(), value.to_owned()))
            .unwrap_or_else(|| panic!("{filter} is a label=KEY=VALUE filter"));
        (key, value)
    }

    /// Labels Docker objects of a retained resource carry: the volume,
    /// network, and initializer container of gateway storage, or the volume of
    /// a model cache or credential storage.
    fn docker_labels(address: &str, attrs: &Value) -> std::collections::HashMap<String, String> {
        let row: crate::backend::Row = attrs
            .as_object()
            .unwrap()
            .iter()
            .filter_map(|(name, value)| Some((name.clone(), value.as_str()?.to_owned())))
            .collect();
        match address.split_once('.').unwrap().0 {
            "openshell_gateway_storage" => {
                crate::managed::Spec::from_values(crate::managed::GATEWAY_STORAGE_KIND, &row)
                    .unwrap()
                    .labels()
                    .unwrap()
            }
            "vllm_credential_storage" | "ollama_proxy_credential_storage" => {
                nemoclaw_docker::Storage::from_row(&row).unwrap().labels()
            }
            "docker_volume" => attrs["labels"]
                .as_array()
                .unwrap()
                .iter()
                .map(|label| {
                    (
                        label["label"].as_str().unwrap().to_owned(),
                        label["value"].as_str().unwrap().to_owned(),
                    )
                })
                .collect(),
            kind => panic!("{address}: no Docker cleanup is documented for retained {kind}"),
        }
    }

    #[test]
    fn documented_cleanup_filter_selects_every_retained_docker_object() {
        // QA 016: Remove Retained Resources must find what destroy retains.
        let mut spark: Value =
            serde_saphyr::from_str(include_str!("../tests/fixtures/config/spark.yaml")).unwrap();
        spark["spec"]["services"]["qwen"]["authentication"] = json!("bearer");
        let mut podman: Value =
            serde_saphyr::from_str(include_str!("../tests/fixtures/config/local.yaml")).unwrap();
        podman["spec"]["gateway"] = spark["spec"]["gateway"].clone();
        podman["spec"]["gateway"]["runtime"]["provider"] = json!("podman");
        let ollama: Value =
            serde_saphyr::from_str(include_str!("../tests/fixtures/config/managed-ollama.yaml"))
                .unwrap();
        let mut proxy = ollama.clone();
        proxy["spec"]["inferenceProviders"]["local"]["serviceRef"] = json!("ollama-auth");
        proxy["spec"]["services"] = json!({"ollama-auth": {
            "kind": "ollamaProxy",
            "image": format!("nc-ollama-proxy@sha256:{}", "a".repeat(64)),
            "endpoint": "http://172.20.0.1:11435/v1",
            "upstream": {"endpoint": "http://127.0.0.1:11434/v1",
                "model": {"name": "qwen3:0.6b", "digest": "a".repeat(64)}}
        }});
        let mut kinds = BTreeSet::new();
        for value in [spark, podman, ollama, proxy] {
            let document = Document::parse(value.to_string().as_bytes()).unwrap();
            let generations = crate::state::Record::new(document.clone())
                .unwrap()
                .generations;
            let established = addresses(&compile(&document, &generations, "0.1.0").unwrap());
            let compiled =
                compile_teardown(&document, &generations, "0.1.0", &established).unwrap();
            let (key, uid) = documented_owner_filter(&document.metadata.uid);
            for address in &compiled.retained {
                let (kind, name) = address.split_once('.').unwrap();
                let labels = docker_labels(address, &compiled.graph["resource"][kind][name]);
                assert_eq!(
                    labels.get(&key),
                    Some(&uid),
                    "the documented filter label={key}={uid} misses {address}: {labels:?}"
                );
                kinds.insert(kind.to_owned());
            }
        }
        assert_eq!(
            kinds,
            BTreeSet::from(
                [
                    "docker_volume",
                    "ollama_proxy_credential_storage",
                    "openshell_gateway_storage",
                    "vllm_credential_storage",
                ]
                .map(String::from)
            ),
            "the fixtures retain each documented kind of Docker storage"
        );
    }

    #[test]
    fn teardown_deletes_the_workspace() {
        // The workspace lives in the gateway, which teardown removes; keeping
        // it would leave state that the next plan can't refresh.
        let (document, generations) = fixture();
        for established in [
            BTreeSet::new(),
            BTreeSet::from([
                "openshell_workspace.deployment".into(),
                "openshell_sandbox.assistant".into(),
            ]),
        ] {
            let compiled =
                compile_teardown(&document, &generations, "0.1.0", &established).unwrap();
            let graph = compiled.graph;
            assert_eq!(addresses(&graph), BTreeSet::new());
            assert_eq!(compiled.retained, BTreeSet::new());
            assert!(graph.get("data").is_none());
        }
    }
}
