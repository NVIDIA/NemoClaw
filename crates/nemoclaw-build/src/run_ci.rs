// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Run `CI / Native` steps with the same commands, environment, and tools as CI.

use super::*;
use nemoclaw_build::ci::{self, Step};
use std::{ffi::OsString, time::Instant};

const TOOLS: &str = ".tools";

/// The host's bundle platform, matching the SDK's detection without needing it.
fn host_platform() -> Result<String> {
    let os = match std::env::consts::OS {
        "linux" => "linux",
        "macos" => "darwin",
        "windows" => "windows",
        _ => return Err("unsupported CI host operating system".into()),
    };
    let arch = match std::env::consts::ARCH {
        "aarch64" => "arm64",
        "x86_64" => "amd64",
        _ => return Err("unsupported CI host architecture".into()),
    };
    Ok(format!("{os}_{arch}"))
}

fn protoc_directory(version: &str) -> PathBuf {
    Path::new(TOOLS).join(format!("protoc-{version}"))
}

fn nextest_directory(version: &str) -> PathBuf {
    Path::new(TOOLS).join(format!("nextest-{version}"))
}

/// `PROTOC` when set, otherwise the installed pinned compiler, otherwise `PATH`.
pub(super) fn protoc_command(version: &str) -> PathBuf {
    if let Some(explicit) = std::env::var_os("PROTOC") {
        return explicit.into();
    }
    let installed = protoc_directory(version)
        .join("bin")
        .join(nemoclaw_build_executable("protoc"));
    if installed.is_file() {
        return std::path::absolute(installed).unwrap_or_else(|_| "protoc".into());
    }
    "protoc".into()
}

fn nemoclaw_build_executable(name: &str) -> String {
    format!("{name}{}", std::env::consts::EXE_SUFFIX)
}

pub(super) fn protoc_matches(command: &Path, version: &str) -> bool {
    Command::new(command)
        .arg("--version")
        .stdin(Stdio::null())
        .output()
        .is_ok_and(|output| {
            output.status.success()
                && String::from_utf8_lossy(&output.stdout).trim() == format!("libprotoc {version}")
        })
}

fn nextest_matches(path: &OsString, version: &str) -> bool {
    cargo()
        .args(["nextest", "--version"])
        .env("PATH", path)
        .stdin(Stdio::null())
        .output()
        .is_ok_and(|output| {
            output.status.success()
                && String::from_utf8_lossy(&output.stdout)
                    .starts_with(&format!("cargo-nextest {version}"))
        })
}

/// Pinned tool versions that every step uses.
struct Tools<'a> {
    pins: &'a Pins,
    protobuf: &'a str,
    nextest: &'a str,
}

fn artifact<'a>(pins: &'a Pins, platform: &str, tool: &str) -> Result<&'a Artifact> {
    pins.platforms
        .get(platform)
        .and_then(|artifacts| artifacts.get(tool))
        .ok_or_else(|| format!("versions.json has no {tool} pin for {platform}").into())
}

/// Install pinned tools that are missing or have the wrong version.
async fn install_tools(tools: &Tools<'_>, platform: &str) -> Result<()> {
    let Tools { pins, .. } = tools;
    let windows = platform.starts_with("windows");
    if !protoc_matches(&protoc_command(tools.protobuf), tools.protobuf) {
        let bytes = download(artifact(pins, platform, "protoc")?).await?;
        ci::install_protoc(&bytes, &protoc_directory(tools.protobuf), windows)?;
        eprintln!("Installed protoc {} in {TOOLS}", tools.protobuf);
    }
    if !nextest_matches(&tool_path(tools)?, tools.nextest) {
        let bytes = download(artifact(pins, platform, "nextest")?).await?;
        ci::install_nextest(&bytes, &nextest_directory(tools.nextest), windows)?;
        eprintln!("Installed cargo-nextest {} in {TOOLS}", tools.nextest);
    }
    if !protoc_matches(&protoc_command(tools.protobuf), tools.protobuf) {
        return Err(format!(
            "PROTOC does not run Protocol Buffers compiler {}; unset it or point it at that version",
            tools.protobuf
        )
        .into());
    }
    if !nextest_matches(&tool_path(tools)?, tools.nextest) {
        return Err(format!(
            "cargo-nextest {} is not runnable after installation",
            tools.nextest
        )
        .into());
    }
    export_to_github(tools)
}

/// `PATH` with the pinned nextest first, so Cargo finds its subcommand.
fn tool_path(tools: &Tools<'_>) -> Result<OsString> {
    let mut paths = vec![std::path::absolute(nextest_directory(tools.nextest))?];
    paths.extend(std::env::split_paths(
        &std::env::var_os("PATH").unwrap_or_default(),
    ));
    Ok(std::env::join_paths(paths)?)
}

/// Make installed tools visible to later workflow steps that build the SDK directly.
fn export_to_github(tools: &Tools<'_>) -> Result<()> {
    let append = |variable: &str, line: String| -> Result<()> {
        if let Some(file) = std::env::var_os(variable) {
            let mut file = fs::OpenOptions::new().append(true).open(file)?;
            writeln!(file, "{line}")?;
        }
        Ok(())
    };
    let protoc = protoc_command(tools.protobuf);
    append("GITHUB_ENV", format!("PROTOC={}", protoc.display()))?;
    append(
        "GITHUB_PATH",
        std::path::absolute(nextest_directory(tools.nextest))?
            .display()
            .to_string(),
    )
}

/// Run one step with the pinned tools, without inheriting stdin.
fn run_step(tools: &Tools<'_>, platform: &str, step: Step) -> Result<()> {
    let protoc = protoc_command(tools.protobuf);
    let path = tool_path(tools)?;
    let configure = |command: &mut Command| {
        command.env("PROTOC", &protoc).env("PATH", &path);
    };
    let tool = |name: &str| {
        Path::new("target")
            .join("debug")
            .join(nemoclaw_build_executable(name))
    };
    match step {
        Step::Tools => unreachable!("tools install in-process"),
        Step::Schema | Step::Bundle => {
            let mut command = Command::new(tool("nemoclaw-build"));
            configure(&mut command);
            if step == Step::Schema {
                command.args(["schema", "--check"]);
            } else {
                command.args(["bundle", "--platform", platform]);
            }
            return run(&mut command);
        }
        _ => {}
    }
    let bundle = std::path::absolute(Path::new("dist").join(platform))?;
    for args in step.cargo_args() {
        let mut command = cargo();
        configure(&mut command);
        command.args(*args);
        if step == Step::Lifecycle {
            command
                .env("NEMOCLAW_TEST_BUNDLE", &bundle)
                .env(
                    "NEMOCLAW_TEST_TOFU",
                    bundle
                        .join("libexec")
                        .join(nemoclaw_build_executable("tofu")),
                )
                .env(
                    "NEMOCLAW_TEST_PROVIDER",
                    std::path::absolute(tool("terraform-provider-nemoclaw"))?,
                );
        }
        run(&mut command)?;
    }
    Ok(())
}

pub(super) async fn run_steps(pins: &Pins, selected: Option<&str>) -> Result<()> {
    let nextest = pins
        .nextest
        .as_deref()
        .ok_or("versions.json must pin nextest for cargo ci")?;
    let tools = Tools {
        pins,
        protobuf: &pins.protobuf,
        nextest,
    };
    let steps = match selected {
        None => Step::ALL.to_vec(),
        Some(name) => vec![Step::parse(name).ok_or_else(|| {
            format!(
                "unknown CI step {name:?}; choose one of: {}",
                Step::ALL.map(Step::name).join(", ")
            )
        })?],
    };
    // CI names its platform; locally, the host decides.
    let platform = match std::env::var("TEST_PLATFORM") {
        Ok(platform) if !platform.is_empty() => platform,
        _ => host_platform()?,
    };
    ci::nextest_target(&platform)?;
    let start = Instant::now();
    // Every step uses the pinned tools; install them once, up front, if a
    // step other than `tools` is selected alone.
    let mut steps = steps;
    if steps.first() != Some(&Step::Tools) {
        steps.insert(0, Step::Tools);
    }
    for step in steps {
        let begun = Instant::now();
        eprintln!("==> {} ({platform})", step.name());
        let result = if step == Step::Tools {
            install_tools(&tools, &platform).await
        } else {
            run_step(&tools, &platform, step)
        };
        let elapsed = begun.elapsed().as_secs();
        if let Err(error) = result {
            eprintln!("FAILED {} after {elapsed}s: {error}", step.name());
            eprintln!("Rerun it with: cargo ci {}", step.name());
            return Err(format!("CI step {} failed", step.name()).into());
        }
        eprintln!("ok {} in {elapsed}s", step.name());
    }
    eprintln!(
        "All selected CI steps passed in {}s",
        start.elapsed().as_secs()
    );
    Ok(())
}
