// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use super::Engine;
use crate::Error;

impl Engine {
    pub(super) fn connect_ssh(endpoint: &str) -> Result<Self, Error> {
        let invalid = || {
            Error::Conflict(
                "SSH engine requires ssh://[user@]host[:port] without passwords, paths or options",
            )
        };
        let url = url::Url::parse(endpoint).map_err(|_| invalid())?;
        let safe_name = |name: &str| {
            !name.starts_with('-')
                && name
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || b"._-".contains(&c))
        };
        if endpoint
            .bytes()
            .any(|c| c.is_ascii_whitespace() || c.is_ascii_control() || c == b'%')
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
            || !url.path().is_empty()
            || !safe_name(url.username())
            || url
                .host_str()
                .is_none_or(|host| !safe_name(host) || host.is_empty())
            || url.port() == Some(0)
        {
            return Err(invalid());
        }
        #[cfg(unix)]
        {
            let target = endpoint.to_owned();
            let api = bollard::Docker::connect_with_custom_transport(
                move |request: bollard::BollardRequest| {
                    let target = target.clone();
                    Box::pin(exchange(target, request))
                },
                Some("http://docker"),
                120,
                bollard::API_DEFAULT_VERSION,
            )
            .map_err(|_| Error::State("cannot configure SSH engine client"))?;
            Ok(Self {
                api,
                endpoint: endpoint.into(),
                host_observer: std::sync::Arc::new(RemoteHost),
            })
        }
        #[cfg(not(unix))]
        Err(Error::Conflict(
            "SSH engine transport is not qualified on this platform",
        ))
    }
}

#[cfg(unix)]
struct RemoteHost;
#[cfg(unix)]
#[async_trait::async_trait]
impl crate::hardware::HostObserver for RemoteHost {
    async fn observe(&self, _: &Engine) -> Result<crate::hardware::HostObservation, Error> {
        Err(Error::Conflict(
            "remote host capacity requires an explicit observer",
        ))
    }
}

#[cfg(unix)]
async fn exchange(
    target: String,
    mut request: bollard::BollardRequest,
) -> Result<hyper::Response<hyper::body::Incoming>, bollard::errors::Error> {
    use std::process::Stdio;
    let path = request
        .uri()
        .path_and_query()
        .map_or("/", |path| path.as_str())
        .to_owned();
    *request.uri_mut() = path.parse().map_err(bollard::errors::Error::from)?;
    request.headers_mut().insert(
        hyper::header::HOST,
        hyper::header::HeaderValue::from_static("docker"),
    );
    let mut child = tokio::process::Command::new("ssh")
        .args([
            "-T",
            "-o",
            "BatchMode=yes",
            "-o",
            "StrictHostKeyChecking=yes",
            "-o",
            "ConnectTimeout=10",
            "-o",
            "ControlMaster=no",
            "-o",
            "ControlPath=none",
            "--",
            &target,
            "docker",
            "system",
            "dial-stdio",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()?;
    let io = tokio::io::join(child.stdout.take().unwrap(), child.stdin.take().unwrap());
    let (mut sender, connection) =
        hyper::client::conn::http1::handshake(hyper_util::rt::TokioIo::new(io)).await?;
    // A connection belongs to this request, including streamed bodies. Closing
    // it also reaps its SSH child; there is no pool or mutation retry.
    request.headers_mut().insert(
        hyper::header::CONNECTION,
        hyper::header::HeaderValue::from_static("close"),
    );
    tokio::spawn(async move {
        let _ = tokio::time::timeout(std::time::Duration::from_secs(120), connection).await;
        let _ = child.kill().await;
        let _ = child.wait().await;
    });
    sender.send_request(request).await.map_err(Into::into)
}
