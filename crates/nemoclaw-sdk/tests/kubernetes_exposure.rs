// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! A managed Kubernetes gateway published at the endpoint clients dial,
//! through its chart's own NodePort Service or, on OpenShift, its chart's
//! pass-through Route.

use nemoclaw_sdk::{
    compile::{Generations, compile_runtime},
    config::{Document, schema},
};
use serde_json::{Value, json};

fn node_port() -> Option<Value> {
    Some(json!({"service": {"type": "NodePort"}}))
}

fn route() -> Option<Value> {
    Some(json!({"route": {}}))
}

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

/// The same input with a managed OpenShift gateway.
fn openshift(mut input: Value) -> Value {
    input["spec"]["gateway"]["runtime"]["provider"] = json!("openshift");
    input
}

fn parse(input: &Value) -> Result<Document, String> {
    Document::parse(input.to_string().as_bytes()).map_err(|error| error.to_string())
}

#[test]
fn an_exposed_endpoint_names_the_host_and_port_clients_dial() {
    let validator = jsonschema::validator_for(&schema::input_schema()).unwrap();
    // Kubernetes checks the port against the cluster's node-port range, and
    // an OpenShift Route serves at whatever port the cluster's router does.
    for accepted in [
        input("https://gateway.agents.example.com:30851", node_port()),
        input("https://192.0.2.10:443", node_port()),
        openshift(input("https://gateway.apps.example.com:443", route())),
        openshift(input(
            "https://gateway.apps.example.com:8443",
            Some(json!({"route": {"annotations": {"haproxy.router.openshift.io/timeout": "1h"}}})),
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
    let mut load_balancer = input("https://gateway.agents.example.com:443", node_port());
    load_balancer["spec"]["gateway"]["kubernetes"]["expose"]["service"]["type"] =
        json!("LoadBalancer");
    for (refused, rule) in [
        // Without exposure, providers forward a loopback port.
        (
            input("https://gateway.agents.example.com:30851", None),
            "127.0.0.1",
        ),
        (
            input("http://gateway.agents.example.com:30851", node_port()),
            "lowercase host",
        ),
        (
            input("https://gateway.agents.example.com", node_port()),
            "lowercase host",
        ),
        (
            input("https://Gateway.example.com:30851", node_port()),
            "lowercase host",
        ),
        // The chart's Service can't take a load balancer's settings yet.
        (load_balancer, "expose.service.type"),
        // Only OpenShift serves Routes; other clusters publish through the
        // Service.
        (
            input("https://gateway.apps.example.com:443", route()),
            "expose.service",
        ),
        // The Route's host is the endpoint's, and clients send no SNI host
        // name for an IP address.
        (
            openshift(input("https://192.0.2.10:443", route())),
            "DNS name",
        ),
        // One exposure publishes the gateway.
        (
            openshift(input(
                "https://gateway.apps.example.com:443",
                Some(json!({"service": {"type": "NodePort"}, "route": {}})),
            )),
            "kubernetes.expose",
        ),
    ] {
        assert!(!validator.is_valid(&refused), "schema accepted {refused}");
        let error = parse(&refused).expect_err("parser accepted an input the schema refuses");
        assert!(error.contains(rule), "{error}");
    }
    // The endpoint's address policy refuses hosts no client may dial.
    parse(&input("https://169.254.169.254:30851", node_port())).unwrap_err();
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
        let values = chart_values(&input(endpoint, node_port()));
        assert_eq!(
            values["service"],
            json!({"type": "NodePort", "nodePort": port})
        );
        assert_eq!(values["pkiInitJob"][field], json!([host]));
        assert!(values.get("openshiftRoute").is_none(), "{values}");
    }
    // The chart's certificate always names 127.0.0.1.
    let values = chart_values(&input("https://127.0.0.1:30851", node_port()));
    assert_eq!(values["pkiInitJob"], json!({"enabled": true}));
    // Without exposure, the chart keeps its ClusterIP Service and metrics.
    let values = chart_values(&input("https://127.0.0.1:17671", None));
    assert!(values.get("service").is_none(), "{values}");
}

/// On OpenShift, the chart's pass-through Route publishes the gateway at the
/// endpoint's host with the authored annotations, and the certificate names
/// that host. The chart's Service stays in the cluster.
#[test]
fn the_chart_routes_an_exposed_openshift_gateway_at_its_endpoint() {
    let annotations = json!({"haproxy.router.openshift.io/timeout": "1h"});
    let values = chart_values(&openshift(input(
        "https://gateway.apps.example.com:443",
        Some(json!({"route": {"annotations": annotations}})),
    )));
    assert_eq!(
        values["openshiftRoute"],
        json!({"enabled": true, "host": "gateway.apps.example.com", "annotations": annotations})
    );
    assert_eq!(
        values["pkiInitJob"]["serverDnsNames"],
        json!(["gateway.apps.example.com"])
    );
    assert!(values.get("service").is_none(), "{values}");
}
