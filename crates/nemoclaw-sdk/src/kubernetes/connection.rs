// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::{CA_ENV, CERT_ENV, GATEWAY_KIND, KEY_ENV, Spec, TOKEN_ENV, runner};
use crate::{
    CancellationToken, Error, ObservationError, Secrets,
    compile::Generations,
    config::{Credential, Document, ExternalGateway, Gateway, TLS},
};
use process_wrap::tokio::{ChildWrapper, CommandWrap, KillOnDrop};
use std::{collections::BTreeMap, path::Path, process::Stdio, sync::Arc, time::Duration};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};
use tokio_util::task::AbortOnDropHandle;

/// Holds the command-scoped loopback tunnel and in-memory credential references.
/// Dropping this guard terminates the tunnel and all its subprocesses.
pub struct Connection {
    child: Box<dyn ChildWrapper>,
    _custody: tokio::process::ChildStdin,
    _drain: AbortOnDropHandle<()>,
    environment: BTreeMap<String, String>,
    endpoint: String,
}
impl Connection {
    pub fn environment(&self) -> BTreeMap<String, String> {
        self.environment.clone()
    }
    /// Connection settings for the command-scoped gateway tunnel.
    /// Keep this guard alive while using the gateway.
    pub fn gateway(&self) -> Gateway {
        client_gateway(&self.endpoint)
    }

    /// Resolve this connection's credentials without process-global mutation.
    pub fn secrets(&self, fallback: Arc<dyn Secrets>) -> Arc<dyn Secrets> {
        Arc::new(ClientSecrets {
            environment: self.environment.clone(),
            fallback,
        })
    }
}

fn client_gateway(endpoint: &str) -> Gateway {
    let reference = |name: &str| Credential { env: name.into() };
    Gateway::External(ExternalGateway {
        engine: String::new(),
        endpoint: endpoint.into(),
        credential: Some(reference(TOKEN_ENV)),
        tls: Some(TLS {
            ca: reference(CA_ENV),
            certificate: reference(CERT_ENV),
            key: reference(KEY_ENV),
        }),
    })
}

struct ClientSecrets {
    environment: BTreeMap<String, String>,
    fallback: Arc<dyn Secrets>,
}
impl Secrets for ClientSecrets {
    fn resolve(&self, name: &str) -> Result<String, ObservationError> {
        if name.starts_with("NEMOCLAW_MANAGED_K8S_") {
            return self
                .environment
                .get(name)
                .filter(|value| !value.is_empty())
                .cloned()
                .ok_or(ObservationError::Authentication);
        }
        self.fallback.resolve(name)
    }
}
impl Drop for Connection {
    fn drop(&mut self) {
        let _ = self.child.start_kill();
    }
}

fn validate_environment(
    environment: &BTreeMap<String, String>,
    directory: &Path,
) -> Result<(), ObservationError> {
    if environment.len() != 4
        || [TOKEN_ENV, CA_ENV, CERT_ENV, KEY_ENV].iter().any(|key| {
            environment
                .get(*key)
                .is_none_or(|value| value.is_empty() || value.contains(['\0', '\r', '\n']))
        })
    {
        return Err(ObservationError::Incomplete);
    }
    let directory = directory
        .canonicalize()
        .map_err(|_| ObservationError::Authentication)?;
    for key in [CA_ENV, CERT_ENV, KEY_ENV] {
        let path = Path::new(&environment[key]);
        let meta = std::fs::symlink_metadata(path).map_err(|_| ObservationError::Authentication)?;
        if !meta.is_file()
            || meta.file_type().is_symlink()
            || !path
                .canonicalize()
                .map_err(|_| ObservationError::Authentication)?
                .starts_with(&directory)
        {
            return Err(ObservationError::BindingMismatch);
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if meta.permissions().mode() & 0o077 != 0 {
                return Err(ObservationError::Permission);
            }
        }
    }
    Ok(())
}

pub async fn connection(
    document: &Document,
    generations: &Generations,
    state_directory: &Path,
    secrets: &dyn Secrets,
    cancel: &CancellationToken,
) -> Result<Connection, Error> {
    let settings = document
        .spec
        .gateway
        .as_managed()
        .ok_or(ObservationError::Query)?;
    let target = settings
        .kubernetes
        .as_ref()
        .ok_or(ObservationError::Query)?;
    let spec = Spec {
        layout: 1,
        kind: GATEWAY_KIND.into(),
        name: format!("{}-gateway", document.workspace()),
        owner: document.metadata.uid.clone(),
        generation: generations
            .get(GATEWAY_KIND)
            .ok_or(ObservationError::Incomplete)?
            .clone(),
        settings: settings.clone(),
    };
    spec.validate()?;
    let directory = std::path::absolute(state_directory)
        .map_err(|_| Error::State("cannot resolve Kubernetes state"))?
        .join("kubernetes");
    let kubeconfig = secrets.resolve(&target.kubeconfig.env)?;
    let response = runner::invoke(
        "connection",
        &spec,
        &directory,
        None,
        &BTreeMap::from([(target.kubeconfig.env.clone(), kubeconfig.clone())]),
        cancel,
    )
    .await?;
    if let Some(error) = response.error() {
        return Err(error.into());
    }
    validate_environment(&response.environment, &directory)?;
    let endpoint = url::Url::parse(&settings.endpoint).map_err(|_| ObservationError::Query)?;
    let port = endpoint
        .port_or_known_default()
        .ok_or(ObservationError::Query)?;
    // Fail on an occupied port before starting kubectl. Readiness must come from
    // this child, never from another process already listening on the port.
    let listener = std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port))
        .map_err(|_| Error::Conflict("managed Kubernetes loopback port is already in use"))?;
    drop(listener);
    let mut command = CommandWrap::with_new("python3", |command| {
        command
            .args(["-I", "-B", "-c", "import sys,runpy; p=sys.argv.pop(1); sys.path.insert(0,p); runpy.run_path(p+'/tunnel.py',run_name='__main__')"])
            .arg(directory.join(".backend"))
            .args([
                "kubectl",
                "--kubeconfig",
                &kubeconfig,
                "--context",
                &target.context,
                "--namespace",
                &target.namespace,
                "port-forward",
                "--address",
                "127.0.0.1",
            ])
            .arg(format!("service/{}", spec.name))
            .arg(format!("{port}:8080"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .env_clear()
            .envs(runner::command_environment());
    });
    command.wrap(KillOnDrop);
    #[cfg(unix)]
    command.wrap(process_wrap::tokio::ProcessGroup::leader());
    #[cfg(windows)]
    command.wrap(process_wrap::tokio::JobObject);
    let mut child = command.spawn().map_err(|_| ObservationError::Transport)?;
    let custody = child.stdin().take().ok_or(ObservationError::Transport)?;
    let mut output = BufReader::new(child.stdout().take().ok_or(ObservationError::Transport)?);
    let expected = format!("Forwarding from 127.0.0.1:{port} -> 8080");
    let ready = async {
        let mut line = String::new();
        (&mut output)
            .take(1024)
            .read_line(&mut line)
            .await
            .map_err(|_| ObservationError::Transport)?;
        if line.trim() != expected {
            return Err(ObservationError::Transport);
        }
        Ok(())
    };
    tokio::select! {
        () = cancel.cancelled() => return Err(Error::Cancelled),
        result = tokio::time::timeout(Duration::from_secs(30), ready) => result.map_err(|_| ObservationError::Transport)??,
    }
    let drain = AbortOnDropHandle::new(tokio::spawn(async move {
        let _ = tokio::io::copy(&mut output, &mut tokio::io::sink()).await;
    }));
    Ok(Connection {
        child,
        _custody: custody,
        _drain: drain,
        environment: response.environment,
        endpoint: settings.endpoint.clone(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn managed_client_keeps_generated_auth_and_original_inference_credentials_separate() {
        struct OriginalSecrets;
        impl Secrets for OriginalSecrets {
            fn resolve(&self, _: &str) -> Result<String, ObservationError> {
                Ok("original-credential".into())
            }
        }
        let secrets = ClientSecrets {
            environment: BTreeMap::from([(TOKEN_ENV.into(), "generated-token".into())]),
            fallback: Arc::new(OriginalSecrets),
        };
        assert_eq!(secrets.resolve(TOKEN_ENV).unwrap(), "generated-token");
        assert_eq!(
            secrets.resolve("NVIDIA_API_KEY").unwrap(),
            "original-credential"
        );
        // Missing generated material must never pick up an ambient credential,
        // including one with the same reference in the caller's secret store.
        for missing in [CA_ENV, CERT_ENV, KEY_ENV, "NEMOCLAW_MANAGED_K8S_OTHER"] {
            assert_eq!(
                secrets.resolve(missing),
                Err(ObservationError::Authentication)
            );
        }
        let gateway = client_gateway("https://127.0.0.1:17671");
        assert_eq!(gateway.endpoint(), "https://127.0.0.1:17671");
        assert_eq!(gateway.credential().unwrap().env, TOKEN_ENV);
        let tls = gateway.tls().unwrap();
        assert_eq!(tls.ca.env, CA_ENV);
        assert_eq!(tls.certificate.env, CERT_ENV);
        assert_eq!(tls.key.env, KEY_ENV);
    }
    #[test]
    fn connection_never_accepts_helper_control_environment() {
        let mut env = BTreeMap::from([
            (TOKEN_ENV.into(), "token".into()),
            (CA_ENV.into(), "ca".into()),
            (CERT_ENV.into(), "cert".into()),
            (KEY_ENV.into(), "key".into()),
        ]);
        env.insert("KUBECONFIG".into(), "another-cluster".into());
        assert_eq!(
            validate_environment(&env, Path::new("/unused")),
            Err(ObservationError::Incomplete)
        );
    }
}
