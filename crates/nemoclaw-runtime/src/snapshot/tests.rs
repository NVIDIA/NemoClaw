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
pub async fn server(
    responses: Vec<String>,
) -> (Client, Arc<Mutex<Vec<String>>>, tokio::task::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let requests = Arc::new(Mutex::new(Vec::new()));
    let seen = requests.clone();
    let client = Client {
        base_url: format!("http://{}", listener.local_addr().unwrap()),
        http: reqwest::Client::new(),
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

#[test]
fn unfinished_model_files_prevent_successful_observation() {
    let mut model = manifest(b"right");
    let mut second = model.files[0].clone();
    second.name = "second.bin".into();
    model.files.push(second);
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join("weights.bin"), b"right").unwrap();
    assert!(record(dir.path(), &model).is_err());
    assert!(observe(dir.path(), &model).is_err());
    assert_eq!(fs::read(dir.path().join("weights.bin")).unwrap(), b"right");
}

#[test]
#[cfg(unix)]
fn snapshot_does_not_follow_symlinked_data_or_ancestors() {
    for ancestor in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let mut model = manifest(b"right");
        fs::write(outside.path().join("weights.bin"), b"right").unwrap();
        if ancestor {
            std::os::unix::fs::symlink(outside.path(), dir.path().join("nested")).unwrap();
            model.files[0].name = "nested/weights.bin".into();
        } else {
            std::os::unix::fs::symlink(
                outside.path().join("weights.bin"),
                dir.path().join("weights.bin"),
            )
            .unwrap();
        }
        assert!(record(dir.path(), &model).is_err());
        assert!(observe(dir.path(), &model).is_err());
    }
}

#[test]
fn unsupported_model_metadata_is_retained() {
    for bytes in [
        serde_json::to_vec(&manifest(b"right")).unwrap(),
        b"not JSON".to_vec(),
    ] {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join(".nemoclaw-manifest.json"), &bytes).unwrap();
        assert!(ModelManifest::read(dir.path()).is_err());
        assert_eq!(
            fs::read(dir.path().join(".nemoclaw-manifest.json")).unwrap(),
            bytes
        );
    }
}

#[test]
fn recording_a_downloaded_snapshot_marks_its_files_verified() {
    let data = b"weights";
    let directory = tempfile::tempdir().unwrap();
    fs::write(directory.path().join("weights.bin"), data).unwrap();
    let recorded = record(directory.path(), &manifest(data)).unwrap();
    assert!(recorded.files.iter().all(|entry| entry.modified.is_some()));
    assert_eq!(
        observe(directory.path(), &manifest(data)).unwrap(),
        recorded
    );
}

#[test]
fn recording_refuses_a_missing_or_resized_file() {
    let data = b"weights";
    let directory = tempfile::tempdir().unwrap();
    assert!(record(directory.path(), &manifest(data)).is_err());
    fs::write(directory.path().join("weights.bin"), b"short").unwrap();
    assert!(record(directory.path(), &manifest(data)).is_err());
    assert!(ModelManifest::read(directory.path()).unwrap().is_none());
}

#[test]
fn model_manifest_requires_version_one_the_pinned_files_and_verified_times() {
    let mut pinned = manifest(b"right");
    let mut second = pinned.files[0].clone();
    second.name = "second.bin".into();
    pinned.files.push(second);
    let mut local = ModelManifest::new(&pinned);
    assert!(local.verified_files().is_err());
    for entry in &mut local.files {
        entry.modified = Some(1);
    }
    local.validate_for(&pinned).unwrap();
    assert_eq!(local.verified_files().unwrap().len(), 2);
    let original = local.clone();
    ModelManifest::decode(&serde_json::to_vec(&original).unwrap()).unwrap();
    local.version = 2;
    assert!(ModelManifest::decode(&serde_json::to_vec(&local).unwrap()).is_err());
    local = original.clone();
    local.files.swap(0, 1);
    assert!(local.validate_for(&pinned).is_err());
    local = original.clone();
    local.files.pop();
    assert!(local.validate_for(&pinned).is_err());
    local = original;
    local.revision = "b".repeat(40);
    assert!(local.validate_for(&pinned).is_err());
}

#[test]
fn observation_refuses_a_verified_file_whose_modification_time_changed() {
    let data = b"weights";
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("weights.bin");
    fs::write(&path, data).unwrap();
    let recorded = record(directory.path(), &manifest(data)).unwrap();
    let verified = Duration::from_nanos(recorded.files[0].modified.unwrap());
    fs::File::options()
        .write(true)
        .open(&path)
        .unwrap()
        .set_modified(UNIX_EPOCH + verified + Duration::from_secs(1))
        .unwrap();
    assert!(matches!(
        observe(directory.path(), &manifest(data)),
        Err(Error::State(
            "verified model file changed; retained for inspection"
        ))
    ));
    assert_eq!(fs::read(&path).unwrap(), data);
}
