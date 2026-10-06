// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Non-secret gateway chart values and rendering through the bundled Helm
//! provider. Neither test setup nor rendering needs a Helm executable.

use nemoclaw_sdk::{
    bundle::Bundle,
    kubernetes::{GATEWAY_KIND, Spec, gateway},
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

#[test]
fn the_chart_values_pin_every_image_by_digest_and_require_authentication() {
    let values = gateway::values(&spec()).unwrap();
    assert_eq!(values["fullnameOverride"], "nc-0123456789abcdef-gateway");
    for image in ["gateway", "sandboxRuntime", "supervisor", "sandbox"] {
        let image = &values[image]["image"];
        let digest = image["digest"].as_str().unwrap();
        assert!(digest.starts_with("sha256:") && digest.len() == 71);
        assert!(digest[7..].bytes().all(|byte| byte.is_ascii_hexdigit()));
        assert_eq!(image["pullPolicy"], "IfNotPresent");
        assert!(image.get("tag").is_none(), "mutable image tags are absent");
    }
    assert_eq!(values["server"]["auth"]["allowUnauthenticatedUsers"], false);
    assert_eq!(values["server"]["disableTls"], false);
    assert_eq!(values["server"]["tls"]["enableMtls"], true);
    assert_eq!(values["server"]["telemetryEnabled"], false);
    for (pointer, suffix) in [
        ("/server/credentialStorage/existingSecret", "kek"),
        ("/server/tls/certSecretName", "server-tls"),
        ("/server/tls/clientTlsSecretName", "client-tls"),
        ("/server/sandboxJwt/signingSecretName", "jwt-keys"),
        ("/server/oidc/caConfigMapName", "oidc-ca"),
    ] {
        assert_eq!(
            values.pointer(pointer).unwrap(),
            &json!(format!("nc-0123456789abcdef-gateway-{suffix}"))
        );
    }
    assert_eq!(
        values["server"]["oidc"]["issuer"],
        "https://nc-0123456789abcdef-gateway-oidc.agents.svc.cluster.local:8443"
    );
    assert!(
        !values.to_string().contains("PRIVATE KEY"),
        "generated private material does not belong in Helm values",
    );
}

#[test]
fn invalid_managed_identity_cannot_produce_chart_values() {
    let valid = spec();
    for broken in [
        Spec {
            name: "unowned-release".into(),
            ..valid.clone()
        },
        Spec {
            owner: "missing-owner".into(),
            ..valid.clone()
        },
        Spec {
            generation: String::new(),
            ..valid.clone()
        },
    ] {
        assert!(gateway::values(&broken).is_err());
    }
    let mut missing_target = valid;
    missing_target.settings.kubernetes = None;
    assert!(gateway::values(&missing_target).is_err());
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
#[tokio::test]
#[ignore = "pulls the pinned chart; needs NEMOCLAW_TEST_BUNDLE"]
async fn the_pinned_chart_renders_with_the_sdk_values() {
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
    let spec = spec();
    let mut values = gateway::values(&spec).unwrap();
    // Rendering has no cluster from which to observe this existing prerequisite.
    values["agentSandbox"]["preflight"]["enabled"] = json!(false);
    let mut graph = json!({
        "terraform": {"required_providers": {"helm": {
            "source": gateway::PROVIDER_ADDRESS,
            "version": format!("= {}", gateway::PROVIDER_VERSION)
        }}},
        "provider": {"helm": {}},
        "data": {"helm_template": {"gateway": {
            "name": spec.name, "namespace": "agents", "chart": gateway::CHART,
            "validate": false, "values": [values.to_string()]
        }}},
        "output": {"manifest": {"value": "${data.helm_template.gateway.manifest}"}}
    });
    let config = directory.path().join("main.tf.json");
    fs::write(&config, serde_json::to_vec(&graph).unwrap()).unwrap();
    for arguments in [
        vec!["init", "-input=false", "-no-color"],
        vec!["plan", "-input=false", "-no-color", "-out=render.tfplan"],
    ] {
        let output = tofu(&bundle, directory.path(), &arguments).await;
        assert!(
            output.status.success(),
            "OpenTofu {} failed; raw output suppressed",
            arguments[0]
        );
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
    let rendered = plan["planned_values"]["outputs"]["manifest"]["value"]
        .as_str()
        .unwrap();
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
    graph["data"]["helm_template"]["gateway"]["chart"] = json!(format!(
        "oci://ghcr.io/nvidia/openshell/helm-chart@sha256:{}",
        "0".repeat(64)
    ));
    fs::write(&config, serde_json::to_vec(&graph).unwrap()).unwrap();
    let rejected = tofu(
        &bundle,
        directory.path(),
        &["plan", "-input=false", "-no-color"],
    )
    .await;
    assert!(
        !rejected.status.success(),
        "the provider refuses an unavailable chart digest"
    );
}
