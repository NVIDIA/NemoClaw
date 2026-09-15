// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use crate::recipe::PreparedModel;
use nemoclaw_sdk::{Error, config::Service};
use process_wrap::tokio::CommandWrap;
use std::{process::Stdio, time::Duration};
/// Backend-owned probe location. The shared supervisor owns the loading deadline.
pub(crate) struct Readiness {
    url: String,
}
pub(crate) fn launch(
    service: &Service,
    prepared: &PreparedModel,
    total_memory: u64,
) -> Result<(CommandWrap, Readiness), Error> {
    let arguments = service.arguments(
        prepared
            .model
            .to_str()
            .ok_or(Error::State("invalid model storage path"))?,
        total_memory,
    )?;
    let command = CommandWrap::with_new("python3", |cmd| {
        cmd.args(arguments)
            .envs(&prepared.environment)
            .stdin(Stdio::null())
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit());
    });
    Ok((
        command,
        Readiness {
            url: format!("http://127.0.0.1:{}/health", service.serving.port),
        },
    ))
}
pub(crate) async fn wait_ready(
    readiness: Readiness,
    ready: tokio::sync::mpsc::Sender<bool>,
) -> Result<(), Error> {
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(1))
        .redirect(reqwest::redirect::Policy::none())
        .retry(reqwest::retry::never())
        .build()
        .map_err(|_| Error::State("cannot initialize readiness transport"))?;
    loop {
        if client
            .get(&readiness.url)
            .send()
            .await
            .is_ok_and(|r| r.status() == reqwest::StatusCode::OK)
        {
            let _ = ready.send(true).await;
            return Ok(());
        }
        tokio::time::sleep(Duration::from_secs(5)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[tokio::test]
    async fn backend_readiness_requires_success_without_following_redirects() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/health", listener.local_addr().unwrap());
        let (observed_tx, mut observed) = tokio::sync::mpsc::channel(1);
        let server = tokio::spawn(async move {
            for status in ["503 Unavailable", "401 Unauthorized", "302 Found", "200 OK"] {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut request = Vec::new();
                while !request.ends_with(b"\r\n\r\n") {
                    request.push(socket.read_u8().await.unwrap());
                }
                assert!(request.starts_with(b"GET /health HTTP/1.1\r\n"));
                socket.write_all(format!("HTTP/1.1 {status}\r\nContent-Length: 0\r\nLocation: http://127.0.0.1:1/never\r\nConnection: close\r\n\r\n").as_bytes()).await.unwrap();
                observed_tx.send(status).await.unwrap();
            }
        });
        let (ready_tx, mut ready) = tokio::sync::mpsc::channel(1);
        let probe = tokio::spawn(wait_ready(Readiness { url }, ready_tx));
        for _ in 0..3 {
            assert_ne!(observed.recv().await.unwrap(), "200 OK");
            assert!(matches!(
                ready.try_recv(),
                Err(tokio::sync::mpsc::error::TryRecvError::Empty)
            ));
        }
        assert_eq!(observed.recv().await.unwrap(), "200 OK");
        assert_eq!(ready.recv().await, Some(true));
        probe.await.unwrap().unwrap();
        server.await.unwrap();
    }
}
