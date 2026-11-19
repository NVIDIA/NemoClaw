// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use super::*;
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
    let error = engine
        .host_observer
        .observe(&engine, None)
        .await
        .err()
        .unwrap();
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
        crate::config::validate_engine_endpoint(endpoint).unwrap();
    }
    assert!(crate::config::validate_engine_endpoint("ssh://user:password@host").is_err());
    assert!(crate::config::validate_engine_endpoint("tcp://host:2375").is_err());
}

/// A Windows client reaches its local engine's pipe, but that engine runs in a
/// VM the client can't measure, so capacity checks refuse it.
#[tokio::test]
#[cfg(windows)]
async fn windows_connects_local_engines_and_refuses_to_measure_their_host() {
    let engine = Engine::connect("npipe:////./pipe/docker_engine").unwrap();
    let error = engine
        .host_observer
        .observe(&engine, None)
        .await
        .err()
        .expect("a local engine's host on Windows");
    assert!(
        error
            .to_string()
            .contains("capacity requires a local Linux"),
        "{error}"
    );
}
