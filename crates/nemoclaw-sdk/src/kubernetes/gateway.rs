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
    let target = spec.settings.cluster().ok_or(Error::State(
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
            // The chart sets OPENSHELL_TELEMETRY_ENABLED from this value.
            "telemetryEnabled": crate::managed::gateway_telemetry_enabled(),
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
        // The gateway's memory grows about 4 MiB per sandbox; at 1Gi it ran
        // out of memory before a document reached 256 sandboxes, and at 2Gi
        // 256 peaked near 1.2 GiB (#14403). Authored resources replace these
        // as written.
        "resources": {
            "requests": {"cpu": "250m", "memory": "256Mi"},
            "limits": {"cpu": "1", "memory": "2Gi"},
        },
    });
    if let Some(resources) = &target.resources {
        values["resources"] = serde_json::to_value(resources)
            .map_err(|_| Error::State("cannot encode gateway resources"))?;
    }
    // Without a class, the chart omits storageClassName, so the claim takes
    // the cluster's default.
    if let Some(class) = &target.data_storage_class {
        values["server"]["dataStorageClass"] = json!(class);
    }
    // An exposed gateway's own Service or Route publishes the endpoint and
    // forwards to the gateway's TLS listener, so TLS and client certificates
    // pass through unchanged. The certificate names the endpoint host clients
    // dial; the chart's always names 127.0.0.1 and in-cluster names.
    if let Some(expose) = &target.expose {
        let endpoint = url::Url::parse(&expose.endpoint)
            .map_err(|_| Error::State("invalid managed Kubernetes endpoint"))?;
        // The Service publishes the endpoint's port on every node. The
        // plaintext metrics port stays unpublished: with metrics disabled, the
        // chart serves no metrics.
        if let Some(service) = &expose.service {
            let port = endpoint
                .port_or_known_default()
                .ok_or(Error::State("managed Kubernetes endpoint has no port"))?;
            values["service"] = json!({
                "type": service.service_type.as_str(),
                "nodePort": port,
            });
            values["metrics"] = json!({"enabled": false});
        }
        // The Route passes TLS through the cluster's router by SNI to the
        // chart's ClusterIP Service, at whatever port the router serves.
        if let Some(route) = &expose.route {
            values["openshiftRoute"] = json!({
                "enabled": true,
                "host": endpoint.host_str(),
                "annotations": route.annotations,
            });
        }
        match endpoint.host() {
            Some(url::Host::Domain(name)) => {
                values["pkiInitJob"]["serverDnsNames"] = json!([name]);
            }
            Some(url::Host::Ipv4(address)) if !address.is_loopback() => {
                values["pkiInitJob"]["serverIpAddresses"] = json!([address.to_string()]);
            }
            _ => {}
        }
    }
    // On OpenShift, unset the gateway's UID and fsGroup, and the shared
    // supervisor's UID, group, and fsGroup, as the chart's OpenShift overlay
    // (ci/values-openshift-scc.yaml) does, so restricted-v2 assigns the
    // namespace's first UID and group. The chart renders the shared
    // supervisor only when spec.gateway.config selects
    // supervisor_topology = "gateway". Once the chart handles OpenShift's IDs
    // itself (NVIDIA/OpenShell#5483), these values go and the target stays.
    if matches!(
        spec.settings.target,
        crate::config::ManagedTarget::OpenShift(_)
    ) {
        values["securityContext"] = json!({"runAsUser": null});
        values["podSecurityContext"] = json!({"fsGroup": null});
        values["supervisor"]["podSecurityContext"] =
            json!({"runAsUser": null, "runAsGroup": null, "fsGroup": null});
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
    let target = spec.settings.cluster().ok_or(Error::State(
        "managed Kubernetes gateway settings are missing",
    ))?;
    graph["terraform"]["required_providers"]["helm"] = json!({
        "source": PROVIDER_ADDRESS, "version": format!("= {PROVIDER_VERSION}")
    });
    graph["provider"]["helm"] = json!({
        "helm_driver": "secret",
        "registry_config_path": ".helm/registry.json",
        "repository_config_path": ".helm/repositories.yaml",
        "repository_cache": ".helm/cache",
        "plugins_path": ".helm/plugins",
    });
    // Without a kubeconfig, the provider's client loads the service account
    // of the pod that runs NemoClaw.
    if let Some(context) = &target.context {
        graph["variable"][KUBECONFIG_VARIABLE] = json!({
            "type": "string", "nullable": false, "sensitive": true,
        });
        graph["provider"]["helm"]["kubernetes"] = json!({
            "config_path": format!("${{var.{KUBECONFIG_VARIABLE}}}"),
            "config_context": literal(context),
        });
    }
    graph["resource"]["helm_release"]["gateway"] = json!({
        "name": literal(&spec.name),
        "namespace": literal(&target.namespace),
        "chart": CHART,
        "values": [literal(&values(spec)?.to_string())],
        "create_namespace": false,
        "take_ownership": false,
        "upgrade_install": false,
        // When the install fails or times out, Helm uninstalls the release
        // before the provider returns, so a failed apply leaves no release
        // that the state does not bind (#14155). The uninstall removes only
        // the chart's objects; retained storage is outside them. When an
        // upgrade fails, Helm rolls the release back, which removes what the
        // upgrade created, so cleanup_on_fail adds nothing.
        "atomic": true,
        "cleanup_on_fail": false,
        "wait": true,
        "wait_for_jobs": true,
        "timeout": 600,
        "depends_on": ["openshell_kubernetes_auth.runtime"],
    });
    Ok(())
}
