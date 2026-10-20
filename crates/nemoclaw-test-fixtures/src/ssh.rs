// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Fake `ssh` executables: the relay to fake container engines on platforms
//! without Unix sockets, shared by `nemoclaw-fixture-ssh` and the SSH
//! simulator `nemoclaw-fixture-ssh-simulator`, and the simulator's installation.
//!
//! NemoClaw reaches an SSH engine with `ssh [options] -- TARGET docker system
//! dial-stdio`. For a TARGET of `ssh://127.0.0.1:PORT`, [`relay`] copies
//! standard input and output to that loopback port, where a fixture serves the
//! engine API.

use std::{
    io::{Read, Write},
    net::{Shutdown, SocketAddr, TcpStream},
    process::ExitCode,
};

/// The fixture engine address an `ssh` command line names, if it dials one.
#[must_use]
pub fn fixture_engine(args: &[String]) -> Option<SocketAddr> {
    let separator = args.iter().position(|arg| arg == "--")?;
    let [target, command @ ..] = &args[separator + 1..] else {
        return None;
    };
    if command != ["docker", "system", "dial-stdio"] {
        return None;
    }
    // NemoClaw passes `ssh://127.0.0.1:PORT`; Docker's client, which
    // OpenTofu's Docker provider uses, passes `-p PORT` and the host.
    let port = match target.strip_prefix("ssh://127.0.0.1:") {
        Some(port) => port,
        None if target == "127.0.0.1" => {
            let options = &args[..separator];
            let flag = options.iter().position(|arg| arg == "-p")?;
            options.get(flag + 1)?
        }
        None => return None,
    };
    port.parse::<u16>()
        .ok()
        .map(|port| SocketAddr::from(([127, 0, 0, 1], port)))
}

/// Relay standard input and output to the fixture engine at `address`.
pub fn relay(address: SocketAddr) -> ExitCode {
    let Ok(stream) = TcpStream::connect(address) else {
        eprintln!("fake ssh: cannot connect to the fixture engine");
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

/// The file beside an installed SSH simulator that names its state directory.
pub const SIMULATOR_ROOT: &str = "nemoclaw-test-remote";

/// Install the SSH simulator as `ssh` in `bin`, recording `root` beside it
/// for callers that do not pass `NEMOCLAW_TEST_REMOTE` on.
pub fn install_simulator(bin: &std::path::Path, root: &std::path::Path) {
    std::fs::create_dir_all(bin).unwrap();
    std::fs::copy(
        crate::fixture_executable("nemoclaw-fixture-ssh-simulator"),
        bin.join(crate::executable("ssh")),
    )
    .unwrap();
    std::fs::write(bin.join(SIMULATOR_ROOT), root.to_str().unwrap()).unwrap();
}

#[cfg(test)]
mod tests {
    use super::fixture_engine;
    use std::net::SocketAddr;

    fn args(line: &str) -> Vec<String> {
        line.split(' ').map(str::to_owned).collect()
    }

    /// NemoClaw names the engine as a URL; Docker's client, which OpenTofu's
    /// Docker provider uses, passes a host and `-p PORT`.
    #[test]
    fn both_engine_dialers_reach_the_fixture() {
        let fixture = Some(SocketAddr::from(([127, 0, 0, 1], 56829)));
        assert_eq!(
            fixture_engine(&args("-- ssh://127.0.0.1:56829 docker system dial-stdio")),
            fixture
        );
        assert_eq!(
            fixture_engine(&args(
                "-p 56829 -o ConnectTimeout=30 -T -- 127.0.0.1 docker system dial-stdio"
            )),
            fixture
        );
        for other in [
            "-p 56829 -T -- 10.0.0.1 docker system dial-stdio",
            "-T -- 127.0.0.1 docker system dial-stdio",
            "-p 56829 -T -- 127.0.0.1 uname",
        ] {
            assert_eq!(fixture_engine(&args(other)), None, "{other}");
        }
    }
}
