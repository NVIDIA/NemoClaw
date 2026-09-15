// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::*;
use std::sync::{Arc, Mutex};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};

fn manifest(data: &[u8]) -> Manifest {
    Manifest {
        repository: "owner/model".into(),
        revision: "a".repeat(40),
        files: vec![File {
            name: "weights.bin".into(),
            size: data.len() as u64,
            sha256: hex(Sha256::digest(data)),
        }],
    }
}
pub(super) async fn server(
    responses: Vec<String>,
) -> (Client, Arc<Mutex<Vec<String>>>, tokio::task::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let requests = Arc::new(Mutex::new(Vec::new()));
    let seen = requests.clone();
    let client = Client {
        base_url: format!("http://{}", listener.local_addr().unwrap()),
        http: reqwest::Client::new(),
        resume_attempts: 1,
    };
    let task = tokio::spawn(async move {
        for response in responses {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            loop {
                let byte = stream.read_u8().await.unwrap();
                request.push(byte);
                if request.ends_with(b"\r\n\r\n") {
                    break;
                }
            }
            seen.lock()
                .unwrap()
                .push(String::from_utf8(request).unwrap());
            stream.write_all(response.as_bytes()).await.unwrap();
            stream.shutdown().await.unwrap();
        }
    });
    (client, requests, task)
}
#[tokio::test]
async fn interrupted_snapshot_resumes_confirmed_range_and_unchanged_apply_downloads_nothing() {
    let (client, requests, server) = server(vec![
        "HTTP/1.1 200 OK\r\nContent-Length: 5\r\nConnection: close\r\n\r\nri".into(),
        "HTTP/1.1 206 Partial Content\r\nContent-Length: 3\r\nContent-Range: bytes 2-4/5\r\nConnection: close\r\n\r\nght".into(),
    ]).await;
    let dir = tempfile::tempdir().unwrap();
    let model = manifest(b"right");
    let cancel = CancellationToken::new();
    assert!(
        client
            .ensure(dir.path(), &model, &cancel, &|_| {})
            .await
            .is_err()
    );
    assert!(observe(dir.path(), &model).is_err());
    assert_eq!(
        std::fs::read(dir.path().join("weights.bin.nemoclaw-partial")).unwrap(),
        b"ri"
    );
    let receipt = client
        .ensure(dir.path(), &model, &cancel, &|_| {})
        .await
        .unwrap();
    assert_eq!(receipt, observe(dir.path(), &model).unwrap());
    assert_eq!(
        client
            .ensure(dir.path(), &model, &cancel, &|_| {})
            .await
            .unwrap(),
        receipt
    );
    server.await.unwrap();
    let requests = requests.lock().unwrap();
    assert_eq!(requests.len(), 2);
    assert!(requests[1].contains("range: bytes=2-\r\n"));
    assert!(requests[0].starts_with(&format!(
        "GET /owner/model/resolve/{}/weights.bin ",
        model.revision
    )));
}
#[tokio::test]
async fn failed_range_auth_checksum_or_partial_results_never_publish_completion() {
    for response in [
        "HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n",
        "HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nright",
        "HTTP/1.1 206 Partial Content\r\nContent-Length: 3\r\nContent-Range: bytes 2-4/5\r\n\r\nbad",
        "HTTP/1.1 206 Partial Content\r\nContent-Length: 1\r\nContent-Range: bytes 2-4/5\r\n\r\ng",
    ] {
        let (client, _, task) = server(vec![response.into()]).await;
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("weights.bin.nemoclaw-partial"), b"ri").unwrap();
        assert!(
            client
                .ensure(
                    dir.path(),
                    &manifest(b"right"),
                    &CancellationToken::new(),
                    &|_| {}
                )
                .await
                .is_err()
        );
        assert!(!dir.path().join(".nemoclaw-complete.json").exists());
        assert!(dir.path().join("weights.bin.nemoclaw-partial").exists());
        task.await.unwrap();
    }
}
#[tokio::test]
async fn corrupted_established_files_are_retained_without_download() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("weights.bin"), b"wrong").unwrap();
    assert!(
        Client::new()
            .unwrap()
            .ensure(
                dir.path(),
                &manifest(b"right"),
                &CancellationToken::new(),
                &|_| {}
            )
            .await
            .is_err()
    );
    assert_eq!(
        std::fs::read(dir.path().join("weights.bin")).unwrap(),
        b"wrong"
    );
}
#[test]
fn manifest_rejects_path_and_receipt_collisions() {
    for name in [
        "../weights",
        "a/../weights",
        "/weights",
        "a\\weights",
        ".nemoclaw-complete.json",
        "weights.bin.nemoclaw-partial",
    ] {
        let mut model = manifest(b"right");
        model.files[0].name = name.into();
        assert!(model.validate().is_err(), "{name}");
    }
    let mut model = manifest(b"right");
    model.files.push(model.files[0].clone());
    assert!(model.validate().is_err());
}

#[tokio::test]
async fn snapshot_bounds_parallel_streams_and_retains_manifest_order() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let client = Client {
        base_url: format!("http://{}", listener.local_addr().unwrap()),
        http: reqwest::Client::new(),
        resume_attempts: 1,
    };
    let permits = Arc::new(tokio::sync::Semaphore::new(0));
    let gate = permits.clone();
    let (arrived, mut arrivals) = tokio::sync::mpsc::channel(8);
    let server = tokio::spawn(async move {
        let mut tasks = tokio::task::JoinSet::new();
        for _ in 0..8 {
            let (mut stream, _) = listener.accept().await.unwrap();
            let gate = gate.clone();
            let arrived = arrived.clone();
            tasks.spawn(async move {
                let mut request = Vec::new();
                while !request.ends_with(b"\r\n\r\n") {
                    request.push(stream.read_u8().await.unwrap());
                }
                arrived.send(()).await.unwrap();
                gate.acquire().await.unwrap().forget();
                stream
                    .write_all(
                        b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\nConnection: close\r\n\r\nright",
                    )
                    .await
                    .unwrap();
            });
        }
        while let Some(result) = tasks.join_next().await {
            result.unwrap();
        }
    });
    let mut model = manifest(b"right");
    for i in 1..8 {
        let mut file = model.files[0].clone();
        file.name = format!("nested/part-{i}");
        model.files.push(file);
    }
    let dir = tempfile::tempdir().unwrap();
    let cancel = CancellationToken::new();
    let work = client.ensure(dir.path(), &model, &cancel, &|_| {});
    let gate = async {
        for _ in 0..4 {
            tokio::time::timeout(Duration::from_secs(5), arrivals.recv())
                .await
                .unwrap()
                .unwrap();
        }
        assert!(arrivals.try_recv().is_err());
        permits.add_permits(8);
    };
    let (receipt, ()) = tokio::join!(work, gate);
    assert_eq!(receipt.unwrap(), observe(dir.path(), &model).unwrap());
    server.await.unwrap();
}
#[tokio::test]
async fn partial_manifest_never_publishes_snapshot_completion() {
    let (client, _, task) = server(vec![
        "HTTP/1.1 503 Unavailable\r\nContent-Length: 0\r\n\r\n".into(),
    ])
    .await;
    let mut model = manifest(b"right");
    let mut second = model.files[0].clone();
    second.name = "second.bin".into();
    model.files.push(second);
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("weights.bin"), b"right").unwrap();
    assert!(
        client
            .ensure(dir.path(), &model, &CancellationToken::new(), &|_| {})
            .await
            .is_err()
    );
    assert!(!dir.path().join(".nemoclaw-complete.json").exists());
    assert_eq!(
        std::fs::read(dir.path().join("weights.bin")).unwrap(),
        b"right"
    );
    task.await.unwrap();
}
#[tokio::test]
#[cfg(unix)]
async fn snapshot_does_not_follow_symlinked_data_or_ancestors() {
    for ancestor in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let mut model = manifest(b"right");
        if ancestor {
            std::os::unix::fs::symlink(outside.path(), dir.path().join("nested")).unwrap();
            model.files[0].name = "nested/weights.bin".into();
        } else {
            std::fs::write(outside.path().join("weights.bin"), b"right").unwrap();
            std::os::unix::fs::symlink(
                outside.path().join("weights.bin"),
                dir.path().join("weights.bin.nemoclaw-partial"),
            )
            .unwrap();
        }
        assert!(
            Client::new()
                .unwrap()
                .ensure(dir.path(), &model, &CancellationToken::new(), &|_| {})
                .await
                .is_err()
        );
        assert!(!dir.path().join(".nemoclaw-complete.json").exists());
    }
}

#[tokio::test]
async fn automatic_resume_only_retries_interrupted_bodies_and_reports_attempts() {
    let (mut client, requests, task)=server(vec![
        "HTTP/1.1 200 OK\r\nContent-Length: 5\r\nConnection: close\r\n\r\nri".into(),
        "HTTP/1.1 206 Partial Content\r\nContent-Length: 3\r\nContent-Range: bytes 2-4/5\r\nConnection: close\r\n\r\nght".into(),
    ]).await;
    client.resume_attempts = 4;
    let dir = tempfile::tempdir().unwrap();
    let events = Mutex::new(Vec::new());
    client
        .ensure(
            dir.path(),
            &manifest(b"right"),
            &CancellationToken::new(),
            &|event| events.lock().unwrap().push(event.to_owned()),
        )
        .await
        .unwrap();
    task.await.unwrap();
    assert_eq!(requests.lock().unwrap().len(), 2);
    assert_eq!(events.lock().unwrap().len(), 2);
    let (mut client, requests, task) = server(vec![
        "HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n".into(),
    ])
    .await;
    client.resume_attempts = 4;
    let dir = tempfile::tempdir().unwrap();
    assert!(
        client
            .ensure(
                dir.path(),
                &manifest(b"right"),
                &CancellationToken::new(),
                &|_| {}
            )
            .await
            .is_err()
    );
    task.await.unwrap();
    assert_eq!(requests.lock().unwrap().len(), 1);
}
