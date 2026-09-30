// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use super::*;
use crate::{ByteProgress, DownloadPhase};
use std::{sync::Arc, time::Duration};
use tokio::{io::AsyncWriteExt, sync::mpsc};

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
    let mut next = Stream::connect(name(&listener.endpoint).unwrap())
        .await
        .unwrap();
    let mut bytes = serde_json::to_vec(&event("next")).unwrap();
    bytes.push(b'\n');
    next.write_all(&bytes).await.unwrap();
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
