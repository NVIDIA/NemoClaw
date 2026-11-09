// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! A managed Kubernetes gateway published through a NodePort or LoadBalancer
//! Service, at the endpoint clients dial.

use nemoclaw_sdk::{
    compile::{Generations, runtime_targets},
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
        "loadBalancerSourceRanges": ["10.20.0.0/16", "192.0.2.7/32"],
        "annotations": {"metallb.io/loadBalancerIPs": "10.20.0.40"}
    }})
}

fn parse(input: &Value) -> Result<Document, String> {
    Document::parse(input.to_string().as_bytes()).map_err(|error| error.to_string())
}

/// The schema and the parser agree: both accept or both refuse.
fn refused(input: &Value) -> String {
    let validator = jsonschema::validator_for(&schema::input_schema()).unwrap();
    assert!(!validator.is_valid(input), "schema accepted {input}");
    parse(input).expect_err("parser accepted an input the schema refuses")
}

#[test]
fn an_exposed_gateway_is_dialed_at_the_address_clients_reach() {
    let validator = jsonschema::validator_for(&schema::input_schema()).unwrap();
    for accepted in [
        input(
            "https://gateway.agents.example.com:30851",
            Some(node_port()),
        ),
        input("https://192.0.2.10:30000", Some(node_port())),
        input("https://127.0.0.1:32767", Some(node_port())),
        oidc(input(
            "https://gateway.agents.example.com:443",
            Some(load_balancer()),
        )),
        oidc(input(
            "https://10.20.0.40:8080",
            Some(json!({"service": {"type": "LoadBalancer"}})),
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

#[test]
fn without_exposure_the_endpoint_stays_a_loopback_port_forward() {
    for endpoint in [
        "https://gateway.agents.example.com:30851",
        "https://192.0.2.10:30851",
    ] {
        let error = refused(&input(endpoint, None));
        assert!(error.contains("127.0.0.1"), "{error}");
    }
    parse(&input("https://127.0.0.1:17671", None)).unwrap();
}

#[test]
fn an_exposed_endpoint_names_a_dialable_https_host_and_port() {
    for endpoint in [
        "http://gateway.agents.example.com:30851",
        "https://gateway.agents.example.com",
        "https://gateway.agents.example.com:30851/",
        "https://Gateway.Agents.example.com:30851",
        "https://user@gateway.agents.example.com:30851",
    ] {
        refused(&input(endpoint, Some(node_port())));
    }
    // The endpoint's address policy refuses hosts no client may dial.
    for endpoint in [
        "https://0.0.0.0:30851",
        "https://169.254.169.254:30851",
        "https://224.0.0.1:30851",
    ] {
        parse(&input(endpoint, Some(node_port()))).unwrap_err();
    }
}

#[test]
fn a_node_port_endpoint_uses_the_kubernetes_node_port_range() {
    for port in [29999, 32768, 443] {
        let error = refused(&input(
            &format!("https://gateway.agents.example.com:{port}"),
            Some(node_port()),
        ));
        assert!(error.contains("30000"), "{error}");
    }
    for port in [30000, 32767] {
        parse(&input(
            &format!("https://gateway.agents.example.com:{port}"),
            Some(node_port()),
        ))
        .unwrap();
    }
}

#[test]
fn load_balancer_settings_need_a_load_balancer() {
    for (field, value) in [
        ("loadBalancerSourceRanges", json!(["10.20.0.0/16"])),
        (
            "annotations",
            json!({"metallb.io/loadBalancerIPs": "10.20.0.40"}),
        ),
    ] {
        let mut exposed = input(
            "https://gateway.agents.example.com:30851",
            Some(node_port()),
        );
        exposed["spec"]["gateway"]["kubernetes"]["expose"]["service"][field] = value;
        refused(&exposed);
    }
}

#[test]
fn a_load_balancer_requires_an_existing_oidc_issuer() {
    // Cloud load balancers are often reachable from the internet by default;
    // the development profile's signing key would then guard that port.
    let error = refused(&input(
        "https://gateway.agents.example.com:443",
        Some(load_balancer()),
    ));
    assert!(error.contains("oidc"), "{error}");
}

#[test]
fn load_balancer_settings_have_kubernetes_shapes() {
    for (field, value) in [
        ("loadBalancerSourceRanges", json!(["10.20.0.0"])),
        ("loadBalancerSourceRanges", json!(["10.20.0.0/33"])),
        ("loadBalancerSourceRanges", json!(["300.20.0.0/16"])),
        (
            "loadBalancerSourceRanges",
            json!(["gateway.example.com/16"]),
        ),
        ("annotations", json!({"": "value"})),
        ("annotations", json!({"has space": "value"})),
        ("annotations", json!({"nemoclaw.nvidia.com/uid": "spoofed"})),
        ("annotations", json!({"example.com/": "value"})),
    ] {
        let mut exposed = oidc(input(
            "https://gateway.agents.example.com:443",
            Some(json!({"service": {"type": "LoadBalancer"}})),
        ));
        exposed["spec"]["gateway"]["kubernetes"]["expose"]["service"][field] = value.clone();
        refused(&exposed);
    }
    let mut exposed = oidc(input(
        "https://gateway.agents.example.com:443",
        Some(load_balancer()),
    ));
    exposed["spec"]["gateway"]["kubernetes"]["expose"]["service"]["loadBalancerSourceRanges"] =
        json!(["2001:db8::/32", "0.0.0.0/0"]);
    exposed["spec"]["gateway"]["kubernetes"]["expose"]["service"]["annotations"] = json!({
        "service.beta.kubernetes.io/aws-load-balancer-scheme": "internal",
        "networking.gke.io/load-balancer-type": "Internal",
        "plain-key": ""
    });
    parse(&exposed).unwrap();
}

/// Each platform resource rebuilds its specification from the attributes it
/// stores, which carry the endpoint but not the exposure Service.
#[test]
fn exposed_platform_resources_rebuild_from_their_attributes() {
    let generations: Generations = ["kubernetes_gateway", "kubernetes_storage"]
        .map(|kind| (kind.to_owned(), "a".repeat(32)))
        .into();
    for exposed in [
        input(
            "https://gateway.agents.example.com:30851",
            Some(node_port()),
        ),
        oidc(input(
            "https://gateway.agents.example.com:443",
            Some(load_balancer()),
        )),
    ] {
        let document = parse(&exposed).unwrap();
        let mut rebuilt = 0;
        for target in runtime_targets(&document, &generations).unwrap() {
            let kind = target.kind.as_str();
            if ![
                nemoclaw_sdk::kubernetes::STORAGE_KIND,
                nemoclaw_sdk::kubernetes::AUTH_KIND,
                nemoclaw_sdk::kubernetes::GATEWAY_KIND,
            ]
            .contains(&kind)
            {
                continue;
            }
            let spec = nemoclaw_sdk::kubernetes::Spec::from_row(kind, &target.values).unwrap();
            assert_eq!(
                spec.settings.endpoint,
                exposed["spec"]["gateway"]["endpoint"]
            );
            rebuilt += 1;
        }
        assert_eq!(rebuilt, 3);
    }
}
