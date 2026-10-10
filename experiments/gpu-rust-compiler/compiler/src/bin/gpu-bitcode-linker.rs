// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use gpu_rust_compiler::bitcode_linker::{run_with, ProcessRunner, WrapperOptions};
use std::path::PathBuf;

fn main() {
    let result = (|| {
        let mut args = std::env::args_os().skip(1);
        let rustc = PathBuf::from(
            args.next()
                .ok_or("RUSTC_WRAPPER requires the original rustc path")?,
        );
        run_with(
            &rustc,
            &args.collect::<Vec<_>>(),
            &WrapperOptions::from_env()?,
            &mut ProcessRunner,
        )
    })();
    match result {
        Ok(outcome) => {
            if let Some(error) = outcome.report.error {
                eprintln!("GPU object bridge: {error}");
            }
            std::process::exit(outcome.exit_code);
        }
        Err(error) => {
            eprintln!("GPU object bridge: {error}");
            std::process::exit(1);
        }
    }
}
