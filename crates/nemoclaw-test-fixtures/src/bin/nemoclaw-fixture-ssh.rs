// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! A fake `ssh` for fake container engines on platforms without Unix sockets.
//!
//! NemoClaw reaches an SSH engine with `ssh [options] -- TARGET docker system
//! dial-stdio`. For a TARGET of `ssh://127.0.0.1:PORT`, this relays standard
//! input and output to that loopback port, where a fixture serves the engine
//! API. Anything else fails as `ssh` does, with status 255.

use std::{
    io::{Read, Write},
    net::{Shutdown, TcpStream},
    process::ExitCode,
};

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let Some(separator) = args.iter().position(|arg| arg == "--") else {
        eprintln!("nemoclaw-fixture-ssh: expected -- before the target");
        return ExitCode::from(255);
    };
    let (target, command) = match &args[separator + 1..] {
        [target, command @ ..] => (target, command),
        [] => {
            eprintln!("nemoclaw-fixture-ssh: missing target");
            return ExitCode::from(255);
        }
    };
    if command != ["docker", "system", "dial-stdio"] {
        eprintln!("nemoclaw-fixture-ssh: only docker system dial-stdio is relayed");
        return ExitCode::from(255);
    }
    let Some(address) = target
        .strip_prefix("ssh://127.0.0.1:")
        .and_then(|port| port.parse::<u16>().ok())
        .map(|port| std::net::SocketAddr::from(([127, 0, 0, 1], port)))
    else {
        eprintln!("nemoclaw-fixture-ssh: the target must be ssh://127.0.0.1:PORT");
        return ExitCode::from(255);
    };
    let Ok(stream) = TcpStream::connect(address) else {
        eprintln!("nemoclaw-fixture-ssh: cannot connect to the fixture engine");
        return ExitCode::from(255);
    };
    let mut upstream = stream.try_clone().unwrap();
    let requests = std::thread::spawn(move || {
        let mut stdin = std::io::stdin().lock();
        let _ = std::io::copy(&mut stdin, &mut upstream);
        let _ = upstream.shutdown(Shutdown::Write);
    });
    let mut downstream = stream;
    let mut stdout = std::io::stdout().lock();
    let mut buffer = [0; 8192];
    // The fixture closes after each response; relay until it does.
    loop {
        match downstream.read(&mut buffer) {
            Ok(0) | Err(_) => break,
            Ok(read) => {
                if stdout.write_all(&buffer[..read]).is_err() || stdout.flush().is_err() {
                    break;
                }
            }
        }
    }
    drop(requests);
    ExitCode::SUCCESS
}
