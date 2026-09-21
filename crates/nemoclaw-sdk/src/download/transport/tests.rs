// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use super::*;
use crate::{ByteProgress, DownloadPhase, download::Reporter};

fn collect() -> (Callback, mpsc::UnboundedReceiver<DownloadProgress>) {
    let (tx, rx) = mpsc::unbounded_channel();
    (
        Arc::new(move |event| {
            if let Progress::Download(event) = event {
                let _ = tx.send(event);
            }
        }),
        rx,
    )
}
fn event(resource: &str) -> DownloadProgress {
    DownloadProgress {
        resource: resource.into(),
        artifact: "image:tag".into(),
        layer: Some("abcdef".into()),
        phase: DownloadPhase::Downloading,
        bytes: Some(ByteProgress {
            completed: 50,
            total: Some(100),
        }),
    }
}

#[tokio::test]
async fn concurrent_providers_deliver_independent_updates() {
    let (callback, mut events) = collect();
    let listener = Listener::start(callback).unwrap();
    let mut tasks = JoinSet::new();
    for resource in ["gateway.one", "ollama.two"] {
        let endpoint = listener.endpoint.clone();
        tasks.spawn(async move {
            forward(endpoint, resource.into(), async {
                let mut reporter = Reporter::new("image:tag");
                reporter.report(
                    Some("abcdef".into()),
                    DownloadPhase::Downloading,
                    Some(ByteProgress {
                        completed: 50,
                        total: Some(100),
                    }),
                );
                reporter.complete();
                42
            })
            .await
        });
    }
    while let Some(result) = tasks.join_next().await {
        assert_eq!(result.unwrap(), 42);
    }
    let mut received = Vec::new();
    for _ in 0..6 {
        received.push(
            tokio::time::timeout(Duration::from_secs(2), events.recv())
                .await
                .unwrap()
                .unwrap(),
        );
    }
    for resource in ["gateway.one", "ollama.two"] {
        assert!(received.contains(&event(resource)));
    }
}

#[tokio::test]
async fn invalid_and_partial_messages_do_not_poison_other_connections() {
    let (callback, mut events) = collect();
    let listener = Listener::start(callback).unwrap();
    let mut broken = Stream::connect(name(&listener.endpoint).unwrap())
        .await
        .unwrap();
    broken.write_all(b"{bad json}\n").await.unwrap();
    let mut injected = event("gateway\nsecret");
    let mut bytes = serde_json::to_vec(&injected).unwrap();
    bytes.push(b'\n');
    broken.write_all(&bytes).await.unwrap();
    injected.resource = "valid".into();
    bytes = serde_json::to_vec(&injected).unwrap();
    bytes.push(b'\n');
    broken.write_all(&bytes).await.unwrap();
    broken.write_all(b"{\"resource\":").await.unwrap();
    drop(broken);
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(2), events.recv())
            .await
            .unwrap()
            .unwrap(),
        injected
    );
    let mut oversized = Stream::connect(name(&listener.endpoint).unwrap())
        .await
        .unwrap();
    let _ = oversized.write_all(&vec![b'x'; LIMIT + 1]).await;
    drop(oversized);
    forward(listener.endpoint.clone(), "next".into(), async {
        Reporter::new("image:tag").complete();
    })
    .await;
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(2), events.recv())
            .await
            .unwrap()
            .unwrap()
            .resource,
        "next"
    );
}

#[tokio::test]
async fn absent_or_disconnected_listener_cannot_fail_the_operation() {
    let (callback, _) = collect();
    let listener = Listener::start(callback).unwrap();
    let endpoint = listener.endpoint.clone();
    let result = forward(endpoint.clone(), "gateway".into(), async {
        Reporter::new("image:tag");
        tokio::time::sleep(Duration::from_millis(20)).await;
        drop(listener);
        tokio::task::yield_now().await;
        Reporter::new("image:tag").complete();
        42
    })
    .await;
    assert_eq!(result, 42);
    assert_eq!(
        forward(endpoint, "gateway".into(), async {
            Reporter::new("image:tag");
            43
        })
        .await,
        43
    );
}

#[tokio::test]
async fn stalled_reader_and_full_queue_cannot_block_the_operation() {
    let directory = tempfile::tempdir().unwrap();
    #[cfg(unix)]
    let endpoint = directory.path().join("stalled.sock").into_os_string();
    #[cfg(windows)]
    let endpoint = OsString::from(format!(
        r"\\.\pipe\{}",
        directory.path().file_name().unwrap().to_string_lossy()
    ));
    let listener = ListenerOptions::new()
        .name(name(&endpoint).unwrap())
        .create_tokio()
        .unwrap();
    let reader = tokio::spawn(async move {
        let _stream = listener.accept().await.unwrap();
        std::future::pending::<()>().await;
    });
    let reader = AbortOnDropHandle::new(reader);
    let result = tokio::time::timeout(
        Duration::from_secs(2),
        forward(endpoint, "gateway".into(), async {
            for i in 0..100_000 {
                super::super::CONTEXT
                    .with(|(_, callback)| callback(Progress::Download(event("gateway"))));
                if i % 100 == 0 {
                    tokio::task::yield_now().await;
                }
            }
            42
        }),
    )
    .await
    .unwrap();
    assert_eq!(result, 42);
    drop(reader);
}

#[test]
fn provider_process() {
    if std::env::var_os("NEMOCLAW_TEST_PROGRESS_CHILD").is_none() {
        return;
    }
    tokio::runtime::Runtime::new()
        .unwrap()
        .block_on(crate::with_provider_download_progress(
            "child".into(),
            async {
                Reporter::new("image:tag").complete();
            },
        ));
}

#[tokio::test]
async fn progress_crosses_the_process_boundary() {
    let (callback, mut events) = collect();
    let listener = Listener::start(callback).unwrap();
    let status = tokio::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "download::transport::tests::provider_process"])
        .env(ENV, &listener.endpoint)
        .env("NEMOCLAW_TEST_PROGRESS_CHILD", "1")
        .stdout(std::process::Stdio::null())
        .kill_on_drop(true)
        .status()
        .await
        .unwrap();
    assert!(status.success());
    for phase in [DownloadPhase::Starting, DownloadPhase::Complete] {
        let event = tokio::time::timeout(Duration::from_secs(2), events.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(event.resource, "child");
        assert_eq!(event.phase, phase);
    }
}

#[tokio::test]
async fn cancelling_the_operation_closes_its_progress_connection() {
    let directory = tempfile::tempdir().unwrap();
    #[cfg(unix)]
    let endpoint = directory.path().join("cancel.sock").into_os_string();
    #[cfg(windows)]
    let endpoint = OsString::from(format!(
        r"\\.\pipe\{}",
        directory.path().file_name().unwrap().to_string_lossy()
    ));
    let listener = ListenerOptions::new()
        .name(name(&endpoint).unwrap())
        .create_tokio()
        .unwrap();
    let operation = tokio::spawn(forward(endpoint, "gateway".into(), async {
        Reporter::new("image:tag");
        std::future::pending::<()>().await;
    }));
    let stream = tokio::time::timeout(Duration::from_secs(2), listener.accept())
        .await
        .unwrap()
        .unwrap();
    let mut reader = BufReader::new(stream);
    let mut first = Vec::new();
    tokio::time::timeout(Duration::from_secs(2), reader.read_until(b'\n', &mut first))
        .await
        .unwrap()
        .unwrap();
    assert!(!first.is_empty());
    operation.abort();
    assert!(operation.await.unwrap_err().is_cancelled());
    let mut rest = Vec::new();
    // Windows may report a broken pipe instead of EOF; either closes the reader.
    let _ = tokio::time::timeout(Duration::from_secs(2), reader.read_to_end(&mut rest))
        .await
        .expect("progress writer outlived the cancelled operation");
}

#[tokio::test]
async fn dropping_listener_closes_connections_and_removes_its_socket() {
    let (callback, _) = collect();
    let listener = Listener::start(callback).unwrap();
    let endpoint = listener.endpoint.clone();
    let mut stream = Stream::connect(name(&endpoint).unwrap()).await.unwrap();
    tokio::task::yield_now().await;
    drop(listener);
    let _ = tokio::time::timeout(Duration::from_secs(2), stream.read_u8())
        .await
        .expect("reader outlived listener");
    #[cfg(unix)]
    assert!(!std::path::Path::new(&endpoint).exists());
}
