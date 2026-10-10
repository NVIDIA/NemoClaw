// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Reach an engine through `ssh … docker system dial-stdio`, one connection per request.
use crate::engine::Engine;
use nemoclaw_backend::Error;

pub(crate) fn connect(endpoint: &str) -> Result<Engine, Error> {
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
    Ok(Engine::new(api, endpoint))
}

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
    let mut child = command(&target)
        .args(["docker", "system", "dial-stdio"])
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

/// A non-interactive SSH command to `target` that never trusts an unknown host key.
pub fn command(target: &str) -> tokio::process::Command {
    let mut command = tokio::process::Command::new("ssh");
    command.args([
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
        target,
    ]);
    command.kill_on_drop(true);
    command
}
