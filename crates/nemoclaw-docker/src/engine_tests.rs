// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use super::*;
#[tokio::test]
async fn docker_transport_distinguishes_confirmed_absence_from_failed_observation() {
    for (status, body, absent) in [
        (404, r#"{"message":"missing"}"#, true),
        (403, r#"{"message":"secret-sentinel"}"#, false),
        (500, r#"{"message":"secret-sentinel"}"#, false),
        (200, "{", false),
    ] {
        let server =
            crate::fixture::Fixture::start(move |_| Some((status, body.as_bytes().to_vec()))).await;
        let engine = Engine::connect(&server.endpoint).unwrap();
        let observed = engine.container("owned").await;
        if absent {
            assert!(observed.unwrap().is_none());
        } else {
            let error = observed.unwrap_err();
            assert!(!error.to_string().contains("secret-sentinel"));
        }
    }
}
#[test]
fn archive_observation_requires_one_complete_regular_file_within_limit() {
    let good = archive(&[("status.json", b"ready".as_slice(), 0o600)]).unwrap();
    assert_eq!(read_archive(&good, 128).unwrap(), b"ready");
    assert!(read_archive(&good, 4).is_err());
    assert!(read_archive(&good[..514], 128).is_err());
    let duplicate = archive(&[
        ("first", b"ready".as_slice(), 0o600),
        ("second", b"unexpected".as_slice(), 0o600),
    ])
    .unwrap();
    assert!(read_archive(&duplicate, 128).is_err());
    assert!(read_archive(b"", 128).is_err());
}
