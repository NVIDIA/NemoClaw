// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use super::recipe::PreparedModel;
use crate::{Error, vllm::Service};
use process_wrap::tokio::CommandWrap;
use std::{process::Stdio, time::Duration};
/// Backend-owned probe location. The shared supervisor owns the loading deadline.
pub(crate) struct Readiness {
    url: String,
    credential: Option<String>,
    interval: Duration,
}
#[cfg(test)]
use crate::execution::output::OUTPUT_LIMIT;
use crate::execution::output::Output;
pub(crate) fn launch(
    service: &Service,
    prepared: &PreparedModel,
    total_memory: u64,
    credential: Option<String>,
) -> Result<(CommandWrap, Readiness, Output), Error> {
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
    // One pipe for both streams keeps vLLM's order of log lines and tracebacks.
    let (reader, writer) =
        std::io::pipe().map_err(|_| Error::State("cannot create the inference output pipe"))?;
    let errors = writer
        .try_clone()
        .map_err(|_| Error::State("cannot create the inference output pipe"))?;
    let output = Output::start(reader, credential.clone());
    let command = CommandWrap::with_new("python3", |cmd| {
        cmd.env_remove("VLLM_API_KEY")
            .env_remove(crate::INFERENCE_KEY_ENV);
        if let Some(key) = &credential {
            cmd.env("VLLM_API_KEY", key);
        }
        cmd.args(arguments)
            .envs(&prepared.environment)
            .stdin(Stdio::null())
            .stdout(writer)
            .stderr(errors);
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
            interval: Duration::from_secs(5),
        },
        output,
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
        tokio::time::sleep(readiness.interval).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[tokio::test]
    async fn bearer_key_reaches_only_the_backend_child_and_authenticated_readiness() {
        let root = tempfile::tempdir().unwrap();
        let mut service = crate::fixture();
        service.authentication = Some(crate::vllm::ServiceAuthentication::Bearer);
        let key = crate::execution::authentication::load(root.path()).unwrap();
        let bin = root.path().join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        let python = bin.join("python3");
        // A disposable executable stands in for Python/vLLM and verifies the
        // process boundary. The readiness fixture independently checks HTTP.
        crate::executable::write_executable(
            &python,
            "#!/bin/sh\n[ \"$1 $2 $3\" = '-m vllm.entrypoints.openai.api_server --model' ] && [ \"$4\" = \"$TEST_MODEL_DIRECTORY\" ] || exit 1\ntest \"$VLLM_API_KEY\" = \"$(/bin/cat \"$TEST_KEY_FILE\")\"\n",
        );
        let prepared = PreparedModel {
            model: root.path().join("model"),
            environment: [
                ("PATH".into(), bin.into_os_string()),
                (
                    "TEST_KEY_FILE".into(),
                    root.path().join("inference-key").into_os_string(),
                ),
                (
                    "TEST_MODEL_DIRECTORY".into(),
                    root.path().join("model").into_os_string(),
                ),
            ]
            .into(),
        };
        assert!(launch(&service, &prepared, 121 * crate::hardware::GIB, None).is_err());
        let (mut command, mut readiness, _) = launch(
            &service,
            &prepared,
            121 * crate::hardware::GIB,
            Some(key.clone()),
        )
        .unwrap();
        assert!(command.spawn().unwrap().wait().await.unwrap().success());
        assert!(readiness.url.ends_with("/v1/models"));
        let expected = format!("Bearer {key}");
        let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let requests = seen.clone();
        let server = crate::http_fixture::Fixture::start_tcp(move |request| {
            let authorized = request.header("authorization") == Some(expected.as_str());
            requests
                .lock()
                .unwrap()
                .push((request.method, request.path, authorized));
            Some((if authorized { 200 } else { 401 }, Vec::new()))
        })
        .await;
        readiness.url = format!("{}/v1/models", server.endpoint);
        // A wrong credential gets 401 and retries; the bound turns that into a failure.
        readiness.interval = Duration::from_millis(10);
        let (tx, mut rx) = tokio::sync::mpsc::channel(1);
        tokio::time::timeout(Duration::from_secs(1), wait_ready(readiness, tx))
            .await
            .expect("readiness accepted the bearer key")
            .unwrap();
        assert_eq!(rx.recv().await, Some(true));
        assert_eq!(
            *seen.lock().unwrap(),
            [("GET".to_owned(), "/v1/models".to_owned(), true)]
        );
    }

    #[tokio::test]
    async fn vllm_keeps_its_compile_and_autotune_caches_on_the_model_volume() {
        let root = tempfile::tempdir().unwrap();
        let bin = root.path().join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        // A fake vLLM exits successfully only when its caches are on /data,
        // the retained model volume.
        crate::executable::write_executable(
            &bin.join("python3"),
            "#!/bin/sh\ntest \"$VLLM_CACHE_ROOT\" = /data/vllm-cache || { echo \"VLLM_CACHE_ROOT=$VLLM_CACHE_ROOT\"; exit 1; }\ntest \"$VLLM_FLASHINFER_AUTOTUNE_CACHE_DIR\" = /data/vllm-cache/flashinfer-autotune || { echo \"VLLM_FLASHINFER_AUTOTUNE_CACHE_DIR=$VLLM_FLASHINFER_AUTOTUNE_CACHE_DIR\"; exit 1; }\n",
        );
        let mut environment = super::super::recipe::serving_environment();
        environment.insert("PATH".into(), bin.into_os_string());
        let prepared = PreparedModel {
            model: root.path().join("model"),
            environment,
        };
        let (mut command, _, output) = launch(
            &crate::fixture(),
            &prepared,
            121 * crate::hardware::GIB,
            None,
        )
        .unwrap();
        let mut child = command.spawn().unwrap();
        // The command keeps the output pipe's writer open until dropped.
        drop(command);
        let status = child.wait().await.unwrap();
        let result = output
            .explain(if status.success() {
                Ok(())
            } else {
                Err(Error::Exited(None))
            })
            .await;
        assert!(result.is_ok(), "{result:?}");
    }

    /// Run `script` as a fake vLLM under the supervisor until it exits, and
    /// return the error the runtime reports and the bearer key, if any.
    async fn exit_error(script: &str, bearer: bool) -> (String, Option<String>) {
        use crate::execution::supervisor::{self, Monitors};
        use process_wrap::tokio::{KillOnDrop, ProcessGroup};
        let root = tempfile::tempdir().unwrap();
        let mut service = crate::fixture();
        let key = bearer.then(|| {
            service.authentication = Some(crate::vllm::ServiceAuthentication::Bearer);
            crate::execution::authentication::load(root.path()).unwrap()
        });
        let bin = root.path().join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        crate::executable::write_executable(&bin.join("python3"), script);
        let prepared = PreparedModel {
            model: root.path().join("model"),
            environment: [("PATH".into(), bin.into_os_string())].into(),
        };
        let (mut command, _, output) =
            launch(&service, &prepared, 121 * crate::hardware::GIB, key.clone()).unwrap();
        command.wrap(KillOnDrop).wrap(ProcessGroup::leader());
        let mut child = command.spawn().unwrap();
        drop(command);
        let (_samples_tx, samples) = tokio::sync::mpsc::channel(1);
        let (_ready_tx, ready) = tokio::sync::mpsc::channel(1);
        let result = supervisor::supervise(
            supervisor::Policy {
                startup_timeout: Duration::from_secs(60),
                protection: crate::hardware::ProtectionPolicy::new(
                    8 * crate::hardware::GIB,
                    3 * crate::hardware::GIB,
                    12 * crate::hardware::GIB,
                    5,
                )
                .unwrap(),
            },
            child.as_mut(),
            Monitors {
                samples,
                ready,
                trip: crate::CancellationToken::new(),
                report: &|_, _, _| Ok(()),
            },
            &crate::CancellationToken::new(),
        )
        .await;
        let error = tokio::time::timeout(Duration::from_secs(3), output.explain(result))
            .await
            .expect("stopping the process group closes the output")
            .unwrap_err()
            .to_string();
        (error, key)
    }

    const EXITED: &str = "managed service process exited; its final output follows, and the container log has all of it; correct the cause and reapply:";

    #[tokio::test]
    async fn an_exit_error_carries_vllms_whole_short_output() {
        let (error, _) = exit_error(
            "#!/bin/sh\necho 'INFO starting'\necho 'ValueError: Total number of attention heads (14) must be divisible by tensor parallel size (4).' >&2\nexit 1\n",
            false,
        )
        .await;
        assert_eq!(
            error,
            format!(
                "{EXITED}\nINFO starting\nValueError: Total number of attention heads (14) must be divisible by tensor parallel size (4)."
            )
        );
    }

    #[tokio::test]
    async fn an_exit_error_carries_the_end_of_vllms_output_without_its_key() {
        // A fake vLLM: a worker that keeps the output open, more log lines
        // than the error keeps, its key, and a startup error on each stream.
        let (error, key) = exit_error(
            "#!/bin/sh\n/bin/sleep 100 &\ni=0\nwhile [ $i -lt 120 ]; do echo \"INFO loading line $i of a fake vLLM start that writes more than the error keeps\"; i=$((i+1)); done\necho \"(EngineCore pid=7) worker saw key $VLLM_API_KEY\"\necho 'ValueError: Total number of attention heads (14) must be divisible by tensor parallel size (4).' >&2\nexit 1\n",
            true,
        )
        .await;
        let (message, final_output) = error.split_once('\n').expect("the error carries output");
        assert_eq!(message, EXITED);
        assert!(
            final_output.ends_with("worker saw key [redacted]\nValueError: Total number of attention heads (14) must be divisible by tensor parallel size (4)."),
            "{final_output}"
        );
        assert!(
            !error.contains(&key.unwrap()),
            "the error must not carry the key"
        );
        assert!(final_output.len() <= OUTPUT_LIMIT, "{}", final_output.len());
        assert!(
            final_output.starts_with("INFO loading line ")
                && !final_output.contains("INFO loading line 0 "),
            "the error keeps whole lines from the end: {final_output}"
        );
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
                interval: Duration::from_millis(10),
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
