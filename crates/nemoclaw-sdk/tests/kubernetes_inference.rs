// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Sandboxes on a Kubernetes or OpenShift gateway reach a model server that
//! the user runs in the gateway's cluster by its Service DNS name.
use nemoclaw_sdk::{
    compile::compile,
    config::{Document, schema},
    discovery::{DiscoveryQuery, plan_queries},
    inference_discovery::{endpoint_requests, is_cluster_service_endpoint},
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

fn catalog_reads(document: &Document) -> usize {
    plan_queries(document)
        .unwrap()
        .iter()
        .filter(|query| matches!(query, DiscoveryQuery::Inference(_)))
        .count()
}

/// The cluster gateways that route to an in-cluster Service.
fn cluster_gateways() -> [(&'static str, bool); 3] {
    [
        ("kubernetes", false),
        ("openshift", false),
        ("kubernetes", true),
    ]
}

/// A DNS label of `length` characters starting with `first`.
fn label(first: char, length: usize) -> String {
    std::iter::once(first)
        .chain(std::iter::repeat_n('a', length - 1))
        .collect()
}

/// Endpoints that name a Service by its cluster DNS name.
fn service_endpoints() -> Vec<String> {
    vec![
        SERVICE.to_owned(),
        "http://qwen.models.svc.cluster.local:8000".into(),
        "http://qwen.models.svc.cluster.local:8000/".into(),
        "http://qwen.models.svc.cluster.local:8000/openai/v1".into(),
        "http://q.m.svc.cluster.local:1/v1".into(),
        "http://vllm-0.0team.svc.cluster.local:65535/v1".into(),
        format!(
            "http://{}.{}.svc.cluster.local:8000/v1",
            label('q', 63),
            label('0', 63)
        ),
    ]
}

/// Endpoints that do not, including ones that resemble the form.
fn other_endpoints() -> Vec<String> {
    vec![
        "https://qwen.models.svc.cluster.local:8000/v1".to_owned(),
        "HTTP://qwen.models.svc.cluster.local:8000/v1".into(),
        "qwen.models.svc.cluster.local:8000/v1".into(),
        // The port must be explicit, nonzero, and spelled without padding.
        "http://qwen.models.svc.cluster.local/v1".into(),
        "http://qwen.models.svc.cluster.local:/v1".into(),
        "http://qwen.models.svc.cluster.local:0/v1".into(),
        "http://qwen.models.svc.cluster.local:08000/v1".into(),
        "http://qwen.models.svc.cluster.local:65536/v1".into(),
        "http://qwen.models.svc.cluster.local:+80/v1".into(),
        // Only <service>.<namespace>.svc.cluster.local names a Service.
        "http://qwen.models.svc:8000/v1".into(),
        "http://qwen.models:8000/v1".into(),
        "http://qwen.svc.cluster.local:8000/v1".into(),
        "http://pod.qwen.models.svc.cluster.local:8000/v1".into(),
        "http://qwen.models.svc.cluster.local.:8000/v1".into(),
        "http://qwen.models.svc.cluster.example:8000/v1".into(),
        "http://qwen.models.pod.cluster.local:8000/v1".into(),
        "http://qwen..svc.cluster.local:8000/v1".into(),
        // Service names are DNS-1035 labels; namespaces are DNS-1123 labels.
        "http://Qwen.models.svc.cluster.local:8000/v1".into(),
        "http://qwen.Models.svc.cluster.local:8000/v1".into(),
        "http://0qwen.models.svc.cluster.local:8000/v1".into(),
        "http://-qwen.models.svc.cluster.local:8000/v1".into(),
        "http://qwen-.models.svc.cluster.local:8000/v1".into(),
        "http://qwen.-models.svc.cluster.local:8000/v1".into(),
        "http://qwen.models-.svc.cluster.local:8000/v1".into(),
        "http://q_wen.models.svc.cluster.local:8000/v1".into(),
        format!("http://{}.models.svc.cluster.local:8000/v1", label('q', 64)),
        format!("http://qwen.{}.svc.cluster.local:8000/v1", label('m', 64)),
        // Addresses, credentials, queries, fragments, and other spellings.
        "http://10.96.0.10:8000/v1".into(),
        "http://[fd00::10]:8000/v1".into(),
        "http://user@qwen.models.svc.cluster.local:8000/v1".into(),
        "http://user:secret@qwen.models.svc.cluster.local:8000/v1".into(),
        "http://qwen.models.svc.cluster.local:8000/v1?debug=1".into(),
        "http://qwen.models.svc.cluster.local:8000/v1#fragment".into(),
        "http://qwen.models.svc.cluster.local:8000?debug=1".into(),
        "http://qwen.models.svc.cluster.local:8000\\v1".into(),
        "http://qwen.models.svc.cluster.local:8000/${var.path}".into(),
        "http://qwen.models.svc.cluster.local:8000/v1\n".into(),
        " http://qwen.models.svc.cluster.local:8000/v1".into(),
    ]
}

#[test]
fn a_cluster_service_endpoint_is_an_http_service_dns_name_with_an_explicit_port() {
    for endpoint in service_endpoints() {
        assert!(is_cluster_service_endpoint(&endpoint), "{endpoint}");
    }
    for endpoint in other_endpoints() {
        assert!(!is_cluster_service_endpoint(&endpoint), "{endpoint}");
    }
}

/// The control host cannot resolve a cluster DNS name, and OpenShell carries
/// the sandboxes' requests to it, so planning and onboarding read no model
/// catalog for it. Before this, the read failed planning outright.
#[test]
fn cluster_gateways_read_no_model_catalog_for_a_cluster_service() {
    for (driver, managed) in cluster_gateways() {
        let document = parse(&document(driver, managed, SERVICE));
        assert_eq!(endpoint_requests(&document).unwrap(), [], "{driver}");
        assert_eq!(catalog_reads(&document), 0, "{driver}");
    }
}

/// Only the Service form skips the read: other cluster endpoints keep their
/// catalog read, and an HTTP name the control host cannot check still fails.
#[test]
fn other_endpoints_on_cluster_gateways_keep_their_catalog_reads() {
    for (driver, managed) in cluster_gateways() {
        for endpoint in [
            "https://qwen.models.svc.cluster.local:8443/v1",
            "https://integrate.api.nvidia.com/v1",
            "http://10.96.0.10:8000/v1",
        ] {
            let document = parse(&document(driver, managed, endpoint));
            assert_eq!(catalog_reads(&document), 1, "{driver} {endpoint}");
        }
        for endpoint in [
            "http://qwen.models.svc:8000/v1",
            "http://model.example.com:8000/v1",
        ] {
            let document = parse(&document(driver, managed, endpoint));
            assert_eq!(
                plan_queries(&document).unwrap_err().to_string(),
                "inference discovery inputs are invalid",
                "{driver} {endpoint}"
            );
        }
    }
}

/// A Docker or Podman gateway's sandboxes are not in a cluster, so the Service
/// form is an ordinary HTTP name there and planning still rejects it.
#[test]
fn local_gateways_still_reject_a_cluster_service_endpoint() {
    for driver in ["docker", "podman"] {
        let document = parse(&document(driver, false, SERVICE));
        assert!(endpoint_requests(&document).is_err(), "{driver}");
        assert_eq!(
            plan_queries(&document).unwrap_err().to_string(),
            "inference discovery inputs are invalid",
            "{driver}"
        );
        assert!(
            compile(&document, &generations(), "0.1.0").is_err(),
            "{driver}"
        );
    }
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
        let rule = &policy["managed"]
            [format!("nemoclaw-inference-{}", inference["name"].as_str().unwrap())];
        assert_eq!(
            rule["endpoints"],
            json!([{
                "host": "qwen.models.svc.cluster.local",
                "port": 8000,
                "path": "/v1/**",
                "protocol": "rest",
                "access": "full"
            }]),
            "{driver}"
        );
        let models = only(&graph, "fabric_agent")["models"].as_object().unwrap();
        assert!(!models.is_empty());
        for model in models.values() {
            assert_eq!(model["base_url"], SERVICE, "{driver}");
        }
    }
}

const KEY_ERROR: &str = "credential on an http://SERVICE.NAMESPACE.svc.cluster.local endpoint requires a Kubernetes or OpenShift gateway";

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

/// A key crosses plain HTTP only to a Service in the gateway's own cluster,
/// so only a Kubernetes or OpenShift gateway accepts one for that endpoint,
/// wherever the provider is declared.
#[test]
fn a_cluster_service_endpoint_takes_a_key_only_with_a_cluster_gateway() {
    let validator = jsonschema::validator_for(&schema::input_schema()).unwrap();
    for (driver, managed) in cluster_gateways() {
        for (location, input) in keyed_providers(&document(driver, managed, SERVICE)) {
            assert!(validator.is_valid(&input), "{driver} {location}");
            let document = parse(&input);
            assert!(
                document.credential_names().contains(&"QWEN_INFERENCE_KEY"),
                "{driver} {location}"
            );
            let graph = compile(&document, &generations(), "0.1.0").unwrap();
            assert_eq!(
                only(&graph, "openshell_inference")["server"]["credential_env"],
                "QWEN_INFERENCE_KEY",
                "{driver} {location}"
            );
        }
    }
    for driver in ["docker", "podman"] {
        for (location, input) in keyed_providers(&document(driver, false, SERVICE)) {
            assert!(!validator.is_valid(&input), "{driver} {location}");
            let error = Document::parse(input.to_string().as_bytes())
                .unwrap_err()
                .to_string();
            assert!(error.ends_with(KEY_ERROR), "{driver} {location}: {error}");
        }
    }
}

/// Validation of a directly constructed document applies the same rule.
#[test]
fn a_constructed_document_cannot_send_a_key_to_a_service_from_a_local_gateway() {
    let (_, input) = keyed_providers(&document("kubernetes", false, SERVICE)).remove(0);
    let mut document = parse(&input);
    assert!(document.validate().is_ok());
    document.spec.gateway = parse(&self::document("docker", false, SERVICE))
        .spec
        .gateway;
    document.spec.sandboxes[0].image.metadata = None;
    let error = document.validate().unwrap_err().to_string();
    assert!(error.ends_with(KEY_ERROR), "{error}");
}

/// Every other plain-HTTP endpoint still takes no key, on any gateway.
#[test]
fn only_the_service_form_takes_a_key_over_plain_http() {
    for (driver, managed) in cluster_gateways() {
        for endpoint in service_endpoints()
            .into_iter()
            .chain(other_endpoints())
            .filter(|endpoint| endpoint.starts_with("http://"))
        {
            let mut input = document(driver, managed, &endpoint);
            input["spec"]["inferenceProviders"][0]["credential"] =
                json!({"env": "QWEN_INFERENCE_KEY"});
            assert_eq!(
                Document::parse(input.to_string().as_bytes()).is_ok(),
                is_cluster_service_endpoint(&endpoint),
                "{driver} {endpoint}"
            );
        }
    }
    let mut input = document("kubernetes", false, "http://10.96.0.10:8000/v1");
    input["spec"]["inferenceProviders"][0]["credential"] = json!({"env": "QWEN_INFERENCE_KEY"});
    let error = Document::parse(input.to_string().as_bytes())
        .unwrap_err()
        .to_string();
    assert!(
        error.ends_with("credential requires an HTTPS endpoint, or an http://SERVICE.NAMESPACE.svc.cluster.local:PORT endpoint with a Kubernetes or OpenShift gateway"),
        "{error}"
    );
}
