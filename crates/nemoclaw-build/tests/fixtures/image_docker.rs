// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Docker command-boundary double. It never calls a daemon.
use std::{env, fs::OpenOptions, io::Write};

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    writeln!(
        OpenOptions::new()
            .create(true)
            .append(true)
            .open("docker.log")
            .unwrap(),
        "{}",
        args.join("\0")
    )
    .unwrap();
    if env::var("FAIL_DOCKER").is_ok_and(|pattern| args.join(" ").contains(&pattern)) {
        std::process::exit(1);
    }
    let response = match args
        .iter()
        .map(String::as_str)
        .collect::<Vec<_>>()
        .as_slice()
    {
        ["buildx", "bake", "--print", ..] => Some("BAKE_PLAN"),
        ["run", ..] if args.iter().any(|arg| arg == "--installed") => Some("CATALOG"),
        ["run", ..] => Some("BRIDGE"),
        ["image", "inspect", ..] => Some("INSPECTION"),
        ["buildx", "bake", ..] | ["image", "rm", ..] | ["image", "load", ..] | ["build", ..] => {
            None
        }
        _ => panic!("unexpected Docker call: {args:?}"),
    };
    if let Some(response) = response {
        println!("{}", env::var(response).unwrap());
    }
}
