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
    assert_eq!(
        service["metadata"],
        json!([{
            "name": format!("{release}-exposure"),
            "namespace": "owned-gateway",
            "labels": {"nemoclaw.nvidia.com/uid": document.metadata.uid}
        }])
    );
    assert_eq!(
        service["spec"],
        json!([{
            "type": "NodePort",
            "selector": {"app.kubernetes.io/name": "openshell", "app.kubernetes.io/instance": release},
            "port": [{
                "name": "grpc", "protocol": "TCP", "port": 30851,
                "node_port": 30851, "target_port": "grpc"
            }]
        }])
    );
    assert_eq!(
        service["depends_on"],
        json!(["openshell_kubernetes_auth.runtime"]),
        "the Service is ready while Helm installs the gateway"
    );
    assert_eq!(
        graph["terraform"]["required_providers"]["kubernetes"],
        json!({"source": "registry.opentofu.org/hashicorp/kubernetes", "version": "= 3.4.0"})
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
    assert!(
        runtime_targets(&document, &generations())
            .unwrap()
            .iter()
            .any(
                |target| target.address == "kubernetes_service_v1.gateway_exposure"
                    && target.values["name"] == format!("{release}-exposure")
                    && target.values["namespace"] == "owned-gateway"
            )
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
    let document = parse(&exposed).unwrap();
    let graph = compile_runtime(&document, &generations(), "0.1.0").unwrap();
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
        json!(["10.20.0.0/16", "192.0.2.7/32"])
    );
    assert_eq!(
        spec["port"],
        json!([{"name": "grpc", "protocol": "TCP", "port": 443, "target_port": "grpc"}]),
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

#[test]
fn without_exposure_the_graph_has_no_service_or_kubernetes_provider() {
    let document = parse(&input("https://127.0.0.1:17671", None)).unwrap();
    for graph in [
        compile_runtime(&document, &generations(), "0.1.0").unwrap(),
        compile(&document, &generations(), "0.1.0").unwrap(),
    ] {
        assert!(graph["resource"].get("kubernetes_service_v1").is_none());
        assert!(graph["provider"].get("kubernetes").is_none());
        assert!(
            graph["terraform"]["required_providers"]
                .get("kubernetes")
                .is_none()
        );
        assert!(
            graph["data"]["openshell_gateway"]["current"]
                .get("wait_timeout_seconds")
                .is_none()
        );
    }
    assert!(
        !runtime_targets(&document, &generations())
            .unwrap()
            .iter()
            .any(|target| target.address.starts_with("kubernetes_service_v1."))
    );
}

/// The gateway reads dial the endpoint once the Service exists. A node port
/// is programmed within seconds; a load balancer's address may route only
/// after its provider's health checks pass.
#[test]
fn the_gateway_reads_wait_for_the_exposure_service() {
    for (exposed, wait) in [
        (
            input(
                "https://gateway.agents.example.com:30851",
                Some(node_port()),
            ),
            90,
        ),
        (
            oidc(input(
                "https://gateway.agents.example.com:443",
                Some(load_balancer()),
            )),
            300,
        ),
    ] {
        let graph = compile(&parse(&exposed).unwrap(), &generations(), "0.1.0").unwrap();
        for read in ["current", "apply"] {
            let read = &graph["data"]["openshell_gateway"][read];
            assert!(
                read["depends_on"]
                    .as_array()
                    .unwrap()
                    .contains(&json!("kubernetes_service_v1.gateway_exposure")),
                "{read}"
            );
            assert_eq!(read["wait_timeout_seconds"], wait, "{read}");
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
        assert_eq!(
            chart_values(&graph)["pkiInitJob"],
            json!({"enabled": true, field: [host]})
        );
    }
    // The chart's certificate always names 127.0.0.1.
    for document in [
        input("https://127.0.0.1:30851", Some(node_port())),
        input("https://127.0.0.1:17671", None),
    ] {
        let graph = compile_runtime(&parse(&document).unwrap(), &generations(), "0.1.0").unwrap();
        assert_eq!(chart_values(&graph)["pkiInitJob"], json!({"enabled": true}));
    }
}
