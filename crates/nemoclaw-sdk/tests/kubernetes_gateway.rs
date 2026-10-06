// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Non-secret gateway chart values and rendering through the bundled Helm
//! provider. Neither test setup nor rendering needs a Helm executable.

use nemoclaw_sdk::{
    bundle::Bundle,
    config::ComputeDriver,
    kubernetes::{GATEWAY_KIND, Spec, gateway, gateway::Identity},
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
async fn render(spec: &Spec, chart: &str, identity: Option<Identity>) -> Option<String> {
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
    let mut chart_values = vec![values.to_string()];
    if let Some(identity) = identity {
        // Apply the observed namespace identity as a second values document,
        // just as the native release receives the authentication resource's output.
        chart_values.push(identity.values().to_string());
    }
    let graph = json!({
        "terraform": {"required_providers": {"helm": {
            "source": gateway::PROVIDER_ADDRESS,
            "version": format!("= {}", gateway::PROVIDER_VERSION)
        }}},
        "provider": {"helm": {}},
        "data": {"helm_template": {"gateway": {
            "name": spec.name, "namespace": "agents", "chart": chart,
            "validate": false, "values": chart_values
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

#[tokio::test]
#[ignore = "pulls the pinned chart; needs NEMOCLAW_TEST_BUNDLE"]
async fn the_pinned_chart_renders_with_the_sdk_values() {
    let spec = spec();
    let values = gateway::values(&spec).unwrap();
    let rendered = render(&spec, gateway::CHART, None)
        .await
        .expect("the pinned chart renders");
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
        render(&spec, &unavailable, None).await.is_none(),
        "the provider refuses an unavailable chart digest"
    );
}

/// OpenShift assigns the gateway a UID from its namespace's range.
#[tokio::test]
#[ignore = "pulls the pinned chart; needs NEMOCLAW_TEST_BUNDLE"]
async fn on_openshift_the_gateway_takes_the_namespace_uid() {
    let mut spec = spec();
    spec.settings.runtime.provider = ComputeDriver::OpenShift;
    let identity = Identity {
        user: 1_000_680_000,
        group: 1_000_690_000,
    };
    let rendered = render(&spec, gateway::CHART, Some(identity))
        .await
        .expect("the pinned chart renders");
    assert!(rendered.contains("runAsUser: 1000680000"), "{rendered}");
    assert!(rendered.contains("fsGroup: 1000690000"), "{rendered}");
    assert!(!rendered.contains("runAsUser: 1000\n"));
    assert!(rendered.contains("runAsNonRoot: true"));
}

#[test]
fn the_namespace_identity_is_the_first_uid_and_group_of_its_ranges() {
    let annotations = |uid: &str, groups: Option<&str>| {
        let mut map = std::collections::BTreeMap::from([(
            "openshift.io/sa.scc.uid-range".to_owned(),
            uid.to_owned(),
        )]);
        if let Some(groups) = groups {
            map.insert(
                "openshift.io/sa.scc.supplemental-groups".into(),
                groups.into(),
            );
        }
        map
    };
    assert_eq!(
        Identity::from_annotations(&annotations("1000680000/10000", Some("1000690000/10000"))),
        Some(Identity {
            user: 1_000_680_000,
            group: 1_000_690_000,
        })
    );
    assert_eq!(
        Identity::from_annotations(&annotations("1000680000/10000", None)),
        Some(Identity {
            user: 1_000_680_000,
            group: 1_000_680_000,
        }),
        "without supplemental groups, the group is the user's"
    );
    for bad in [
        "",
        "0/10000",
        "1000680000",
        "x/1",
        "-1/10000",
        "1000680000/0",
        "4294967295/2",
        "1000680000/10000/1",
    ] {
        assert_eq!(
            Identity::from_annotations(&annotations(bad, None)),
            None,
            "invalid UID range {bad:?}"
        );
        assert_eq!(
            Identity::from_annotations(&annotations("1000680000/10000", Some(bad))),
            None,
            "invalid supplemental group range {bad:?} must not fall back to the UID"
        );
    }
    assert_eq!(Identity::from_annotations(&Default::default()), None);
}
