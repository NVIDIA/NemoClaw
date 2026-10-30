// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! The native OpenTofu Helm release. This module builds configuration only;
//! the bundled Helm provider owns chart installation and removal.

use super::Spec;
use crate::{Error, artifact_pins as pins};
use serde_json::{Value, json};

pub const CHART: &str = pins::GATEWAY_CHART;
pub const PROVIDER_ADDRESS: &str = "registry.opentofu.org/hashicorp/helm";
pub use pins::HELM_PROVIDER_VERSION as PROVIDER_VERSION;
pub const ADDRESS: &str = "helm_release.gateway";
pub const KUBECONFIG_VARIABLE: &str = "nemoclaw_kubeconfig";
pub const KUBECONFIG_ENV: &str = "TF_VAR_nemoclaw_kubeconfig";

/// Non-secret chart values. The issuer's keys and certificates stay in its
/// separately owned files and Kubernetes objects, never in Helm values/state.
pub fn values(spec: &Spec) -> Result<Value, Error> {
    spec.validate()?;
    let target = spec.settings.kubernetes.as_ref().ok_or(Error::State(
        "managed Kubernetes gateway settings are missing",
    ))?;
    let image = |reference: &str| {
        let (repository, digest) = reference.split_once('@').expect("pinned image reference");
        json!({"registry": "", "repository": repository, "digest": digest, "pullPolicy": "IfNotPresent"})
    };
    let name = &spec.name;
    let mut values = json!({
        "fullnameOverride": name,
        "global": {"image": {"registry": ""}},
        "gateway": {"image": image(pins::DEFAULT_GATEWAY_IMAGE)},
        "sandboxRuntime": {"image": image(pins::SANDBOX_RUNTIME_IMAGE)},
        "supervisor": {"image": image(pins::SUPERVISOR_IMAGE)},
        "sandbox": {"image": image(pins::SANDBOX_RUNTIME_IMAGE)},
        "server": {
            "telemetryEnabled": false,
            "disableTls": false,
            "tls": {
                "enableMtls": true,
                "certSecretName": format!("{name}-server-tls"),
                "clientTlsSecretName": format!("{name}-client-tls"),
            },
            "sandboxJwt": {"signingSecretName": format!("{name}-jwt-keys")},
            "credentialStorage": {"existingSecret": format!("{name}-kek")},
            // The chart mounts the issuer CA only from this value.
            "oidc": {"caConfigMapName": format!("{name}-oidc-ca")},
        },
        // Gateway configuration (schema version 2), keyed by TOML table.
        "gatewayConfig": {
            "openshell.gateway.oidc": super::issuer::oidc_values(name, &target.namespace, &spec.owner),
            "openshell.gateway.auth": {"allow_unauthenticated_users": false},
            "openshell.drivers.kubernetes": {
                "workspace_mode": "shared",
                "workspace_default_storage_size": "2Gi",
            },
        },
        "pkiInitJob": {"enabled": true},
        "resources": {
            "requests": {"cpu": "250m", "memory": "256Mi"},
            "limits": {"cpu": "1", "memory": "1Gi"},
        },
    });
    // On OpenShift, unset the gateway's UID and fsGroup as the chart's own
    // OpenShift install does, so restricted-v2 assigns the namespace's first
    // UID and group.
    if spec.settings.runtime.provider == crate::config::ComputeDriver::OpenShift {
        values["securityContext"] = json!({"runAsUser": null});
        values["podSecurityContext"] = json!({"fsGroup": null});
    }
    if !target.image_pull_secrets.is_empty() {
        values["imagePullSecrets"] = json!(
            target
                .image_pull_secrets
                .iter()
                .map(|name| json!({"name": name}))
                .collect::<Vec<_>>()
        );
        values["gatewayConfig"]["openshell.drivers.kubernetes"]["image_pull_secrets"] =
            json!(target.image_pull_secrets);
    }
    // An existing issuer's settings are authored in OpenShell's OIDC table,
    // which passes through below; its CA comes from the user's ConfigMap.
    let authentication = &target.authentication;
    if authentication.profile == crate::config::KubernetesAuthenticationProfile::Oidc {
        values["gatewayConfig"]
            .as_object_mut()
            .expect("gateway configuration tables")
            .remove(crate::managed::gateway_config::OIDC_TABLE);
        values["server"]["oidc"]["caConfigMapName"] =
            json!(authentication.ca_config_map.clone().unwrap_or_default());
    }
    // Authored tables pass through to the chart. Their fields override
    // NemoClaw's defaults in the same table; validation rejects the keys
    // NemoClaw owns.
    if let Some(config) = &spec.settings.config {
        let tables = values["gatewayConfig"]
            .as_object_mut()
            .expect("gateway configuration tables");
        for (name, fields) in config {
            match (tables.get_mut(name), fields) {
                (Some(Value::Object(defaults)), Value::Object(fields)) => {
                    defaults.extend(fields.clone());
                }
                _ => {
                    tables.insert(name.clone(), fields.clone());
                }
            }
        }
    }
    Ok(values)
}

pub(crate) fn literal(value: &str) -> String {
    value.replace("${", "$${").replace("%{", "%%{")
}

pub(crate) fn configure(graph: &mut Value, spec: &Spec) -> Result<(), Error> {
    let target = spec.settings.kubernetes.as_ref().ok_or(Error::State(
        "managed Kubernetes gateway settings are missing",
    ))?;
    graph["terraform"]["required_providers"]["helm"] = json!({
        "source": PROVIDER_ADDRESS, "version": format!("= {PROVIDER_VERSION}")
    });
    graph["variable"][KUBECONFIG_VARIABLE] = json!({
        "type": "string", "nullable": false, "sensitive": true,
    });
    graph["provider"]["helm"] = json!({
        "helm_driver": "secret",
        "registry_config_path": ".helm/registry.json",
        "repository_config_path": ".helm/repositories.yaml",
        "repository_cache": ".helm/cache",
        "plugins_path": ".helm/plugins",
        "kubernetes": {
            "config_path": format!("${{var.{KUBECONFIG_VARIABLE}}}"),
            "config_context": literal(&target.context),
        },
    });
    graph["resource"]["helm_release"]["gateway"] = json!({
        "name": literal(&spec.name),
        "namespace": literal(&target.namespace),
        "chart": CHART,
        "values": [literal(&values(spec)?.to_string())],
        "create_namespace": false,
        "take_ownership": false,
        "upgrade_install": false,
        "atomic": false,
        "cleanup_on_fail": false,
        "wait": true,
        "wait_for_jobs": true,
        "timeout": 600,
        "depends_on": ["openshell_kubernetes_auth.runtime"],
    });
    Ok(())
}
