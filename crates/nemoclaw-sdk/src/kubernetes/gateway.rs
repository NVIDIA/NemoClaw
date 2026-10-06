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
            "auth": {"allowUnauthenticatedUsers": false},
            "tls": {
                "enableMtls": true,
                "certSecretName": format!("{name}-server-tls"),
                "clientTlsSecretName": format!("{name}-client-tls"),
            },
            "sandboxJwt": {"signingSecretName": format!("{name}-jwt-keys")},
            "credentialStorage": {"existingSecret": format!("{name}-kek")},
            "workspaceDefaultStorageSize": "2Gi",
            "drivers": {"kubernetes": {"workspaceMode": "shared"}},
            "oidc": super::issuer::oidc_values(name, &target.namespace, &spec.owner),
        },
        "pkiInitJob": {"enabled": true},
        "resources": {
            "requests": {"cpu": "250m", "memory": "256Mi"},
            "limits": {"cpu": "1", "memory": "1Gi"},
        },
    });
    if spec.settings.runtime.provider == crate::config::ComputeDriver::OpenShift {
        // OpenShift assigns a namespace UID. Null removes the chart's fixed
        // user and group while retaining its other security settings.
        values["securityContext"] = json!({"runAsUser": null});
        values["podSecurityContext"] = json!({"fsGroup": null});
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
        "depends_on": ["nemoclaw_kubernetes_auth.runtime"],
    });
    Ok(())
}
