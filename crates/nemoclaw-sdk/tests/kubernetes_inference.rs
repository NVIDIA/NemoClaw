// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Sandboxes on a Kubernetes or OpenShift gateway reach a model server that
//! the user runs in the gateway's cluster by its Service DNS name.
use nemoclaw_sdk::{
    compile::compile,
    config::{Document, schema},
};
use serde_json::{Value, json};

const SERVICE: &str = "http://qwen.models.svc.cluster.local:8000/v1";

/// The local fixture, with `endpoint` as its one provider's endpoint, on a
/// gateway of `driver`. Kubernetes and OpenShift gateways name the image's
/// metadata bundle; `managed` selects a managed Kubernetes gateway.
fn document(driver: &str, managed: bool, endpoint: &str) -> Value {
    let mut input = crate::support::fixture("local.yaml");
    input["spec"]["gateway"]["runtime"] = json!({"provider": driver});
    if managed {
        input["spec"]["gateway"] = json!({
            "management": "managed",
            "runtime": {"provider": driver},
            "endpoint": "https://127.0.0.1:17671",
            "kubernetes": {
                "kubeconfig": {"env": "TEST_KUBECONFIG"},
                "context": "test-cluster",
                "namespace": "test-agents",
                "authentication": {"profile": "development"}
            }
        });
    }
    if matches!(driver, "kubernetes" | "openshift") {
        input["spec"]["sandboxes"][0]["image"]["metadata"] = json!({"env": "TEST_IMAGE_METADATA"});
    }
    input["spec"]["inferenceProviders"][0]["endpoint"] = json!(endpoint);
    input
}

fn parse(input: &Value) -> Document {
    Document::parse(input.to_string().as_bytes()).unwrap()
}

/// The cluster gateways that route to an in-cluster Service.
fn cluster_gateways() -> [(&'static str, bool); 3] {
    [
        ("kubernetes", false),
        ("openshift", false),
        ("kubernetes", true),
    ]
}

fn generations() -> nemoclaw_sdk::compile::Generations {
    [
        "workspace",
        "provider",
        "sandbox",
        "kubernetes_gateway",
        "kubernetes_storage",
    ]
    .map(|kind| (kind.into(), "a".repeat(32)))
    .into()
}

/// One object of `kind` in `graph`.
fn only<'a>(graph: &'a Value, kind: &str) -> &'a Value {
    let objects = graph["resource"][kind].as_object().unwrap();
    assert_eq!(objects.len(), 1, "{kind}");
    objects.values().next().unwrap()
}

/// `sandbox`'s policy rule for the one inference registration in `graph`.
fn service_rule<'a>(graph: &'a Value, sandbox: &str) -> &'a Value {
    let inference = only(graph, "openshell_inference");
    let name = format!("nemoclaw-inference-{}", inference["name"].as_str().unwrap());
    graph["resource"]["openshell_sandbox"][sandbox]["policy"]["managed"]
        .as_array()
        .unwrap()
        .iter()
        .find(|rule| rule["name"] == name.as_str())
        .unwrap()
}

/// The endpoints of a sandbox rule for `SERVICE`: its host and port, without
/// addresses.
fn service_endpoints() -> Value {
    json!([{
        "host": "qwen.models.svc.cluster.local",
        "port": 8000,
        "path": "/v1/**",
        "protocol": "rest",
        "access": "full"
    }])
}

/// The registration names the Service literally, and the sandbox's rule for
/// it names the same host and port without addresses. OpenShell decides which
/// addresses the name may reach, so NemoClaw adds no grant.
#[test]
fn a_cluster_service_compiles_to_a_literal_server_and_an_fqdn_sandbox_rule() {
    for (driver, managed) in cluster_gateways() {
        let document = parse(&document(driver, managed, SERVICE));
        let graph = compile(&document, &generations(), "0.1.0").unwrap();
        let inference = only(&graph, "openshell_inference");
        assert_eq!(
            inference["server"],
            json!({
                "type": "inference_server",
                "endpoint": SERVICE,
                "credential_env": "",
                "credential_source": ""
            }),
            "{driver}"
        );
        assert!(inference.get("cluster_source").is_none(), "{driver}");
        let policy = &graph["resource"]["openshell_sandbox"]["assistant"]["policy"];
        assert!(policy.get("cluster_grants").is_none(), "{driver}");
        assert_eq!(
            service_rule(&graph, "assistant")["endpoints"],
            service_endpoints(),
            "{driver}"
        );
        let models = only(&graph, "fabric_agent")["models"].as_object().unwrap();
        assert!(!models.is_empty());
        for model in models.values() {
            assert_eq!(model["base_url"], SERVICE, "{driver}");
        }
    }
}

/// The agent row of each of the three sandboxes in `input`, each named by its
/// sandbox's `agent.name`, which Fabric receives as `metadata.name`.
fn agents<'a>(input: &Value, graph: &'a Value) -> Vec<&'a Value> {
    let rows = graph["resource"]["fabric_agent"].as_object().unwrap();
    let sandboxes = parse(input).spec.sandboxes;
    assert_eq!(rows.len(), 3);
    assert_eq!(sandboxes.len(), 3);
    sandboxes
        .iter()
        .map(|sandbox| {
            let row = &rows[&sandbox.name];
            assert_eq!(row["name"], sandbox.agent.name.as_str(), "{}", sandbox.name);
            row
        })
        .collect()
}

/// Three agents on one cluster gateway share one registration of the Service,
/// and each agent's sandbox has its own rule for it. Each agent keeps its
/// sandbox's agent name, whatever the order of the sandboxes.
#[test]
fn three_agents_on_a_cluster_gateway_share_one_service_registration_with_their_own_rules() {
    for example in [
        "kubernetes/external-gateway.yaml",
        "openshift/external-gateway.yaml",
    ] {
        let mut input = crate::support::example(example);
        input["spec"]["inferenceProviders"][0]["endpoint"] = json!(SERVICE);
        let graph = compile(&parse(&input), &generations(), "0.1.0").unwrap();
        let inference = only(&graph, "openshell_inference");
        assert_eq!(
            inference["server"],
            json!({
                "type": "inference_server",
                "endpoint": SERVICE,
                "credential_env": input["spec"]["inferenceProviders"][0]["credential"]["env"],
                "credential_source": ""
            }),
            "{example}"
        );
        assert!(inference.get("cluster_source").is_none(), "{example}");
        let sandboxes = graph["resource"]["openshell_sandbox"].as_object().unwrap();
        assert_eq!(sandboxes.len(), 3, "{example}");
        for (sandbox, resource) in sandboxes {
            assert!(
                resource["policy"].get("cluster_grants").is_none(),
                "{example} {sandbox}"
            );
            assert_eq!(
                service_rule(&graph, sandbox)["endpoints"],
                service_endpoints(),
                "{example} {sandbox}"
            );
        }
        for agent in agents(&input, &graph) {
            let models = agent["models"].as_object().unwrap();
            assert!(!models.is_empty(), "{example}");
            for model in models.values() {
                assert_eq!(model["base_url"], SERVICE, "{example}");
            }
        }
        input["spec"]["sandboxes"].as_array_mut().unwrap().reverse();
        assert_eq!(
            compile(&parse(&input), &generations(), "0.1.0").unwrap(),
            graph,
            "{example}"
        );
    }
    // This example's explicit sandbox policies name its hosted endpoint, so it
    // keeps that endpoint and only its agent names are checked.
    let input = crate::support::example("kubernetes/managed-development.yaml");
    let graph = compile(&parse(&input), &generations(), "0.1.0").unwrap();
    agents(&input, &graph);
}

/// `input` with its one provider given a key and declared, in turn, in each
/// place a document can declare an inference provider.
fn keyed_providers(input: &Value) -> Vec<(&'static str, Value)> {
    fn sandbox(document: &mut Value) -> &mut Value {
        &mut document["spec"]["sandboxes"][0]
    }
    let mut provider = input["spec"]["inferenceProviders"][0].clone();
    provider["credential"] = json!({"env": "QWEN_INFERENCE_KEY"});
    let mut shared = input.clone();
    shared["spec"]["inferenceProviders"][0] = provider.clone();
    let mut bare = input.clone();
    bare["spec"]
        .as_object_mut()
        .unwrap()
        .remove("inferenceProviders");
    let mut route = sandbox(&mut bare)["agent"]["inference"]["routes"][0].clone();
    route.as_object_mut().unwrap().remove("providerRef");
    route["provider"] = provider.clone();
    let inference = json!({"routes": [route]});
    let mut scoped = bare.clone();
    sandbox(&mut scoped)["inferenceProviders"] = json!([provider]);
    let mut inline = bare.clone();
    sandbox(&mut inline)["agent"]["inference"] = inference.clone();
    let named = |mut document: Value, in_sandbox: bool| {
        let owner = if in_sandbox {
            sandbox(&mut document)
        } else {
            &mut document["spec"]
        };
        owner["inferences"] = json!({"chat": inference});
        let agent = sandbox(&mut document)["agent"].as_object_mut().unwrap();
        agent.remove("inference");
        agent.insert("inferenceRef".into(), json!("chat"));
        document
    };
    vec![
        ("spec.inferenceProviders", shared),
        ("sandbox inferenceProviders", scoped),
        ("agent inference", inline),
        ("spec.inferences", named(bare.clone(), false)),
        ("sandbox inferences", named(bare, true)),
    ]
}

/// OpenShell decides which destinations a sandbox may reach and where a key
/// may go, so NemoClaw accepts a credential on any HTTP or HTTPS endpoint, on
/// any gateway, wherever the provider is declared.
#[test]
fn any_endpoint_takes_a_key_on_any_gateway() {
    let validator = jsonschema::validator_for(&schema::input_schema()).unwrap();
    let gateways = cluster_gateways()
        .into_iter()
        .chain([("docker", false), ("podman", false)]);
    for (driver, managed) in gateways {
        for endpoint in [
            SERVICE,
            "http://10.96.0.10:8000/v1",
            "https://inference.example.com/v1",
        ] {
            for (location, input) in keyed_providers(&document(driver, managed, endpoint)) {
                assert!(validator.is_valid(&input), "{driver} {endpoint} {location}");
                let document = parse(&input);
                assert!(
                    document.credential_names().contains(&"QWEN_INFERENCE_KEY"),
                    "{driver} {endpoint} {location}"
                );
                if matches!(driver, "kubernetes" | "openshift") {
                    let graph = compile(&document, &generations(), "0.1.0").unwrap();
                    assert_eq!(
                        only(&graph, "openshell_inference")["server"]["credential_env"],
                        "QWEN_INFERENCE_KEY",
                        "{driver} {endpoint} {location}"
                    );
                }
            }
        }
    }
}
