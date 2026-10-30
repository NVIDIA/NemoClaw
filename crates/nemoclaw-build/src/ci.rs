// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! The steps of `CI / Bundle`, runnable locally with `cargo ci`.
//!
//! This module builds without the `sdk` feature, so it can install the pinned
//! Protocol Buffers compiler before anything that needs it is compiled.

use std::{
    fs,
    io::{Cursor, Read},
    path::{Component, Path, PathBuf},
};

/// One `CI / Bundle` step, in workflow order.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Step {
    /// Install the pinned `protoc` and `cargo-nextest` into `.tools`.
    Tools,
    Fmt,
    Clippy,
    Build,
    Test,
    Schema,
    Bundle,
    Lifecycle,
    /// Package built lifecycle tests, Linux live tests, and their inputs for
    /// other runners; opt-in.
    Archive,
    /// Docker live tests; opt-in, never part of the default run.
    LiveDocker,
    /// Kubernetes live tests on a temporary kind cluster; opt-in.
    LiveKind,
    /// Build the Linux live suites' images once and save them for the live
    /// jobs to load; opt-in.
    LiveImages,
}

impl Step {
    pub const ALL: [Step; 8] = [
        Step::Tools,
        Step::Fmt,
        Step::Clippy,
        Step::Build,
        Step::Test,
        Step::Schema,
        Step::Bundle,
        Step::Lifecycle,
    ];

    pub fn name(self) -> &'static str {
        match self {
            Step::Tools => "tools",
            Step::Fmt => "fmt",
            Step::Clippy => "clippy",
            Step::Build => "build",
            Step::Test => "test",
            Step::Schema => "schema",
            Step::Bundle => "bundle",
            Step::Lifecycle => "lifecycle",
            Step::Archive => "archive",
            Step::LiveDocker => "live-docker",
            Step::LiveKind => "live-kind",
            Step::LiveImages => "live-images",
        }
    }

    pub fn parse(name: &str) -> Option<Step> {
        Step::ALL
            .into_iter()
            .chain([
                Step::Archive,
                Step::LiveDocker,
                Step::LiveKind,
                Step::LiveImages,
            ])
            .find(|step| step.name() == name)
    }

    /// The nextest profile and the JUnit report a test step writes under
    /// `target/nextest`.
    #[must_use]
    pub fn junit(self) -> Option<(&'static str, &'static str)> {
        match self {
            Step::Test => Some(("ci", "test.xml")),
            Step::Lifecycle => Some(("lifecycle", "lifecycle.xml")),
            Step::LiveDocker => Some(("live-docker", "live-docker.xml")),
            Step::LiveKind => Some(("live-kind", "live-kind.xml")),
            _ => None,
        }
    }

    /// Cargo arguments for this step. Tools, schema, and bundle run in-process
    /// or through the built tool and have none.
    pub fn cargo_args(self) -> &'static [&'static [&'static str]] {
        match self {
            Step::Tools | Step::Schema | Step::Bundle | Step::LiveImages => &[],
            Step::LiveKind => &[&[
                "nextest",
                "run",
                "--locked",
                "--workspace",
                "--all-targets",
                "--profile",
                "live-kind",
                "--run-ignored",
                "only",
            ]],
            // Selected by the live-docker nextest profile; the runner adds inputs.
            Step::LiveDocker => &[&[
                "nextest",
                "run",
                "--locked",
                "--workspace",
                "--all-targets",
                "--profile",
                "live-docker",
                "--run-ignored",
                "only",
            ]],
            Step::Archive => &[&[
                "nextest",
                "archive",
                "--locked",
                "--workspace",
                "--all-targets",
                "--archive-file",
                ".build/ci/lifecycle.tar.zst",
            ]],
            Step::Fmt => &[&["fmt", "--check"]],
            Step::Clippy => &[&[
                "clippy",
                "--locked",
                "--workspace",
                "--all-targets",
                "--",
                "-D",
                "warnings",
            ]],
            Step::Build => &[&[
                "build",
                "--locked",
                "--workspace",
                "--all-targets",
                "--timings",
            ]],
            // Nextest does not run doctests, so Cargo runs them separately.
            Step::Test => &[
                &[
                    "nextest",
                    "run",
                    "--locked",
                    "--workspace",
                    "--all-targets",
                    "--profile",
                    "ci",
                ],
                &["test", "--locked", "--workspace", "--doc"],
            ],
            // Keep the package graph identical to the build step so tests are reused.
            Step::Lifecycle => &[&[
                "nextest",
                "run",
                "--locked",
                "--workspace",
                "--all-targets",
                "--profile",
                "lifecycle",
                "--run-ignored",
                "only",
            ]],
        }
    }
}

pub mod live;
pub mod timing;

/// The nextest release target for a bundle platform.
pub fn nextest_target(platform: &str) -> Result<&'static str, String> {
    Ok(match platform {
        "linux_arm64" => "aarch64-unknown-linux-gnu",
        "linux_amd64" => "x86_64-unknown-linux-gnu",
        "darwin_arm64" | "darwin_amd64" => "universal-apple-darwin",
        "windows_amd64" => "x86_64-pc-windows-msvc",
        _ => return Err(format!("unsupported CI platform {platform}")),
    })
}

/// Join an archive path below `root`, rejecting absolute, parent, or empty paths.
fn contained(root: &Path, name: &Path) -> Result<PathBuf, String> {
    if name.as_os_str().is_empty()
        || !name
            .components()
            .all(|part| matches!(part, Component::Normal(_)))
    {
        return Err("tool archive entry escapes its directory".into());
    }
    Ok(root.join(name))
}

#[cfg(unix)]
fn make_executable(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o755))
        .map_err(|_| "cannot mark tool executable".into())
}

#[cfg(not(unix))]
fn make_executable(_: &Path) -> Result<(), String> {
    Ok(())
}

/// Replace `destination` with the extracted contents only after extraction
/// succeeds, so an interrupted install never leaves a partial tool in place.
fn replace_directory(
    destination: &Path,
    fill: impl FnOnce(&Path) -> Result<(), String>,
) -> Result<(), String> {
    let parent = destination.parent().ok_or("tool directory has no parent")?;
    fs::create_dir_all(parent).map_err(|_| "cannot create tool directory")?;
    let staging =
        tempfile::tempdir_in(parent).map_err(|_| "cannot create tool staging directory")?;
    fill(staging.path())?;
    if destination.exists() {
        fs::remove_dir_all(destination).map_err(|_| "cannot replace previous tool")?;
    }
    fs::rename(staging.keep(), destination).map_err(|_| "cannot install tool".into())
}

/// Extract a verified `protoc` release into `destination`, keeping its
/// `include` directory for well-known types. Returns the compiler path.
pub fn install_protoc(
    archive: &[u8],
    destination: &Path,
    windows: bool,
) -> Result<PathBuf, String> {
    let compiler = PathBuf::from("bin").join(if windows { "protoc.exe" } else { "protoc" });
    let mut zip =
        zip::ZipArchive::new(Cursor::new(archive)).map_err(|_| "invalid protoc archive")?;
    // Names are decoded on read; an undecodable name is not the compiler.
    if !zip
        .file_names()
        .any(|name| matches!(name, Ok(name) if Path::new(&*name) == compiler))
    {
        return Err("protoc archive lacks its compiler".into());
    }
    replace_directory(destination, |root| {
        for index in 0..zip.len() {
            let mut entry = zip
                .by_index(index)
                .map_err(|_| "unreadable protoc archive entry")?;
            let name = entry
                .name()
                .map_err(|_| "unreadable protoc archive entry")?;
            let path = contained(root, Path::new(&*name))?;
            drop(name);
            if entry.is_dir() {
                fs::create_dir_all(&path).map_err(|_| "cannot create protoc directory")?;
                continue;
            }
            if !entry.is_file() || entry.is_symlink() || entry.size() > 256 << 20 {
                return Err("unsupported protoc archive entry".into());
            }
            let mut bytes = Vec::new();
            entry
                .read_to_end(&mut bytes)
                .map_err(|_| "incomplete protoc archive entry")?;
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).map_err(|_| "cannot create protoc directory")?;
            }
            fs::write(&path, bytes).map_err(|_| "cannot write protoc file")?;
        }
        make_executable(&root.join(&compiler))
    })?;
    Ok(destination.join(compiler))
}

/// Extract the single `cargo-nextest` executable from a verified release.
pub fn install_nextest(
    archive: &[u8],
    destination: &Path,
    windows: bool,
) -> Result<PathBuf, String> {
    let name = if windows {
        "cargo-nextest.exe"
    } else {
        "cargo-nextest"
    };
    install_executable(archive, destination, name, "nextest")
}

/// Extract the single `openshell` CLI executable from a verified release.
pub fn install_openshell(archive: &[u8], destination: &Path) -> Result<PathBuf, String> {
    install_executable(archive, destination, "openshell", "OpenShell CLI")
}

/// Install the one executable `name` that a gzipped tar archive holds,
/// refusing any other entry.
fn install_executable(
    archive: &[u8],
    destination: &Path,
    name: &str,
    tool: &str,
) -> Result<PathBuf, String> {
    let mut tar = tar::Archive::new(flate2::read::GzDecoder::new(Cursor::new(archive)));
    let mut binary = None;
    for entry in tar
        .entries()
        .map_err(|_| format!("invalid {tool} archive"))?
    {
        let mut entry = entry.map_err(|_| format!("invalid {tool} archive entry"))?;
        let path = entry
            .path()
            .map_err(|_| format!("invalid {tool} archive path"))?
            .into_owned();
        if binary.is_some()
            || path != Path::new(name)
            || !entry.header().entry_type().is_file()
            || entry.size() > 256 << 20
        {
            return Err(format!("{tool} archive must contain only its executable"));
        }
        let mut bytes = Vec::new();
        entry
            .read_to_end(&mut bytes)
            .map_err(|_| format!("incomplete {tool} archive entry"))?;
        binary = Some(bytes);
    }
    let binary = binary.ok_or_else(|| format!("{tool} archive lacks its executable"))?;
    replace_directory(destination, |root| {
        let path = root.join(name);
        fs::write(&path, &binary).map_err(|_| format!("cannot write {tool}"))?;
        make_executable(&path)
    })?;
    Ok(destination.join(name))
}

/// Keep ordinary checks and select expensive steps from the shared plan.
/// Without a plan, retain every step for callers that request full validation.
pub fn planned_steps(plan: Option<&crate::changes::Plan>) -> Vec<Step> {
    Step::ALL
        .into_iter()
        .filter(|step| match (plan, step) {
            (Some(plan), Step::Bundle) => plan.bundle.run,
            (Some(plan), Step::Lifecycle) => plan.lifecycle.run,
            _ => true,
        })
        .collect()
}

/// The package `v1` pushes each commit's checked images to, tagged
/// `<image>-<commit>-<arch>`; releases promote from it.
pub const COMMIT_IMAGES: &str = "ghcr.io/nvidia/nemoclaw/v1-ci";

/// The live suites' agent image and its Fabric harness: OpenClaw, the default
/// agent image, which getting started deploys.
pub const LIVE_AGENT: (&str, &str) = ("openclaw", "nvidia.fabric.openclaw");

/// The Hermes agent image, whose interfaces the Docker live suite checks with
/// OpenClaw's.
pub const LIVE_HERMES: &str = "hermes";

/// The pushed images the live suites can pull instead of building: the agent,
/// Hermes, the reference image, and the proxy.
pub const LIVE_PULLED: [&str; 4] = [LIVE_AGENT.0, LIVE_HERMES, "dummy", "ollama-proxy"];

/// The reference `v1` pushed for `name` at `commit` on one Linux architecture.
pub fn commit_image(name: &str, commit: &str, arch: &str) -> String {
    format!("{COMMIT_IMAGES}:{name}-{commit}-{arch}")
}
