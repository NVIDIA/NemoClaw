// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! A managed Kubernetes gateway published through its chart's own NodePort
//! Service, at the endpoint clients dial.

use nemoclaw_sdk::{
    compile::{Generations, compile_runtime},
    config::{Document, schema},
};
use serde_json::{Value, json};

fn input(endpoint: &str, expose: bool) -> Value {
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
    if expose {
        input["spec"]["gateway"]["kubernetes"]["expose"] = json!({"service": {"type": "NodePort"}});
    }
    input["spec"]["sandboxes"]["assistant"]["image"]["metadata"] =
        json!({"env": "TEST_IMAGE_METADATA"});
    input
}

fn parse(input: &Value) -> Result<Document, String> {
    Document::parse(input.to_string().as_bytes()).map_err(|error| error.to_string())
}

#[test]
fn an_exposed_endpoint_names_the_host_and_port_clients_dial() {
    let validator = jsonschema::validator_for(&schema::input_schema()).unwrap();
    // Kubernetes checks the port against the cluster's node-port range.
    for endpoint in [
        "https://gateway.agents.example.com:30851",
        "https://192.0.2.10:443",
    ] {
        let accepted = input(endpoint, true);
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
    let mut load_balancer = input("https://gateway.agents.example.com:443", true);
    load_balancer["spec"]["gateway"]["kubernetes"]["expose"]["service"]["type"] =
        json!("LoadBalancer");
    for (refused, rule) in [
        // Without exposure, providers forward a loopback port.
        (
            input("https://gateway.agents.example.com:30851", false),
            "127.0.0.1",
        ),
        (
            input("http://gateway.agents.example.com:30851", true),
            "lowercase host",
        ),
        (
            input("https://gateway.agents.example.com", true),
            "lowercase host",
        ),
        (
            input("https://Gateway.example.com:30851", true),
            "lowercase host",
        ),
        // The chart's Service can't take a load balancer's settings yet.
        (load_balancer, "expose.service.type"),
    ] {
        assert!(!validator.is_valid(&refused), "schema accepted {refused}");
        let error = parse(&refused).expect_err("parser accepted an input the schema refuses");
        assert!(error.contains(rule), "{error}");
    }
    // The endpoint's address policy refuses hosts no client may dial.
    parse(&input("https://169.254.169.254:30851", true)).unwrap_err();
}

fn chart_values(document: &Value) -> Value {
    let generations: Generations = ["kubernetes_gateway", "kubernetes_storage"]
        .map(|kind| (kind.to_owned(), "a".repeat(32)))
        .into();
    let graph = compile_runtime(&parse(document).unwrap(), &generations, "0.1.0").unwrap();
    serde_json::from_str(
        graph["resource"]["helm_release"]["gateway"]["values"][0]
            .as_str()
            .unwrap(),
    )
    .unwrap()
}

/// The chart's own Service publishes the endpoint's port on every node, and
/// its certificate names the endpoint's host. The plaintext metrics port
/// stays unpublished.
#[test]
fn the_chart_publishes_an_exposed_gateway_at_its_endpoint() {
    for (endpoint, field, host, port) in [
        (
            "https://gateway.agents.example.com:30851",
            "serverDnsNames",
            "gateway.agents.example.com",
            30851,
        ),
        (
            "https://192.0.2.10:443",
            "serverIpAddresses",
            "192.0.2.10",
            443,
        ),
    ] {
        let values = chart_values(&input(endpoint, true));
        assert_eq!(
            values["service"],
            json!({"type": "NodePort", "nodePort": port, "metricsPort": 0})
        );
        assert_eq!(values["pkiInitJob"][field], json!([host]));
    }
    // The chart's certificate always names 127.0.0.1.
    let values = chart_values(&input("https://127.0.0.1:30851", true));
    assert_eq!(values["pkiInitJob"], json!({"enabled": true}));
    // Without exposure, the chart keeps its ClusterIP Service and metrics.
    let values = chart_values(&input("https://127.0.0.1:17671", false));
    assert!(values.get("service").is_none(), "{values}");
}
