// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use super::*;
use crate::docker::fixture::Fixture;
use std::{
    io::Read,
    sync::{Arc, Mutex},
};
#[tokio::test]
async fn legacy_key_handoff_never_rekeys_or_writes_after_failed_observation() {
    for failure in [
        "none",
        "preserved",
        "different",
        "missing",
        "authentication",
        "copy",
        "short",
    ] {
        let legacy = vec![42_u8; 32];
        let initial = match failure {
            "preserved" => Some(legacy.clone()),
            "different" => Some(vec![43; 32]),
            _ => None,
        };
        let state = Arc::new(Mutex::new((initial, 0)));
        let shared = state.clone();
        let key = legacy.clone();
        let fixture = Fixture::start(move |request| {
            assert!(request.path.starts_with("/containers/verified/archive?"));
            let url = url::Url::parse(&format!("http://fixture{}", request.path)).unwrap();
            let path = url
                .query_pairs()
                .find(|(key, _)| key == "path")
                .unwrap()
                .1
                .into_owned();
            let mut state = shared.lock().unwrap();
            if request.method == "PUT" {
                state.1 += 1;
                assert_eq!(path, "/owned-data");
                if failure == "copy" {
                    return Some((503, br#"{"message":"failed"}"#.to_vec()));
                }
                let mut archive = tar::Archive::new(request.body.as_slice());
                for entry in archive.entries().unwrap() {
                    let mut entry = entry.unwrap();
                    if entry.header().entry_type().is_dir() {
                        assert_eq!(entry.header().mode().unwrap(), 0o700);
                        continue;
                    }
                    assert_eq!(
                        entry.path().unwrap().to_str().unwrap(),
                        &CREDENTIAL_KEY_PATH[1..]
                    );
                    assert_eq!(entry.header().mode().unwrap(), 0o600);
                    let mut bytes = Vec::new();
                    entry.read_to_end(&mut bytes).unwrap();
                    state.0 = Some(bytes);
                }
                return Some((200, Vec::new()));
            }
            assert_eq!(request.method, "GET");
            let data = if path.starts_with("/root/") {
                match failure {
                    "authentication" => {
                        return Some((403, br#"{"message":"secret-sentinel"}"#.to_vec()));
                    }
                    "missing" => None,
                    "short" => Some(b"short".to_vec()),
                    _ => Some(key.clone()),
                }
            } else {
                state.0.clone()
            };
            if let Some(bytes) = data {
                let mut archive = tar::Builder::new(Vec::new());
                let mut header = tar::Header::new_gnu();
                header.set_size(bytes.len() as u64);
                header.set_mode(0o600);
                header.set_cksum();
                archive
                    .append_data(&mut header, "key", bytes.as_slice())
                    .unwrap();
                Some((200, archive.into_inner().unwrap()))
            } else {
                Some((404, br#"{"message":"missing"}"#.to_vec()))
            }
        })
        .await;
        let engine = crate::docker::Engine::connect(&fixture.endpoint).unwrap();
        let result = engine.preserve_legacy_key("verified", "/owned-data").await;
        if matches!(failure, "none" | "preserved") {
            result.unwrap();
            assert_eq!(state.lock().unwrap().0.as_ref(), Some(&legacy));
        } else {
            let error = result.unwrap_err();
            assert!(!error.to_string().contains("secret-sentinel"));
        }
        assert_eq!(
            state.lock().unwrap().1,
            usize::from(matches!(failure, "none" | "copy"))
        );
    }
}
