// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! The OpenShell gateway release, installed with Helm.
//!
//! Helm is the only cluster subprocess. It runs with the authored kubeconfig
//! and context, the pinned chart, and an environment cleared of the caller's
//! Helm and cluster settings, so a stray `HELM_NAMESPACE` or `KUBECONFIG`
//! cannot redirect it.

use crate::{ObservationError, artifact_pins as pins};
use serde_json::{Value, json};
use std::{path::PathBuf, process::Stdio, time::Duration};

/// The pinned OpenShell chart, by digest.
pub const CHART: &str = pins::GATEWAY_CHART;

/// One deployment's gateway release.
pub struct Release {
    /// The `helm` executable.
    pub helm: PathBuf,
    /// Private directory for the values file and Helm's own state.
    pub state: PathBuf,
    pub kubeconfig: PathBuf,
    pub context: String,
    pub namespace: String,
    /// Release name and chart `fullnameOverride`.
    pub name: String,
    /// `server.oidc` chart values for the development issuer, if any.
    pub oidc: Option<Value>,
    /// On OpenShift, the UID and group the namespace assigns; the chart's
    /// fixed 1000 would be refused there.
    pub identity: Option<Identity>,
}

/// The user and group OpenShift assigns a namespace's pods.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Identity {
    pub user: u32,
    pub group: u32,
}

impl Identity {
    /// The first UID of `openshift.io/sa.scc.uid-range` and the first group
    /// of `openshift.io/sa.scc.supplemental-groups`, falling back to the UID,
    /// as OpenShell itself chooses for sandboxes. Both read `START/SIZE`.
    pub fn from_annotations(
        annotations: &std::collections::BTreeMap<String, String>,
    ) -> Option<Self> {
        let first = |key: &str| {
            let (start, size) = annotations.get(key)?.split_once('/')?;
            let (start, size) = (start.parse::<u32>().ok()?, size.parse::<u32>().ok()?);
            (start > 0 && size > 0 && start.checked_add(size).is_some()).then_some(start)
        };
        let user = first("openshift.io/sa.scc.uid-range")?;
        let group = match annotations.get("openshift.io/sa.scc.supplemental-groups") {
            Some(_) => first("openshift.io/sa.scc.supplemental-groups")?,
            None => user,
        };
        Some(Self { user, group })
    }
}

const FAILED: ObservationError = ObservationError::Backend(
    "Helm could not install or remove the OpenShell gateway; its output was suppressed and resources retained",
);

/// Chart values: every image pinned by digest, mutual TLS on, unauthenticated
/// users refused, and the credential key from storage.
pub fn values(release: &Release) -> Value {
    let image = |reference: &str, policy: &str| {
        let (repository, digest) = reference.split_once('@').expect("pinned image reference");
        json!({"registry": "", "repository": repository, "digest": digest, "pullPolicy": policy})
    };
    let name = &release.name;
    let mut values = json!({
        "fullnameOverride": name,
        "global": {"image": {"registry": ""}},
        "gateway": {"image": image(pins::DEFAULT_GATEWAY_IMAGE, "IfNotPresent")},
        "sandboxRuntime": {"image": image(pins::SANDBOX_RUNTIME_IMAGE, "IfNotPresent")},
        "supervisor": {"image": image(pins::SUPERVISOR_IMAGE, "IfNotPresent")},
        "sandbox": {"image": image(pins::SANDBOX_RUNTIME_IMAGE, "IfNotPresent")},
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
        },
        "pkiInitJob": {"enabled": true},
        "resources": {
            "requests": {"cpu": "250m", "memory": "256Mi"},
            "limits": {"cpu": "1", "memory": "1Gi"},
        },
    });
    if let Some(oidc) = &release.oidc {
        values["server"]["oidc"] = oidc.clone();
    }
    if let Some(identity) = release.identity {
        values["securityContext"] = json!({"runAsUser": identity.user});
        values["podSecurityContext"] = json!({"fsGroup": identity.group});
    }
    values
}

/// Install or upgrade the gateway and wait for it to become ready.
pub async fn install(release: &Release) -> Result<(), ObservationError> {
    std::fs::create_dir_all(&release.state).map_err(|_| ObservationError::Incomplete)?;
    let values = release.state.join("gateway-values.json");
    crate::state::save_json(&values, &self::values(release))
        .map_err(|_| ObservationError::Incomplete)?;
    let values = values.to_string_lossy().into_owned();
    helm(
        release,
        &[
            "upgrade",
            "--install",
            &release.name,
            CHART,
            "-f",
            &values,
            "--wait",
            "--timeout",
            "10m",
        ],
        Duration::from_secs(660),
    )
    .await
}

/// Remove the gateway release and wait for its objects to go. Storage and
/// the chart's kept Secrets remain.
pub async fn uninstall(release: &Release) -> Result<(), ObservationError> {
    helm(
        release,
        &["uninstall", &release.name, "--wait", "--timeout", "5m"],
        Duration::from_secs(330),
    )
    .await
}

async fn helm(
    release: &Release,
    arguments: &[&str],
    limit: Duration,
) -> Result<(), ObservationError> {
    let home = release.state.join("helm");
    let mut command = tokio::process::Command::new(&release.helm);
    command
        .args(arguments)
        .arg("--kubeconfig")
        .arg(&release.kubeconfig)
        .args([
            "--kube-context",
            &release.context,
            "--namespace",
            &release.namespace,
        ])
        .env_clear()
        // Helm keeps its cache, configuration and registry logins here, apart
        // from the caller's own Helm setup.
        .env("HELM_CACHE_HOME", home.join("cache"))
        .env("HELM_CONFIG_HOME", home.join("config"))
        .env("HELM_DATA_HOME", home.join("data"))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    // Exec credential plugins in the kubeconfig still need the caller's PATH
    // and home directory, as kubectl gives them.
    for name in [
        "PATH",
        "HOME",
        "USERPROFILE",
        "SYSTEMROOT",
        "TMPDIR",
        "TEMP",
        "TMP",
    ] {
        if let Some(value) = std::env::var_os(name) {
            command.env(name, value);
        }
    }
    let status = tokio::time::timeout(limit, command.status())
        .await
        .map_err(|_| FAILED)?
        .map_err(|_| {
            ObservationError::Backend("managed Kubernetes requires the helm executable")
        })?;
    if status.success() {
        Ok(())
    } else {
        Err(FAILED)
    }
}
