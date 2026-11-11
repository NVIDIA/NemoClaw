// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! A managed Kubernetes gateway published through a NodePort or LoadBalancer
//! Service, at the endpoint clients dial.

use nemoclaw_sdk::{
    compile::{Generations, compile, compile_runtime, runtime_targets},
    config::{Document, schema},
};
use serde_json::{Value, json};

fn input(endpoint: &str, expose: Option<Value>) -> Value {
    let document =
        Document::parse(include_bytes!("fixtures/config/local.yaml").as_slice()).unwrap();
    let mut input = serde_json::to_value(document).unwrap();
    input["spec"]["gateway"] = json!({
        "management": "managed",
        "runtime": {"provider": "kubernetes"},
        "endpoint": endpoint,
        "kubernetes": {
            "kubeconfig": {"env": "CLUSTER_KUBECONFIG"},
            "context": "explicit-context",
            "namespace": "owned-gateway",
            "authentication": {"profile": "development"}
        }
    });
    if let Some(expose) = expose {
        input["spec"]["gateway"]["kubernetes"]["expose"] = expose;
    }
    input["spec"]["sandboxes"]["assistant"]["image"]["metadata"] =
        json!({"env": "TEST_IMAGE_METADATA"});
    input
}

/// The same gateway authenticated by an existing OIDC issuer.
fn oidc(mut input: Value) -> Value {
    input["spec"]["gateway"]["kubernetes"]["authentication"] =
        json!({"profile": "oidc", "token": {"env": "OPENSHELL_TOKEN"}});
    input["spec"]["gateway"]["config"] = json!({"openshell.gateway.oidc": {
        "issuer": "https://login.example.com/realms/openshell",
        "audience": "openshell",
    }});
    input
}

fn node_port() -> Value {
    json!({"service": {"type": "NodePort"}})
}

fn load_balancer() -> Value {
    json!({"service": {
        "type": "LoadBalancer",
        "loadBalancerSourceRanges": ["10.20.0.0/16", "2001:db8::/32"],
        "annotations": {"metallb.io/loadBalancerIPs": "10.20.0.40"}
    }})
}

fn parse(input: &Value) -> Result<Document, String> {
    Document::parse(input.to_string().as_bytes()).map_err(|error| error.to_string())
}

#[test]
fn an_exposed_endpoint_names_the_host_and_port_clients_dial() {
    let validator = jsonschema::validator_for(&schema::input_schema()).unwrap();
    for accepted in [
        input(
            "https://gateway.agents.example.com:30851",
            Some(node_port()),
        ),
        input("https://192.0.2.10:32767", Some(node_port())),
        oidc(input(
            "https://gateway.agents.example.com:443",
            Some(load_balancer()),
        )),
    ] {
        assert!(validator.is_valid(&accepted), "schema refused {accepted}");
        let document = parse(&accepted).unwrap();
        assert_eq!(
            serde_json::to_value(&document).unwrap()["spec"]["gateway"]["kubernetes"]["expose"],
            accepted["spec"]["gateway"]["kubernetes"]["expose"],
            "exposure settings survive parsing and export unchanged"
        );
    }
}

/// Each refusal comes from both the schema and the parser, with its rule.
#[test]
fn exposure_rules_refuse_documents_with_the_rule_they_break() {
    let validator = jsonschema::validator_for(&schema::input_schema()).unwrap();
    let with = |field: &str, value: Value| {
        let mut exposed = input(
            "https://gateway.agents.example.com:30851",
            Some(node_port()),
        );
        exposed["spec"]["gateway"]["kubernetes"]["expose"]["service"][field] = value;
        exposed
    };
    let mut reserved = oidc(input(
        "https://gateway.agents.example.com:443",
        Some(load_balancer()),
    ));
    reserved["spec"]["gateway"]["kubernetes"]["expose"]["service"]["annotations"] =
        json!({"nemoclaw.nvidia.com/uid": "spoofed"});
    for (refused, rule) in [
        // Without exposure, providers forward a loopback port.
        (
            input("https://gateway.agents.example.com:30851", None),
            "127.0.0.1",
        ),
        (
            input("http://gateway.agents.example.com:30851", Some(node_port())),
            "lowercase host",
        ),
        (
            input("https://gateway.agents.example.com", Some(node_port())),
            "lowercase host",
        ),
        (
            input("https://Gateway.example.com:30851", Some(node_port())),
            "lowercase host",
        ),
        (
            input(
                "https://gateway.agents.example.com:29999",
                Some(node_port()),
            ),
            "30000",
        ),
        (
            input(
                "https://gateway.agents.example.com:32768",
                Some(node_port()),
            ),
            "30000",
        ),
        (
            with("loadBalancerSourceRanges", json!(["10.20.0.0/16"])),
            "only to a LoadBalancer",
        ),
        (
            with(
                "annotations",
                json!({"metallb.io/loadBalancerIPs": "10.20.0.40"}),
            ),
            "only to a LoadBalancer",
        ),
        // A load balancer may be reachable from outside the cluster, where the
        // development profile's signing key would guard the port.
        (
            input(
                "https://gateway.agents.example.com:443",
                Some(load_balancer()),
            ),
            "oidc",
        ),
        (reserved, "nemoclaw.nvidia.com/"),
    ] {
        assert!(!validator.is_valid(&refused), "schema accepted {refused}");
        let error = parse(&refused).expect_err("parser accepted an input the schema refuses");
        assert!(error.contains(rule), "{error}");
    }
    // The endpoint's address policy refuses hosts no client may dial.
    parse(&input("https://169.254.169.254:30851", Some(node_port()))).unwrap_err();
}

fn generations() -> Generations {
    [
        "workspace",
        "provider",
        "sandbox",
        "kubernetes_gateway",
        "kubernetes_storage",
    ]
    .map(|kind| (kind.to_owned(), "a".repeat(32)))
    .into()
}

fn chart_values(graph: &Value) -> Value {
    serde_json::from_str(
        graph["resource"]["helm_release"]["gateway"]["values"][0]
            .as_str()
            .unwrap(),
    )
    .unwrap()
}

/// Like Docker's published port, the Service forwards the endpoint's port to
/// the gateway's own TLS listener, so TLS and client certificates pass
/// through unchanged.
#[test]
fn a_node_port_publishes_the_endpoint_port_to_the_gateway_listener() {
    let document = parse(&input(
        "https://gateway.agents.example.com:30851",
        Some(node_port()),
    ))
    .unwrap();
    let graph = compile_runtime(&document, &generations(), "0.1.0").unwrap();
    let release = format!("{}-gateway", document.workspace());
    let service = &graph["resource"]["kubernetes_service_v1"]["gateway_exposure"];
    let spec = &service["spec"][0];
    assert_eq!(spec["type"], "NodePort");
    assert_eq!(spec["selector"]["app.kubernetes.io/instance"], release);
    assert_eq!(
        spec["port"],
        json!([{
            "name": "grpc", "protocol": "TCP", "port": 30851,
            "node_port": 30851, "target_port": "grpc"
        }])
    );
    assert_eq!(
        service["metadata"][0]["labels"]["nemoclaw.nvidia.com/uid"],
        document.metadata.uid
    );
    assert_eq!(
        service["depends_on"],
        json!(["openshell_kubernetes_auth.runtime"]),
        "the Service is ready while Helm installs the gateway"
    );
    // Plan checks the Service's state binding against its target.
    let target = runtime_targets(&document, &generations())
        .unwrap()
        .into_iter()
        .find(|target| target.address == "kubernetes_service_v1.gateway_exposure")
        .unwrap();
    assert_eq!(target.values["name"], service["metadata"][0]["name"]);
    assert_eq!(
        target.values["namespace"],
        service["metadata"][0]["namespace"]
    );
    assert_eq!(
        graph["provider"]["kubernetes"],
        json!({
            "config_path": "${var.nemoclaw_kubeconfig}",
            "config_context": "explicit-context",
            "ignore_annotations": [".*"]
        }),
        "the Service uses Helm's cluster and leaves annotations controllers add"
    );
}

#[test]
fn a_load_balancer_carries_its_source_ranges_and_annotations() {
    let mut exposed = oidc(input(
        "https://gateway.agents.example.com:443",
        Some(load_balancer()),
    ));
    exposed["spec"]["gateway"]["kubernetes"]["expose"]["service"]["annotations"]["example.com/template"] =
        json!("${not-an-expression}");
    let graph = compile_runtime(&parse(&exposed).unwrap(), &generations(), "0.1.0").unwrap();
    let service = &graph["resource"]["kubernetes_service_v1"]["gateway_exposure"];
    assert_eq!(
        service["metadata"][0]["annotations"],
        json!({
            "example.com/template": "$${not-an-expression}",
            "metallb.io/loadBalancerIPs": "10.20.0.40"
        })
    );
    let spec = &service["spec"][0];
    assert_eq!(spec["type"], "LoadBalancer");
    assert_eq!(
        spec["load_balancer_source_ranges"],
        json!(["10.20.0.0/16", "2001:db8::/32"])
    );
    assert!(
        spec["port"][0].get("node_port").is_none(),
        "Kubernetes allocates a LoadBalancer's node port"
    );
    assert_eq!(service["wait_for_load_balancer"], true);
    assert_eq!(
        service["lifecycle"],
        json!({"ignore_changes": ["spec[0].load_balancer_class"]}),
        "a class a controller sets on create does not force replacement"
    );
}

/// Without a kubeconfig, the provider's client loads the pod's service
/// account, as Helm's does.
#[test]
fn an_exposure_from_a_pod_names_no_kubeconfig() {
    let mut exposed = input(
        "https://gateway.agents.example.com:30851",
        Some(node_port()),
    );
    let kubernetes = exposed["spec"]["gateway"]["kubernetes"]
        .as_object_mut()
        .unwrap();
    kubernetes.remove("kubeconfig");
    kubernetes.remove("context");
    let graph = compile_runtime(&parse(&exposed).unwrap(), &generations(), "0.1.0").unwrap();
    assert_eq!(
        graph["provider"]["kubernetes"],
        json!({"ignore_annotations": [".*"]})
    );
}

/// The gateway reads dial an exposed endpoint once the Service exists. A node
/// port is programmed within seconds; a load balancer's address may route
/// only after its provider's health checks pass. Without exposure, the graph
/// has no Service.
#[test]
fn the_gateway_reads_wait_for_the_exposure_service() {
    for (document, wait) in [
        (
            input(
                "https://gateway.agents.example.com:30851",
                Some(node_port()),
            ),
            Some(90),
        ),
        (
            oidc(input(
                "https://gateway.agents.example.com:443",
                Some(load_balancer()),
            )),
            Some(300),
        ),
        (input("https://127.0.0.1:17671", None), None),
    ] {
        let graph = compile(&parse(&document).unwrap(), &generations(), "0.1.0").unwrap();
        assert_eq!(
            graph["resource"].get("kubernetes_service_v1").is_some(),
            wait.is_some()
        );
        for read in ["current", "apply"] {
            let read = &graph["data"]["openshell_gateway"][read];
            assert_eq!(
                read["depends_on"]
                    .as_array()
                    .unwrap()
                    .contains(&json!("kubernetes_service_v1.gateway_exposure")),
                wait.is_some(),
                "{read}"
            );
            if let Some(wait) = wait {
                assert_eq!(read["wait_timeout_seconds"], wait, "{read}");
            }
        }
    }
}

#[test]
fn the_gateway_certificate_names_the_exposed_host() {
    for (endpoint, field, host) in [
        (
            "https://gateway.agents.example.com:30851",
            "serverDnsNames",
            "gateway.agents.example.com",
        ),
        (
            "https://192.0.2.10:30851",
            "serverIpAddresses",
            "192.0.2.10",
        ),
    ] {
        let graph = compile_runtime(
            &parse(&input(endpoint, Some(node_port()))).unwrap(),
            &generations(),
            "0.1.0",
        )
        .unwrap();
        assert_eq!(chart_values(&graph)["pkiInitJob"][field], json!([host]));
    }
    // The chart's certificate always names 127.0.0.1.
    let graph = compile_runtime(
        &parse(&input("https://127.0.0.1:30851", Some(node_port()))).unwrap(),
        &generations(),
        "0.1.0",
    )
    .unwrap();
    assert_eq!(chart_values(&graph)["pkiInitJob"], json!({"enabled": true}));
}
