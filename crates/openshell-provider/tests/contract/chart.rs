// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! The pinned gateway chart rendered by the bundled Helm provider with the
//! SDK's values. This file writes each scenario's values to `inputs/`;
//! `hcl/chart/tests` holds the expectations.

use nemoclaw_sdk::{
    config::ManagedTarget,
    kubernetes::{GATEWAY_KIND, Spec, auth::Development, gateway, issuer},
};
use nemoclaw_test_fixtures::{Bundle, tofu::TofuWorkspace};
use serde_json::{Value, json};
use std::{fs, path::Path};

fn spec() -> Spec {
    serde_json::from_value(json!({
        "layout": 1, "kind": GATEWAY_KIND, "name": "nc-0123456789abcdef-gateway",
        "owner": "11111111-1111-4111-8111-111111111111",
        "generation": "0123456789abcdef0123456789abcdef",
        "settings": {
            "target": {"kubernetes": {
                "kubeconfig": {"env": "TEST_KUBECONFIG"}, "context": "selected", "namespace": "agents",
                "authentication": {"profile": "development"}
            }}
        }
    }))
    .unwrap()
}

/// The SDK's values, without the preflight that needs a cluster.
fn values(spec: &Spec) -> Value {
    let mut values = gateway::values(spec).unwrap();
    values["agentSandbox"]["preflight"]["enabled"] = json!(false);
    values
}

/// The bundle's Helm provider, which the SDK's gateway release uses. Its
/// executable keeps the upstream name, protocol suffix included.
fn helm() -> std::path::PathBuf {
    let bundle =
        std::env::var_os("NEMOCLAW_TEST_BUNDLE").expect("NEMOCLAW_TEST_BUNDLE names a bundle");
    let only = |directory: std::path::PathBuf| {
        let mut entries: Vec<_> = fs::read_dir(directory)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .collect();
        assert_eq!(
            entries.len(),
            1,
            "the bundle has one version and platform of each provider"
        );
        entries.pop().unwrap()
    };
    only(only(only(
        Path::new(&bundle).join("providers/registry.opentofu.org/hashicorp/helm"),
    )))
}

/// Render `test` with the inputs it reads.
fn render(test: &str) {
    let bundle = Bundle::from_env();
    let root = TofuWorkspace::with_providers(bundle.tofu(), &[("hashicorp/helm", &helm())]);
    root.copy(Path::new(super::HCL).join("chart"));
    let inputs = root.path().join("inputs");
    fs::create_dir(&inputs).unwrap();
    let write = |name: &str, value: &Value| {
        fs::write(inputs.join(name), serde_json::to_vec(value).unwrap()).unwrap();
    };
    let kubernetes = spec();
    write("kubernetes.json", &values(&kubernetes));
    let mut pull_secrets = spec();
    pull_secrets.settings.config = Some(
        serde_json::from_value(json!({"openshell.drivers.kubernetes": {
            "image_pull_secrets": ["registry-team", "registry.backup"]
        }}))
        .unwrap(),
    );
    write("pull-secrets.json", &values(&pull_secrets));
    let openshift_target = |spec: &mut Spec| {
        let cluster = spec.settings.cluster().unwrap().clone();
        spec.settings.target = ManagedTarget::OpenShift(Box::new(cluster));
    };
    let mut openshift = spec();
    openshift_target(&mut openshift);
    write("openshift.json", &values(&openshift));
    let mut exposed = spec();
    exposed.settings.target.cluster_mut().unwrap().expose = Some(
        serde_json::from_value(json!({
            "endpoint": "https://gateway.agents.example.com:30851",
            "service": {"type": "NodePort"}
        }))
        .unwrap(),
    );
    write("exposed.json", &values(&exposed));
    let mut routed = spec();
    openshift_target(&mut routed);
    routed.settings.target.cluster_mut().unwrap().expose = Some(
        serde_json::from_value(json!({
            "endpoint": "https://gateway.apps.example.com:443",
            "route": {"annotations": {"haproxy.router.openshift.io/timeout": "1h"}}
        }))
        .unwrap(),
    );
    write("routed.json", &values(&routed));
    // The objects NemoClaw creates before the release, which Helm must not own.
    let auth = tempfile::tempdir().unwrap();
    let material = Development::new(
        auth.path().to_owned(),
        &kubernetes.name,
        "agents",
        &kubernetes.owner,
    )
    .ensure()
    .unwrap();
    let mut prepared = issuer::objects(&material, &kubernetes.name, "agents");
    prepared
        .push(json!({"kind": "Secret", "metadata": {"name": format!("{}-kek", kubernetes.name)}}));
    let prepared: Vec<Value> = prepared
        .iter()
        .map(|object| json!({"kind": object["kind"], "name": object["metadata"]["name"]}))
        .collect();
    write("prepared.json", &Value::from(prepared));
    root.test(test, &[("TF_VAR_chart", gateway::CHART)]);
}

#[test]
#[ignore = "requires NEMOCLAW_TEST_BUNDLE; pulls the pinned chart"]
fn kubernetes_values_render_in_the_pinned_chart() {
    render("tests/kubernetes.tftest.hcl");
}

#[test]
#[ignore = "requires NEMOCLAW_TEST_BUNDLE; pulls the pinned chart"]
fn pull_secret_names_reach_only_the_sandbox_driver() {
    render("tests/pull-secrets.tftest.hcl");
}

#[test]
#[ignore = "requires NEMOCLAW_TEST_BUNDLE; pulls the pinned chart"]
fn an_exposed_gateway_is_published_by_the_charts_own_node_port_service() {
    render("tests/exposed.tftest.hcl");
}

#[test]
#[ignore = "requires NEMOCLAW_TEST_BUNDLE; pulls the pinned chart"]
fn an_exposed_openshift_gateway_is_published_by_the_charts_pass_through_route() {
    render("tests/routed.tftest.hcl");
}

#[test]
#[ignore = "requires NEMOCLAW_TEST_BUNDLE; pulls the pinned chart"]
fn on_openshift_the_chart_leaves_the_gateway_uid_to_openshift() {
    render("tests/openshift.tftest.hcl");
}
