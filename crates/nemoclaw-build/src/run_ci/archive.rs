// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Inputs nextest cannot discover from test executable metadata.

use super::*;
use std::collections::BTreeMap;

pub(super) fn package_inputs(tools: &Tools<'_>) -> Result<()> {
    let output = fs::File::create(".build/ci/lifecycle-inputs.tar")?;
    // Leave compression to the artifact uploader; gzip in this debug build is slow.
    let mut archive = tar::Builder::new(output);
    // Tar preserves executable permissions across artifact upload/download. The
    // bundle job uploads dist/PLATFORM separately, so it can build in parallel.
    for directory in [
        protoc_directory(tools.protobuf),
        nextest_directory(tools.nextest),
    ] {
        archive.append_dir_all(&directory, &directory)?;
    }
    archive.append_path_with_name(
        std::env::current_exe()?,
        Path::new(".build/ci").join(nemoclaw_build_executable("nemoclaw-build")),
    )?;
    // Tests from other packages start these from NEMOCLAW_TEST_FIXTURES, and
    // the lifecycle step puts the fake ssh first on PATH where Unix sockets
    // are missing. The providers need no copy here: the bundle ships them, and
    // nextest archives each provider package's executables with its tests.
    for name in [
        "nemoclaw-fixture-control",
        "nemoclaw-fixture-provider",
        "nemoclaw-fixture-ssh",
        "nemoclaw-fixture-ssh-simulator",
    ] {
        archive.append_path(Path::new("target/debug").join(nemoclaw_build_executable(name)))?;
    }
    archive.finish()?;
    Ok(())
}

/// Each test layer's archive, which only that layer's jobs download, and the
/// nextest profiles whose test binaries it holds. Only Linux runs the live
/// suites, from their own archive instead of compiling.
pub(super) fn layers(platform: &str) -> Vec<(&'static str, &'static [&'static str])> {
    let mut layers: Vec<(&'static str, &'static [&'static str])> = vec![
        ("contract", &["contract"]),
        ("integration", &["integration"]),
    ];
    if platform.starts_with("linux_") {
        layers.push(("live", &["live-docker", "live-kind"]));
    }
    layers
}

/// Where `ci archive` writes a layer's archive.
pub(super) fn file(layer: &str) -> PathBuf {
    Path::new(".build/ci").join(format!("{layer}.tar.zst"))
}

/// Where `ci archive` copies the e2e test executable, which the hosted and
/// GPU HCL case jobs run without the rest of the live archive.
pub(super) const E2E: &str = ".build/ci/e2e";

/// The e2e test binary's nextest ID.
const E2E_BINARY: &str = "nemoclaw-e2e::e2e";

/// Select from nextest's resolved profiles rather than maintaining a second
/// suite list. Returns the filterset and the path of each selected test
/// binary, from nextest's listing.
pub(super) fn selected_binaries(
    configure: &impl Fn(&mut Command),
    layer: &str,
    profiles: &[&str],
) -> Result<(String, BTreeMap<String, PathBuf>)> {
    use serde::Deserialize;

    #[derive(Deserialize)]
    struct Listing {
        #[serde(rename = "rust-suites")]
        suites: BTreeMap<String, Suite>,
    }
    #[derive(Deserialize)]
    struct Suite {
        #[serde(rename = "binary-path")]
        binary_path: Option<PathBuf>,
        testcases: BTreeMap<String, Test>,
    }
    #[derive(Deserialize)]
    struct Test {
        #[serde(rename = "filter-match")]
        filter_match: FilterMatch,
    }
    #[derive(Deserialize)]
    struct FilterMatch {
        status: MatchStatus,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "kebab-case")]
    enum MatchStatus {
        Matches,
        Mismatch,
    }

    let mut binaries = BTreeMap::new();
    for profile in profiles {
        let mut command = cargo();
        configure(&mut command);
        let output = command
            .args([
                "nextest",
                "list",
                "--locked",
                "--workspace",
                "--all-targets",
                "--profile",
                profile,
                "--run-ignored",
                "only",
                "--message-format",
                "json",
            ])
            .stdin(Stdio::null())
            .stderr(Stdio::inherit())
            .output()?;
        if !output.status.success() {
            return Err(format!("listing {profile} tests failed: {}", output.status).into());
        }
        let listing: Listing = serde_json::from_slice(&output.stdout)?;
        binaries.extend(
            listing
                .suites
                .into_iter()
                .filter(|(_, suite)| {
                    suite
                        .testcases
                        .values()
                        .any(|test| matches!(test.filter_match.status, MatchStatus::Matches))
                })
                .map(|(id, suite)| (id, suite.binary_path)),
        );
    }
    if binaries.is_empty() {
        return Err(format!("no {layer} test binaries were selected").into());
    }
    let filter = binaries
        .keys()
        .map(|id| format!("binary_id(={id})"))
        .collect::<Vec<_>>()
        .join(" | ");
    let paths = binaries
        .into_iter()
        .filter_map(|(id, path)| Some((id, path?)))
        .collect();
    Ok((filter, paths))
}

/// Copy the e2e test executable to [`E2E`] when the live archive holds it.
/// The workflow's upload fails when it is missing.
pub(super) fn copy_e2e(paths: &BTreeMap<String, PathBuf>) -> Result<()> {
    if let Some(executable) = paths.get(E2E_BINARY) {
        fs::copy(executable, E2E)?;
    }
    Ok(())
}
