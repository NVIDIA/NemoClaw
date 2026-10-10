// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Inputs nextest cannot discover from test executable metadata.

use super::*;

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
    // Protocol fixtures locate sibling providers beside this explicit binary,
    // and the fake ssh that reaches fake engines where Unix sockets are missing.
    for name in [
        "terraform-provider-nemoclaw",
        "terraform-provider-openshell",
        "terraform-provider-fabric",
        "nemoclaw-fixture-ssh",
    ] {
        let path = Path::new("target/debug").join(nemoclaw_build_executable(name));
        archive.append_path(&path)?;
    }
    archive.finish()?;
    Ok(())
}

/// Select from nextest's resolved profile rather than maintaining a second suite list.
pub(super) fn selected_binaries(configure: &impl Fn(&mut Command)) -> Result<String> {
    use serde::Deserialize;
    use std::collections::BTreeMap;

    #[derive(Deserialize)]
    struct Listing {
        #[serde(rename = "rust-suites")]
        suites: BTreeMap<String, Suite>,
    }
    #[derive(Deserialize)]
    struct Suite {
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
            "lifecycle",
            "--run-ignored",
            "only",
            "--message-format",
            "json",
        ])
        .stdin(Stdio::null())
        .stderr(Stdio::inherit())
        .output()?;
    if !output.status.success() {
        return Err(format!("listing lifecycle tests failed: {}", output.status).into());
    }
    let listing: Listing = serde_json::from_slice(&output.stdout)?;
    let binaries: Vec<_> = listing
        .suites
        .into_iter()
        .filter(|(_, suite)| {
            suite
                .testcases
                .values()
                .any(|test| matches!(test.filter_match.status, MatchStatus::Matches))
        })
        .map(|(id, _)| format!("binary_id(={id})"))
        .collect();
    if binaries.is_empty() {
        return Err("no lifecycle test binaries were selected".into());
    }
    Ok(binaries.join(" | "))
}
