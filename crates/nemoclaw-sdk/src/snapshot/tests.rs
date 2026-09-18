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
    let local = client
        .ensure(dir.path(), &model, &cancel, &|_| {})
        .await
        .unwrap();
    assert_eq!(local, observe(dir.path(), &model).unwrap());
    assert_eq!(
        client
            .ensure(dir.path(), &model, &cancel, &|_| {})
            .await
            .unwrap(),
        local
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
async fn failed_range_auth_checksum_or_partial_results_remain_incomplete() {
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
        assert!(observe(dir.path(), &manifest(b"right")).is_err());
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
fn manifest_rejects_path_and_reserved_metadata_collisions() {
    for name in [
        "../weights",
        "a/../weights",
        "/weights",
        "a\\weights",
        ".nemoclaw-manifest.json",
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
    let (local, ()) = tokio::join!(work, gate);
    assert_eq!(local.unwrap(), observe(dir.path(), &model).unwrap());
    server.await.unwrap();
}
#[tokio::test]
async fn unfinished_model_files_prevent_successful_observation() {
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
    assert!(observe(dir.path(), &model).is_err());
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
        assert!(observe(dir.path(), &manifest(b"right")).is_err());
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

#[tokio::test]
async fn downloaded_model_keeps_one_manifest_and_rejects_missing_verified_files() {
    let (client, requests, task) = server(vec![
        "HTTP/1.1 200 OK\r\nContent-Length: 5\r\nConnection: close\r\n\r\nright".into(),
        "HTTP/1.1 200 OK\r\nContent-Length: 5\r\nConnection: close\r\n\r\nright".into(),
    ])
    .await;
    let dir = tempfile::tempdir().unwrap();
    let model = manifest(b"right");
    let cancel = CancellationToken::new();
    client
        .ensure(dir.path(), &model, &cancel, &|_| {})
        .await
        .unwrap();
    let mut names: Vec<_> = fs::read_dir(dir.path())
        .unwrap()
        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
        .collect();
    names.sort();
    assert_eq!(names, [".nemoclaw-manifest.json", "weights.bin"]);
    let metadata = fs::read(dir.path().join(".nemoclaw-manifest.json")).unwrap();
    let saved: serde_json::Value = serde_json::from_slice(&metadata).unwrap();
    assert_eq!(saved["repository"], model.repository);
    assert_eq!(saved["files"][0]["sha256"], model.files[0].sha256);
    assert!(saved["files"][0]["modified"].is_u64());
    fs::remove_file(dir.path().join("weights.bin")).unwrap();
    assert!(
        client
            .ensure(dir.path(), &model, &cancel, &|_| {})
            .await
            .is_err()
    );
    assert!(!dir.path().join("weights.bin").exists());
    assert_eq!(
        fs::read(dir.path().join(".nemoclaw-manifest.json")).unwrap(),
        metadata
    );
    assert_eq!(requests.lock().unwrap().len(), 1);
    task.abort();
}

#[tokio::test]
async fn unsupported_model_metadata_is_retained_without_downloading() {
    for bytes in [
        serde_json::to_vec(&manifest(b"right")).unwrap(),
        b"not JSON".to_vec(),
    ] {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join(".nemoclaw-manifest.json"), &bytes).unwrap();
        let (client, requests, task) = server(vec![
            "HTTP/1.1 200 OK\r\nContent-Length: 5\r\nConnection: close\r\n\r\nright".into(),
        ])
        .await;
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
        assert_eq!(
            fs::read(dir.path().join(".nemoclaw-manifest.json")).unwrap(),
            bytes
        );
        assert!(requests.lock().unwrap().is_empty());
        task.abort();
    }
}

#[tokio::test]
async fn manifest_saves_each_verified_file_before_other_downloads_finish() {
    for cancel_download in [false, true] {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let client = Client {
            base_url: format!("http://{}", listener.local_addr().unwrap()),
            http: reqwest::Client::new(),
            resume_attempts: 1,
        };
        let (release, wait) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            while !request.ends_with(b"\r\n\r\n") {
                request.push(stream.read_u8().await.unwrap());
            }
            assert!(String::from_utf8(request).unwrap().contains("/second.bin "));
            if wait.await.is_err() {
                return;
            }
            stream
                .write_all(
                    b"HTTP/1.1 503 Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                )
                .await
                .unwrap();
        });
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("weights.bin"), b"right").unwrap();
        let mut model = manifest(b"right");
        let mut second = model.files[0].clone();
        second.name = "second.bin".into();
        model.files.push(second);
        let cancel = CancellationToken::new();
        let ensure = client.ensure(dir.path(), &model, &cancel, &|_| {});
        let check = async {
            tokio::time::timeout(Duration::from_secs(5), async {
                loop {
                    if let Some(local) = ModelManifest::read(dir.path()).unwrap()
                        && local.files[0].modified.is_some()
                    {
                        assert!(local.files[1].modified.is_none());
                        assert_eq!(local.snapshot().key(), model.key());
                        assert!(observe(dir.path(), &model).is_err());
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(5)).await;
                }
            })
            .await
            .unwrap();
            if cancel_download {
                cancel.cancel();
            } else {
                release.send(()).unwrap();
            }
        };
        let (result, ()) = tokio::join!(ensure, check);
        assert!(result.is_err());
        task.await.unwrap();
        let cancel = CancellationToken::new();
        let first_modified = ModelManifest::read(dir.path()).unwrap().unwrap().files[0].modified;
        let (client, requests, task) = server(vec![
            "HTTP/1.1 200 OK\r\nContent-Length: 5\r\nConnection: close\r\n\r\nright".into(),
        ])
        .await;
        let progress = Mutex::new(Vec::new());
        let local = client
            .ensure(dir.path(), &model, &cancel, &|file| {
                progress.lock().unwrap().push(file.to_owned())
            })
            .await
            .unwrap();
        task.await.unwrap();
        assert_eq!(*progress.lock().unwrap(), ["second.bin"]);
        assert_eq!(local.files[0].modified, first_modified);
        assert_eq!(local.snapshot().key(), model.key());
        assert_eq!(local.verified_files().unwrap().len(), 2);
        assert_eq!(requests.lock().unwrap().len(), 1);
        assert_eq!(local, observe(dir.path(), &model).unwrap());
    }
}

#[tokio::test]
async fn changed_verified_files_or_pins_stop_before_any_download_or_manifest_write() {
    for change in ["content", "timestamp", "pin"] {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("weights.bin"), b"right").unwrap();
        let (client, requests, task) = server(Vec::new()).await;
        let mut model = manifest(b"right");
        let cancel = CancellationToken::new();
        client
            .ensure(dir.path(), &model, &cancel, &|_| {})
            .await
            .unwrap();
        let retained = fs::read(dir.path().join(MANIFEST_FILE)).unwrap();
        match change {
            "content" => fs::write(dir.path().join("weights.bin"), b"changed").unwrap(),
            "timestamp" => fs::File::options()
                .write(true)
                .open(dir.path().join("weights.bin"))
                .unwrap()
                .set_times(fs::FileTimes::new().set_modified(UNIX_EPOCH + Duration::from_secs(1)))
                .unwrap(),
            "pin" => model.revision = "b".repeat(40),
            _ => unreachable!(),
        }
        assert!(observe(dir.path(), &model).is_err(), "{change}");
        assert!(
            client
                .ensure(dir.path(), &model, &cancel, &|_| panic!(
                    "must not start work on drift"
                ))
                .await
                .is_err(),
            "{change}"
        );
        assert_eq!(fs::read(dir.path().join(MANIFEST_FILE)).unwrap(), retained);
        assert!(requests.lock().unwrap().is_empty());
        task.await.unwrap();
    }
}

#[tokio::test]
async fn a_file_renamed_before_progress_was_saved_is_reverified_without_download() {
    for bytes in [b"right", b"wrong"] {
        let dir = tempfile::tempdir().unwrap();
        let model = manifest(b"right");
        save_json(&dir.path().join(MANIFEST_FILE), &ModelManifest::new(&model)).unwrap();
        fs::write(dir.path().join("weights.bin"), bytes).unwrap();
        let (client, requests, task) = server(Vec::new()).await;
        let result = client
            .ensure(dir.path(), &model, &CancellationToken::new(), &|_| {})
            .await;
        assert_eq!(result.is_ok(), bytes == b"right");
        assert_eq!(observe(dir.path(), &model).is_ok(), bytes == b"right");
        assert_eq!(fs::read(dir.path().join("weights.bin")).unwrap(), bytes);
        assert!(requests.lock().unwrap().is_empty());
        task.await.unwrap();
    }
}
