// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! A fake `ssh` for fake container engines on platforms without Unix sockets.
//!
//! For `ssh [options] -- ssh://127.0.0.1:PORT docker system dial-stdio`, this
//! relays standard input and output to that loopback port, where a fixture
//! serves the engine API. Anything else fails as `ssh` does, with status 255.

use std::process::ExitCode;

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match nemoclaw_test_fixtures::ssh::fixture_engine(&args) {
        Some(address) => nemoclaw_test_fixtures::ssh::relay(address),
        None => {
            eprintln!(
                "nemoclaw-fixture-ssh: expected -- ssh://127.0.0.1:PORT docker system dial-stdio"
            );
            ExitCode::from(255)
        }
    }
}
