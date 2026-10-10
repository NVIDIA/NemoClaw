// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Build immutable standard-Rust output references before entering the CUDA image.

use std::{env, fs, path::Path, process::Command};

const DEMO: &str = include_str!("../../../fixtures/compiler_demo.rs");
const EDGES: &str = r#"// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
fn choose(value: i64, flag: bool) -> i64 {
    if flag && value > 0 { return value * 3; }
    return value - 5;
}
fn main() -> i64 {
    let mut sum: i64 = 0;
    let mut index: i64 = 0;
    while index < 20 {
        sum = sum + choose(index, index % 2 == 0);
        index = index + 1;
    }
    if false && 1 / 0 > 0 { return 999; }
    if true || 1 / 0 > 0 { sum = sum + 7; }
    return (sum << 67) ^ (-41 >> 65);
}
"#;
const CHANGED: &str = r#"// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
fn main() -> i64 {
    let mut index: i64 = 9;
    let mut total: i64 = 0;
    while index > 0 {
        if index % 2 == 0 { total = total + index * 7; }
        else { total = total - index; }
        index = index - 1;
    }
    return total;
}
"#;

fn run() -> Result<(), String> {
    let arguments = env::args_os().skip(1).collect::<Vec<_>>();
    if arguments.len() != 1 {
        return Err("Usage: gpu-reference-programs OUTPUT_DIRECTORY (requires rustc)".into());
    }
    let directory = Path::new(&arguments[0]);
    fs::create_dir_all(directory).map_err(|error| error.to_string())?;
    let identity = Command::new("rustc")
        .arg("--version")
        .arg("--verbose")
        .output()
        .map_err(|error| format!("Cannot run rustc: {error}"))?;
    if !identity.status.success() {
        return Err(String::from_utf8_lossy(&identity.stderr).into_owned());
    }
    fs::write(directory.join("rustc-version.txt"), &identity.stdout)
        .map_err(|error| error.to_string())?;
    for (name, source) in [("demo", DEMO), ("semantics", EDGES), ("changed", CHANGED)] {
        let source_path = directory.join(format!("{name}.rs"));
        let harness_path = directory.join(format!("{name}-reference.rs"));
        let executable = directory.join(format!("{name}-reference"));
        fs::write(&source_path, source).map_err(|error| error.to_string())?;
        // Runtime shifts and short-circuit arithmetic avoid Rust's compile-time
        // constant-overflow lint; both compilers use wrapping arithmetic here.
        let harness = source.replace("fn main() -> i64", "fn program_main() -> i64");
        fs::write(
            &harness_path,
            format!("{harness}\nfn main() {{ println!(\"{{}}\", program_main()); }}\n"),
        )
        .map_err(|error| error.to_string())?;
        let compiled = Command::new("rustc")
            .args([
                "--edition=2021",
                "-Awarnings",
                "-Aunconditional_panic",
                "-Aarithmetic_overflow",
            ])
            .args(["-C", "overflow-checks=off", "-C", "opt-level=0"])
            .arg(&harness_path)
            .arg("-o")
            .arg(&executable)
            .output()
            .map_err(|error| error.to_string())?;
        if !compiled.status.success() {
            return Err(format!(
                "{name}: {}",
                String::from_utf8_lossy(&compiled.stderr)
            ));
        }
        let result = Command::new(&executable)
            .output()
            .map_err(|error| error.to_string())?;
        if !result.status.success() || !result.stderr.is_empty() {
            return Err(format!("{name}: reference executable failed"));
        }
        fs::write(
            directory.join(format!("{name}.expected.txt")),
            &result.stdout,
        )
        .map_err(|error| error.to_string())?;
    }
    fs::write(directory.join("programs.txt"), "demo\nsemantics\nchanged\n")
        .map_err(|error| error.to_string())?;
    println!("Built standard-Rust references: {}", directory.display());
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
