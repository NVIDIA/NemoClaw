// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use nemoclaw_fast_backend::{compile, Backend, CompileRequest, ProcessRunner};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

fn main() {
    if let Err(error) = run() {
        eprintln!("fast backend: {error}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), String> {
    let mut args = std::env::args().skip(1);
    if args.next().as_deref() != Some("compile") {
        return Err("usage: nemoclaw-fast-backend compile --input IR --output OBJECT --bridge TPDE_BRIDGE --llc LLVM_LLC [--backend tpde|llvm] [--llvm-codegen-opt-level 0|1|2|3] [--allow-fallback] [--report JSON] [--timeout-seconds 180]".into());
    }
    let mut values = BTreeMap::new();
    let mut allow_fallback = false;
    while let Some(arg) = args.next() {
        if arg == "--allow-fallback" {
            if allow_fallback {
                return Err("duplicate --allow-fallback".into());
            }
            allow_fallback = true;
            continue;
        }
        if ![
            "--input",
            "--output",
            "--bridge",
            "--llc",
            "--backend",
            "--llvm-codegen-opt-level",
            "--report",
            "--timeout-seconds",
        ]
        .contains(&arg.as_str())
        {
            return Err(format!("unknown argument: {arg}"));
        }
        let value = args
            .next()
            .ok_or_else(|| format!("missing value for {arg}"))?;
        if values.insert(arg.clone(), value).is_some() {
            return Err(format!("duplicate {arg}"));
        }
    }
    let required = |key: &str| -> Result<PathBuf, String> {
        values
            .get(key)
            .map(PathBuf::from)
            .ok_or_else(|| format!("missing {key}"))
    };
    let request = CompileRequest {
        input: required("--input")?,
        output: required("--output")?,
        bridge: required("--bridge")?,
        llc: required("--llc")?,
        allow_fallback,
        llvm_codegen_opt_level: parse_llvm_codegen_opt_level(
            values.get("--llvm-codegen-opt-level").map(String::as_str),
        )?,
        backend: match values
            .get("--backend")
            .map(String::as_str)
            .unwrap_or("tpde")
        {
            "tpde" => Backend::Tpde,
            "llvm" => Backend::Llvm,
            value => return Err(format!("unknown backend: {value}")),
        },
    };
    let timeout = values.get("--timeout-seconds").map_or(Ok(180), |v| {
        v.parse::<u64>().map_err(|_| "invalid --timeout-seconds")
    })?;
    if timeout == 0 {
        return Err("timeout must be positive".into());
    }
    if let Some(path) = values.get("--report") {
        if Path::new(path) == request.output || Path::new(path) == request.input {
            return Err("report path must differ from input and output".into());
        }
        if Path::new(path).exists() {
            return Err("report already exists".into());
        }
    }
    let report = compile(
        &request,
        &mut ProcessRunner {
            timeout: Duration::from_secs(timeout),
        },
    )?;
    let json = report.to_json();
    if let Some(path) = values.get("--report") {
        use std::io::Write;
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)
            .map_err(|e| format!("create report: {e}"))?;
        file.write_all(json.as_bytes())
            .map_err(|e| format!("write report: {e}"))?;
    }
    print!("{json}");
    Ok(())
}

fn parse_llvm_codegen_opt_level(value: Option<&str>) -> Result<u8, String> {
    match value.unwrap_or("0") {
        "0" => Ok(0),
        "1" => Ok(1),
        "2" => Ok(2),
        "3" => Ok(3),
        _ => Err("--llvm-codegen-opt-level must be 0, 1, 2 or 3".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::parse_llvm_codegen_opt_level;

    #[test]
    fn llvm_codegen_flag_defaults_to_zero_and_rejects_other_values() {
        assert_eq!(parse_llvm_codegen_opt_level(None).unwrap(), 0);
        for level in 0..=3 {
            assert_eq!(
                parse_llvm_codegen_opt_level(Some(&level.to_string())).unwrap(),
                level
            );
        }
        for invalid in ["4", "-1", "s", "z", "O2", "", "02"] {
            assert!(parse_llvm_codegen_opt_level(Some(invalid)).is_err());
        }
    }
}
