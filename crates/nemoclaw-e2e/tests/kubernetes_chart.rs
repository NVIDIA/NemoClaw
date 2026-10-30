// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! The pinned gateway chart rendered with the SDK's values through the
//! bundled Helm provider. Neither test setup nor rendering needs a Helm
//! executable.

use nemoclaw_sdk::{
    bundle::Bundle,
    config::ComputeDriver,
    kubernetes::{GATEWAY_KIND, Spec, auth::Development, gateway, issuer},
};
use serde_json::{Value, json};
use std::{fs, path::Path, time::Duration};

fn spec() -> Spec {
    serde_json::from_value(json!({
        "layout": 1, "kind": GATEWAY_KIND, "name": "nc-0123456789abcdef-gateway",
        "owner": "11111111-1111-4111-8111-111111111111",
        "generation": "0123456789abcdef0123456789abcdef",
        "settings": {
            "runtime": {"provider": "kubernetes"},
            "endpoint": "https://127.0.0.1:17671",
            "kubernetes": {
                "kubeconfig": {"env": "TEST_KUBECONFIG"}, "context": "selected", "namespace": "agents",
                "authentication": {"profile": "development"}
            }
        }
    }))
    .unwrap()
}

async fn tofu(bundle: &Bundle, directory: &Path, arguments: &[&str]) -> std::process::Output {
    let mut command = tokio::process::Command::new(bundle.tofu());
    command
        .args(arguments)
        .current_dir(directory)
        .env_clear()
        .env("PATH", directory.join("empty-path"))
        .env("HOME", directory.join("home"))
        .env("TF_IN_AUTOMATION", "1")
        .env("TF_INPUT", "0")
        .env("CHECKPOINT_DISABLE", "1")
        .env("TF_CLI_CONFIG_FILE", directory.join("providers.tfrc"))
        .kill_on_drop(true);
    tokio::time::timeout(Duration::from_secs(180), command.output())
        .await
        .expect("chart rendering timed out")
        .expect("cannot execute the verified bundle's OpenTofu")
}

/// Pull and render the exact OCI digest with the actual bundled provider.
/// A data source performs no installation and needs no cluster access.
async fn render(spec: &Spec, chart: &str) -> Option<String> {
    let input = std::env::var_os("NEMOCLAW_TEST_BUNDLE")
        .expect("NEMOCLAW_TEST_BUNDLE names a verified bundle");
    let bundle = Bundle::open(Path::new(&input)).unwrap();
    let directory = tempfile::tempdir().unwrap();
    for name in ["empty-path", "home"] {
        fs::create_dir(directory.path().join(name)).unwrap();
    }
    let mirror = serde_json::to_string(
        &bundle
            .directory
            .join("providers")
            .to_string_lossy()
            .replace('\\', "/"),
    )
    .unwrap();
    fs::write(
        directory.path().join("providers.tfrc"),
        format!("provider_installation {{ filesystem_mirror {{ path = {mirror} }} }}\n"),
    )
    .unwrap();
    let mut values = gateway::values(spec).unwrap();
    // Rendering has no cluster from which to observe this existing prerequisite.
    values["agentSandbox"]["preflight"]["enabled"] = json!(false);
    let graph = json!({
        "terraform": {"required_providers": {"helm": {
            "source": gateway::PROVIDER_ADDRESS,
            "version": format!("= {}", gateway::PROVIDER_VERSION)
        }}},
        "provider": {"helm": {}},
        "data": {"helm_template": {"gateway": {
            "name": spec.name, "namespace": "agents", "chart": chart,
            "validate": false, "values": [values.to_string()]
        }}},
        "output": {"manifest": {"value": "${data.helm_template.gateway.manifest}"}}
    });
    let config = directory.path().join("main.tf.json");
    fs::write(&config, serde_json::to_vec(&graph).unwrap()).unwrap();
    let initialized = tofu(
        &bundle,
        directory.path(),
        &["init", "-input=false", "-no-color"],
    )
    .await;
    assert!(
        initialized.status.success(),
        "cannot initialize the chart renderer"
    );
    let planned = tofu(
        &bundle,
        directory.path(),
        &["plan", "-input=false", "-no-color", "-out=render.tfplan"],
    )
    .await;
    if !planned.status.success() {
        return None;
    }
    let output = tofu(
        &bundle,
        directory.path(),
        &["show", "-json", "render.tfplan"],
    )
    .await;
    assert!(
        output.status.success(),
        "cannot inspect the chart-render plan"
    );
    let plan: Value = serde_json::from_slice(&output.stdout).unwrap();
    Some(
        plan["planned_values"]["outputs"]["manifest"]["value"]
            .as_str()
            .unwrap()
            .to_owned(),
    )
}

/// Check actual chart objects against the objects NemoClaw prepares. Helm must
/// never include those objects in its release and remove them during uninstall.
fn assert_release_ownership(rendered: &str, spec: &Spec) {
    let directory = tempfile::tempdir().unwrap();
    let namespace = &spec.settings.kubernetes.as_ref().unwrap().namespace;
    let material = Development::new(
        directory.path().join("auth"),
        &spec.name,
        namespace,
        &spec.owner,
    )
    .ensure()
    .unwrap();
    let mut prepared = issuer::objects(&material, &spec.name, namespace);
    prepared.extend([
        json!({"apiVersion": "v1", "kind": "Namespace", "metadata": {"name": namespace}}),
        json!({"apiVersion": "v1", "kind": "Secret", "metadata": {
            "name": format!("{}-kek", spec.name), "namespace": namespace,
        }}),
    ]);
    let objects: Vec<Value> = serde_saphyr::from_multiple(rendered).unwrap();
    let identity = |object: &Value| {
        (
            object["apiVersion"].clone(),
            object["kind"].clone(),
            object["metadata"]["name"].clone(),
        )
    };
    for object in &objects {
        assert!(
            !prepared
                .iter()
                .any(|owned| identity(owned) == identity(object)),
            "Helm must not own NemoClaw's {} {}",
            object["kind"],
            object["metadata"]["name"],
        );
        assert_ne!(object["kind"], "Namespace");
    }
    assert_eq!(
        objects
            .iter()
            .filter(
                |object| object["kind"] == "StatefulSet" && object["metadata"]["name"] == spec.name
            )
            .count(),
        1,
        "the release owns the gateway StatefulSet"
    );
}

#[tokio::test]
#[ignore = "pulls the pinned chart; needs NEMOCLAW_TEST_BUNDLE"]
async fn the_pinned_chart_renders_with_the_sdk_values() {
    let spec = spec();
    let values = gateway::values(&spec).unwrap();
    let rendered = render(&spec, gateway::CHART)
        .await
        .expect("the pinned chart renders");
    assert_release_ownership(&rendered, &spec);
    assert!(
        rendered.contains("runAsUser: 1000\n"),
        "Kubernetes keeps the chart's gateway UID"
    );
    let pinned = format!(
        "{}@{}",
        values["gateway"]["image"]["repository"].as_str().unwrap(),
        values["gateway"]["image"]["digest"].as_str().unwrap()
    );
    assert!(
        rendered.contains(&pinned),
        "the pinned gateway image is rendered"
    );
    assert!(rendered.contains("name: nc-0123456789abcdef-gateway"));
    assert!(rendered.contains("nc-0123456789abcdef-gateway-kek"));

    // A wrong digest must fail; the provider cannot silently select a tag.
    let unavailable = format!(
        "oci://ghcr.io/nvidia/openshell/helm-chart@sha256:{}",
        "0".repeat(64)
    );
    assert!(
        render(&spec, &unavailable).await.is_none(),
        "the provider refuses an unavailable chart digest"
    );
}

/// The chart carries references into pods and the native driver configuration.
#[tokio::test]
#[ignore = "pulls the pinned chart; needs NEMOCLAW_TEST_BUNDLE"]
async fn the_pinned_chart_passes_pull_secret_names_to_pods_and_the_sandbox_driver() {
    let mut spec = spec();
    spec.settings
        .kubernetes
        .as_mut()
        .unwrap()
        .image_pull_secrets = vec!["registry-team".into(), "registry.backup".into()];
    let rendered = render(&spec, gateway::CHART).await.unwrap();
    let objects: Vec<Value> = serde_saphyr::from_multiple(&rendered).unwrap();
    let mut pods = 0;
    for object in &objects {
        if matches!(object["kind"].as_str(), Some("StatefulSet" | "Job")) {
            assert_eq!(
                object["spec"]["template"]["spec"]["imagePullSecrets"],
                json!([{"name": "registry-team"}, {"name": "registry.backup"}])
            );
            pods += 1;
        }
    }
    assert!(
        pods >= 2,
        "the gateway and helper pod templates are checked"
    );
    let config = objects
        .iter()
        .find(|object| object["kind"] == "ConfigMap" && object["data"]["gateway.toml"].is_string())
        .unwrap();
    let config: toml::Value =
        toml::from_str(config["data"]["gateway.toml"].as_str().unwrap()).unwrap();
    let names = config["openshell"]["drivers"]["kubernetes"]["image_pull_secrets"]
        .as_array()
        .unwrap();
    assert_eq!(
        names
            .iter()
            .map(|name| name.as_str().unwrap())
            .collect::<Vec<_>>(),
        ["registry-team", "registry.backup"]
    );
    for name in ["registry-team", "registry.backup"] {
        assert!(
            objects
                .iter()
                .all(|object| object["kind"] != "Secret" || object["metadata"]["name"] != name),
            "the chart must not own the caller's registry Secret"
        );
    }
}

/// On OpenShift the chart leaves the gateway's UID and fsGroup unset, so the
/// cluster's security context constraint assigns them.
#[tokio::test]
#[ignore = "pulls the pinned chart; needs NEMOCLAW_TEST_BUNDLE"]
async fn on_openshift_the_chart_leaves_the_gateway_uid_to_openshift() {
    let mut spec = spec();
    spec.settings.runtime.provider = ComputeDriver::OpenShift;
    let rendered = render(&spec, gateway::CHART)
        .await
        .expect("the pinned chart renders");
    assert_release_ownership(&rendered, &spec);
    assert!(!rendered.contains("runAsUser:"), "{rendered}");
    assert!(!rendered.contains("fsGroup:"), "{rendered}");
    assert!(rendered.contains("runAsNonRoot: true"));
}
