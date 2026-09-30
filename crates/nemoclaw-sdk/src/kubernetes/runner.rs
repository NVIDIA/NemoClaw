// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::{Response, Spec};
use crate::{CancellationToken, ObservationError};
use process_wrap::tokio::{CommandWrap, KillOnDrop};
use std::{collections::BTreeMap, fs, path::Path, process::Stdio, time::Duration};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio_util::task::AbortOnDropHandle;

const FAILURE: ObservationError = ObservationError::Backend(
    "managed Kubernetes command failed; resources retained and private output suppressed",
);

pub(super) fn private_directory(path: &Path) -> Result<(), ObservationError> {
    if !path.is_absolute() {
        return Err(ObservationError::Query);
    }
    // Reject symlinks before opening backend state or writing executable helpers.
    for component in path.ancestors() {
        if fs::symlink_metadata(component).is_ok_and(|m| m.file_type().is_symlink()) {
            return Err(ObservationError::BindingMismatch);
        }
    }
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(path).map_err(|_| FAILURE)?;
    let metadata = fs::symlink_metadata(path).map_err(|_| FAILURE)?;
    if !metadata.is_dir() {
        return Err(ObservationError::BindingMismatch);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        if metadata.permissions().mode() & 0o077 != 0 {
            return Err(ObservationError::Permission);
        }
        // A newly created private file supplies the current UID without unsafe FFI.
        let probe = tempfile::NamedTempFile::new_in(path).map_err(|_| FAILURE)?;
        if metadata.uid() != probe.as_file().metadata().map_err(|_| FAILURE)?.uid() {
            return Err(ObservationError::Permission);
        }
    }
    Ok(())
}

fn materialize(directory: &Path) -> Result<std::path::PathBuf, ObservationError> {
    private_directory(directory)?;
    let scripts = directory.join(".backend");
    private_directory(&scripts)?;
    for (name, source) in [
        ("platform.py", include_str!("platform.py")),
        ("auth.py", include_str!("auth.py")),
        ("oidc_server.py", include_str!("oidc_server.py")),
        ("parent_watch.py", include_str!("parent_watch.py")),
        ("tunnel.py", include_str!("tunnel.py")),
    ] {
        crate::state::atomic_write(&scripts.join(name), source.as_bytes()).map_err(|_| FAILURE)?;
    }
    let sources: serde_json::Value =
        serde_json::from_str(include_str!("../../../../tools/kubernetes/sources.json"))
            .map_err(|_| FAILURE)?;
    let versions: serde_json::Value =
        serde_json::from_str(include_str!("../../../../versions.json")).map_err(|_| FAILURE)?;
    crate::state::save_json(
        &scripts.join("pins.json"),
        &serde_json::json!({"sources":sources,"versions":versions}),
    )
    .map_err(|_| FAILURE)?;
    Ok(scripts)
}

fn inherited_variable(name: &str) -> bool {
    let name = name.to_ascii_uppercase();
    ![
        "PYTHON",
        "HELM",
        "TF_",
        "TOFU_",
        "PLUGIN_",
        "NEMOCLAW_INTERNAL_",
        "NEMOCLAW_MANAGED_K8S_",
    ]
    .iter()
    .any(|prefix| name.starts_with(prefix))
        && !matches!(
            name.as_str(),
            "KUBECONFIG"
                | "KUBERNETES_MASTER"
                | "KUBERNETES_SERVICE_HOST"
                | "KUBERNETES_SERVICE_PORT"
                | "KUBERNETES_SERVICE_PORT_HTTPS"
                | super::STATE_ENV
        )
}

pub(super) fn command_environment() -> BTreeMap<String, String> {
    // Exec authentication plugins in the operator-selected kubeconfig retain
    // their customary cloud credentials. Cluster selection and helper control
    // inputs are supplied explicitly, never inherited from another operation.
    std::env::vars_os()
        .filter_map(|(name, value)| Some((name.into_string().ok()?, value.into_string().ok()?)))
        .filter(|(name, _)| inherited_variable(name))
        .collect()
}

pub async fn invoke(
    action: &str,
    spec: &Spec,
    directory: &Path,
    prior: Option<&String>,
    environment: &BTreeMap<String, String>,
    cancel: &CancellationToken,
) -> Result<Response, ObservationError> {
    if cancel.is_cancelled() {
        return Err(FAILURE);
    }
    spec.validate().map_err(|_| ObservationError::Query)?;
    let scripts = materialize(directory)?;
    let target = spec
        .settings
        .kubernetes
        .as_ref()
        .ok_or(ObservationError::Query)?;
    let kubeconfig = environment
        .get(&target.kubeconfig.env)
        .cloned()
        .or_else(|| std::env::var(&target.kubeconfig.env).ok())
        .filter(|value| !value.is_empty())
        .ok_or(ObservationError::Authentication)?;
    let mut input = serde_json::to_vec(&serde_json::json!({
        "action":action,"spec":spec,"stateDirectory":directory,"priorId":prior,"parentWatch":true,
    }))
    .map_err(|_| FAILURE)?;
    input.push(b'\n');
    let mut command = CommandWrap::with_new("python3", |command| {
        command.args(["-I", "-B", "-c", "import sys,runpy; sys.path.insert(0,sys.argv[1]); runpy.run_path(sys.argv[1]+'/platform.py',run_name='__main__')"])
            .arg(&scripts).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null())
            .env_clear().envs(command_environment()).env(&target.kubeconfig.env, kubeconfig);
    });
    command.wrap(KillOnDrop);
    #[cfg(unix)]
    command.wrap(process_wrap::tokio::ProcessGroup::leader());
    #[cfg(windows)]
    command.wrap(process_wrap::tokio::JobObject);
    let mut child = command.spawn().map_err(|_| {
        ObservationError::Backend(
            "managed Kubernetes requires existing python3, kubectl, helm, and openssl executables",
        )
    })?;
    let mut stdin = child.stdin().take().ok_or(FAILURE)?;
    let write = AbortOnDropHandle::new(tokio::spawn(async move {
        stdin.write_all(&input).await?;
        stdin.flush().await?;
        Ok::<_, std::io::Error>(stdin)
    }));
    let stdout = child.stdout().take().ok_or(FAILURE)?;
    let read = AbortOnDropHandle::new(tokio::spawn(async move {
        let mut output = Vec::new();
        stdout.take(65537).read_to_end(&mut output).await?;
        Ok::<_, std::io::Error>(output)
    }));
    // Bound the entire platform operation. Killing the group also stops helm/
    // kubectl descendants; the private receipt remains available for recovery.
    let result = tokio::select! {
        () = cancel.cancelled() => Err(FAILURE),
        result = tokio::time::timeout(Duration::from_secs(1800), async {
            // Keep the pipe open for the whole operation. If the provider is
            // killed, EOF tells the helper to kill its separate process group,
            // including any still-running helm/kubectl mutation descendants.
            let _parent_watch = write.await.map_err(|_| FAILURE)?.map_err(|_| FAILURE)?;
            let output = read.await.map_err(|_| FAILURE)?.map_err(|_| FAILURE)?;
            if output.len() > 65536 { return Err(ObservationError::Incomplete); }
            let status = child.wait().await.map_err(|_| FAILURE)?;
            if !status.success() { return Err(FAILURE); }
            serde_json::from_slice::<Response>(&output).map_err(|_| ObservationError::Incomplete)
        }) => result.map_err(|_| FAILURE).and_then(|result| result),
    };
    let _ = child.start_kill();
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exec_plugin_credentials_survive_without_ambient_target_or_helper_controls() {
        for name in [
            "PATH",
            "HOME",
            "AWS_PROFILE",
            "AWS_ACCESS_KEY_ID",
            "AWS_SECRET_ACCESS_KEY",
            "AWS_SESSION_TOKEN",
            "AZURE_CLIENT_ID",
            "AZURE_CLIENT_SECRET",
            "AZURE_TENANT_ID",
            "GOOGLE_APPLICATION_CREDENTIALS",
            "CLOUDSDK_CONFIG",
            "HTTPS_PROXY",
        ] {
            assert!(inherited_variable(name), "{name}");
        }
        for name in [
            "KUBECONFIG",
            "KUBERNETES_MASTER",
            "KUBERNETES_SERVICE_HOST",
            "KUBERNETES_SERVICE_PORT",
            "KUBERNETES_SERVICE_PORT_HTTPS",
            "PYTHONPATH",
            "PYTHONHOME",
            "HELM_NAMESPACE",
            "HELM_KUBECONTEXT",
            "HELM_PLUGINS",
            "TF_LOG",
            "TOFU_CLI_ARGS",
            "PLUGIN_PROTOCOL_VERSIONS",
            "NEMOCLAW_INTERNAL_PROGRESS_ENDPOINT",
            super::super::STATE_ENV,
            super::super::TOKEN_ENV,
            super::super::CA_ENV,
            super::super::CERT_ENV,
            super::super::KEY_ENV,
        ] {
            assert!(!inherited_variable(name), "{name}");
            assert!(!inherited_variable(&name.to_ascii_lowercase()), "{name}");
        }
    }
}
