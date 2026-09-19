// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use super::recipe::PreparedModel;
use crate::{Error, services::installers::vllm::Service};
use process_wrap::tokio::CommandWrap;
use std::{process::Stdio, time::Duration};
/// Backend-owned probe location. The shared supervisor owns the loading deadline.
pub(crate) struct Readiness {
    url: String,
    credential: Option<String>,
}
pub(crate) fn launch(
    service: &Service,
    prepared: &PreparedModel,
    total_memory: u64,
    credential: Option<String>,
) -> Result<(CommandWrap, Readiness), Error> {
    if service.authentication.is_some() != credential.is_some() {
        return Err(Error::State(
            "managed authentication credential is missing or unexpected",
        ));
    }
    let arguments = service.arguments(
        prepared
            .model
            .to_str()
            .ok_or(Error::State("invalid model storage path"))?,
        total_memory,
    )?;
    let command = CommandWrap::with_new("python3", |cmd| {
        cmd.env_remove("VLLM_API_KEY");
        if let Some(key) = &credential {
            cmd.env("VLLM_API_KEY", key);
        }
        cmd.args(arguments)
            .envs(&prepared.environment)
            .stdin(Stdio::null())
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit());
    });
    Ok((
        command,
        Readiness {
            url: format!(
                "http://127.0.0.1:{}/{}",
                service.serving.port,
                if credential.is_some() {
                    "v1/models"
                } else {
                    "health"
                }
            ),
            credential,
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
        let mut request = client.get(&readiness.url);
        if let Some(key) = &readiness.credential {
            request = request.bearer_auth(key);
        }
        if request
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
    async fn bearer_key_reaches_only_the_backend_child_and_authenticated_readiness() {
        let root = tempfile::tempdir().unwrap();
        let mut document = crate::config::Document::parse(
            include_str!("../../../../../tests/fixtures/config/spark.yaml").as_bytes(),
        )
        .unwrap();
        let crate::services::ServiceDefinition::Vllm(mut service) =
            document.spec.services.remove("qwen").unwrap()
        else {
            panic!("expected vLLM service");
        };
        service.authentication =
            Some(crate::services::installers::vllm::ServiceAuthentication::Bearer);
        let key = super::super::authentication::load(root.path()).unwrap();
        let bin = root.path().join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        let python = bin.join("python3");
        // A disposable executable stands in for Python/vLLM and verifies the
        // process boundary. The readiness fixture independently checks HTTP.
        std::fs::write(
            &python,
            "#!/bin/sh\ntest \"$VLLM_API_KEY\" = \"$(/bin/cat \"$TEST_KEY_FILE\")\"\n",
        )
        .unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut permissions = std::fs::metadata(&python).unwrap().permissions();
            permissions.set_mode(0o755);
            std::fs::set_permissions(&python, permissions).unwrap();
        }
        let prepared = PreparedModel {
            model: root.path().join("model"),
            environment: [
                ("PATH".into(), bin.into_os_string()),
                (
                    "TEST_KEY_FILE".into(),
                    root.path().join("inference-key").into_os_string(),
                ),
            ]
            .into(),
        };
        assert!(launch(&service, &prepared, 121 * crate::hardware::GIB, None).is_err());
        let (mut command, mut readiness) = launch(
            &service,
            &prepared,
            121 * crate::hardware::GIB,
            Some(key.clone()),
        )
        .unwrap();
        assert!(command.spawn().unwrap().wait().await.unwrap().success());
        assert!(readiness.url.ends_with("/v1/models"));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        readiness.url = format!("http://{}/v1/models", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            while !request.ends_with(b"\r\n\r\n") {
                request.push(socket.read_u8().await.unwrap());
            }
            let request = String::from_utf8(request).unwrap();
            assert!(request.starts_with("GET /v1/models HTTP/1.1"));
            assert!(request.contains(&format!("authorization: Bearer {key}\r\n")));
            socket
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                .await
                .unwrap();
        });
        let (tx, mut rx) = tokio::sync::mpsc::channel(1);
        wait_ready(readiness, tx).await.unwrap();
        assert_eq!(rx.recv().await, Some(true));
        server.await.unwrap();
    }

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
        let probe = tokio::spawn(wait_ready(
            Readiness {
                url,
                credential: None,
            },
            ready_tx,
        ));
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
