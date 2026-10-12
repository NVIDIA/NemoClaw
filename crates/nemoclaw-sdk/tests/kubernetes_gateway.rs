// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Non-secret gateway chart values. nemoclaw-e2e's kubernetes_chart renders
//! them with the pinned chart.

use nemoclaw_sdk::kubernetes::{GATEWAY_KIND, Spec, gateway, gateway::Identity};
use serde_json::json;

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
    assert_eq!(
        values["gatewayConfig"]["openshell.gateway.auth"],
        json!({"allow_unauthenticated_users": false})
    );
    assert_eq!(values["server"]["disableTls"], false);
    assert_eq!(values["server"]["tls"]["enableMtls"], true);
    assert_eq!(values["server"]["telemetryEnabled"], false);
}

#[test]
fn chart_authentication_values_contain_only_references_and_public_policy() {
    let spec = spec();
    let values = gateway::values(&spec).unwrap();
    let server = values["server"].clone();
    // Settings the chart reads only through its legacy server.* mapping belong
    // in gatewayConfig; server keeps the values its templates read directly.
    let mut keys: Vec<_> = server.as_object().unwrap().keys().cloned().collect();
    keys.sort();
    assert_eq!(
        keys,
        [
            "credentialStorage",
            "disableTls",
            "oidc",
            "sandboxJwt",
            "telemetryEnabled",
            "tls"
        ]
    );
    // Exact shapes reject additional inline keys, certificates, tokens, or
    // credential-storage data before they can enter native Helm state.
    assert_eq!(
        server["tls"],
        json!({
            "enableMtls": true,
            "certSecretName": format!("{}-server-tls", spec.name),
            "clientTlsSecretName": format!("{}-client-tls", spec.name),
        })
    );
    assert_eq!(
        server["sandboxJwt"],
        json!({"signingSecretName": format!("{}-jwt-keys", spec.name)})
    );
    assert_eq!(
        server["credentialStorage"],
        json!({"existingSecret": format!("{}-kek", spec.name)})
    );
    assert_eq!(
        server["oidc"],
        json!({"caConfigMapName": format!("{}-oidc-ca", spec.name)})
    );
    assert_eq!(
        values["gatewayConfig"],
        json!({
            "openshell.gateway.oidc": {
                "issuer": format!("https://{}-oidc.agents.svc.cluster.local:8443", spec.name),
                "audience": spec.owner,
                "jwks_ttl_secs": 60,
                "roles_claim": "roles",
                "admin_role": "nemoclaw-development-admin",
                "user_role": "nemoclaw-development-user",
                "scopes_claim": "scope",
                "dangerously_allow_insecure_http": false,
            },
            "openshell.gateway.auth": {"allow_unauthenticated_users": false},
            "openshell.drivers.kubernetes": {
                "workspace_mode": "shared",
                "workspace_default_storage_size": "2Gi",
            },
        })
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
