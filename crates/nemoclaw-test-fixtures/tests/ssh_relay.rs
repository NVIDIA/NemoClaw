// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! The fake `ssh` relays docker dial-stdio to a loopback engine and fails
//! like `ssh` for anything else. Building this test also builds the relay
//! that fake engines find beside the test executables.

use std::{
    io::{Read, Write},
    net::TcpListener,
    process::{Command, Stdio},
};

const RELAY: &str = env!("CARGO_BIN_EXE_nemoclaw-fixture-ssh");

#[test]
fn dial_stdio_reaches_the_loopback_engine() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let mut request = [0; 64];
        let read = stream.read(&mut request).unwrap();
        assert!(request[..read].starts_with(b"GET /_ping"));
        stream
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nOK")
            .unwrap();
    });
    let mut relay = Command::new(RELAY)
        .args(["-T", "-o", "BatchMode=yes", "--"])
        .arg(format!("ssh://127.0.0.1:{port}"))
        .args(["docker", "system", "dial-stdio"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    relay
        .stdin
        .take()
        .unwrap()
        .write_all(b"GET /_ping HTTP/1.1\r\nHost: docker\r\n\r\n")
        .unwrap();
    let output = relay.wait_with_output().unwrap();
    server.join().unwrap();
    assert!(output.status.success());
    assert!(String::from_utf8_lossy(&output.stdout).ends_with("\r\n\r\nOK"));
}

#[test]
fn anything_but_a_loopback_dial_stdio_fails_like_ssh() {
    for args in [
        vec!["--", "ssh://127.0.0.1:1", "uname"],
        vec!["--", "ssh://gpu-box", "docker", "system", "dial-stdio"],
        vec!["ssh://127.0.0.1:1", "docker", "system", "dial-stdio"],
    ] {
        let output = Command::new(RELAY).args(&args).output().unwrap();
        assert_eq!(output.status.code(), Some(255), "{args:?}");
    }
}
