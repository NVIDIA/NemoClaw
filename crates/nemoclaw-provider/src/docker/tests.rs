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
        crate::config::validate_engine_endpoint(endpoint).unwrap();
    }
    assert!(crate::config::validate_engine_endpoint("ssh://user:password@host").is_err());
    assert!(crate::config::validate_engine_endpoint("tcp://host:2375").is_err());
}

/// Windows reaches SSH engines; local socket engines exist only on Unix.
#[test]
#[cfg(windows)]
fn windows_reaches_ssh_engines_and_rejects_local_sockets() {
    let local = "unix:///var/run/docker.sock";
    crate::config::validate_engine_endpoint(local).unwrap();
    let error = Engine::connect(local)
        .err()
        .expect("a local socket engine on Windows");
    assert!(
        error
            .to_string()
            .contains("local container-engine connections are unsupported on this platform"),
        "{error}"
    );
    // Connecting opens no transport; requests run ssh.
    Engine::connect("ssh://operator@gpu-box:2222").unwrap();
}
