// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use super::*;
#[tokio::test]
#[cfg(unix)]
async fn docker_transport_distinguishes_confirmed_absence_from_failed_observation() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    for (status, body, absent) in [
        (404, r#"{"message":"missing"}"#, true),
        (403, r#"{"message":"secret-sentinel"}"#, false),
        (500, r#"{"message":"secret-sentinel"}"#, false),
        (200, "{", false),
    ] {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("engine.sock");
        let listener = tokio::net::UnixListener::bind(&path).unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            while !request.ends_with(b"\r\n\r\n") {
                request.push(socket.read_u8().await.unwrap());
            }
            socket.write_all(format!("HTTP/1.1 {status} Fixture\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await.unwrap();
        });
        let engine = Engine::connect(&format!("unix://{}", path.display())).unwrap();
        let observed = engine.container("owned").await;
        if absent {
            assert!(observed.unwrap().is_none());
        } else {
            let error = observed.unwrap_err();
            assert!(!error.to_string().contains("secret-sentinel"));
        }
        server.await.unwrap();
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
#[test]
fn managed_engine_requires_explicit_local_socket() {
    for endpoint in [
        "",
        "tcp://127.0.0.1:2375",
        "unix://relative",
        "http://remote",
    ] {
        assert!(Engine::connect(endpoint).is_err());
    }
}

#[tokio::test]
#[cfg(unix)]
async fn ssh_connection_is_lazy_and_requires_explicit_remote_capacity() {
    let engine = Engine::connect("ssh://operator@gpu-box:2222").unwrap();
    assert_eq!(engine.endpoint(), "ssh://operator@gpu-box:2222");
    let error = engine.host_observer.observe(&engine).await.err().unwrap();
    assert!(error.to_string().contains("remote host capacity"));
}

#[test]
fn ssh_connections_reject_credentials_options_and_unsupported_paths() {
    for endpoint in [
        "ssh://",
        "ssh://-oProxyCommand=bad",
        "ssh://user:secret@host",
        "ssh://host/run/docker.sock",
        "ssh://host?key=secret",
        "ssh://host#fragment",
        "ssh://user%20name@host",
        "ssh://host\n",
        "ssh://-user@host",
    ] {
        assert!(Engine::connect(endpoint).is_err(), "accepted {endpoint:?}");
    }
}

#[test]
fn engine_endpoint_syntax_can_be_validated_without_opening_a_transport() {
    for endpoint in ["unix:///var/run/docker.sock", "ssh://operator@gpu-box:2222"] {
        Engine::validate_endpoint(endpoint).unwrap();
    }
    assert!(Engine::validate_endpoint("ssh://user:password@host").is_err());
    assert!(Engine::validate_endpoint("tcp://host:2375").is_err());
}
