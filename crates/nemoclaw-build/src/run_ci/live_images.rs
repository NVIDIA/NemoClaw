// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Build the live suites' images, or share them: `ci live-images` builds a
//! platform's images once and saves them, and each live step loads that
//! archive under its own names instead of building.

use super::*;

/// The repository the shared archive names its images under.
const SHARED: &str = "nc-live-images";
/// Where `ci live-images` writes the shared archive.
const ARCHIVE: &str = ".build/ci/live-images.tar.zst";

fn docker() -> Command {
    let mut command = Command::new("docker");
    command.stdin(Stdio::null());
    command
}

/// The agent image a platform's live tests run, and its Fabric harness. Pi is
/// the smaller image but is built only for ARM64; OpenClaw is built for both.
pub(super) fn agent(platform: &str) -> (&'static str, &'static str) {
    if platform == "linux_arm64" {
        ("pi", "nvidia.fabric.pi")
    } else {
        ("openclaw", "nvidia.fabric.openclaw")
    }
}

/// The platform's agent image, then the two proxy images.
pub(super) fn names(platform: &str) -> [&'static str; 3] {
    [agent(platform).0, "proxy-a", "proxy-b"]
}

/// Build the platform's agent image as `PREFIX:TARGET`.
pub(super) fn build_agent(platform: &str, prefix: &str) -> Result<()> {
    let target = agent(platform).0;
    let docker_platform = format!("linux/{}", platform.trim_start_matches("linux_"));
    let status = Command::new(std::env::current_exe()?)
        .args(["images", "build", "--platform", &docker_platform, target])
        .env("IMAGE_PREFIX", prefix)
        .stdin(Stdio::null())
        .status()?;
    if !status.success() {
        return Err(format!("cannot build the {target} agent image").into());
    }
    Ok(())
}

/// Two proxy images with distinct digests, for the image-change check.
pub(super) fn build_proxies(prefix: &str) -> Result<()> {
    for variant in ["a", "b"] {
        run(docker()
            .args(["buildx", "build", "--load", "--quiet"])
            .args(["-f", "image/ollama-proxy/Dockerfile", "--target", "runtime"])
            .args(["--label", &format!("org.nemoclaw.test=proxy-{variant}")])
            .args(["--tag", &format!("{prefix}:proxy-{variant}"), "."]))?;
    }
    Ok(())
}

/// Build the platform's images under the shared names and save them to
/// [`ARCHIVE`], streamed through zstd: uncompressed, they are gigabytes.
pub(super) fn build(platform: &str) -> Result<()> {
    if !platform.starts_with("linux_") {
        return Err("the live images are built on Linux only".into());
    }
    build_agent(platform, SHARED)?;
    build_proxies(SHARED)?;
    let tags = names(platform).map(|name| format!("{SHARED}:{name}"));
    fs::create_dir_all(".build/ci")?;
    let mut save = docker()
        .arg("save")
        .args(&tags)
        .stdout(Stdio::piped())
        .spawn()?;
    let images = save.stdout.take().ok_or("cannot read the saved images")?;
    let compressed = Command::new("zstd")
        .args(["-T0", "-3", "-q", "-f", "-o", ARCHIVE])
        .stdin(images)
        .status()
        .map_err(|_| "saving the live images needs the zstd command")?;
    let saved = save.wait()?;
    // The archive holds them; the local names would only take space.
    for tag in &tags {
        let _ = docker()
            .args(["image", "rm", tag])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    if !saved.success() || !compressed.success() {
        return Err("cannot save the live images".into());
    }
    Ok(())
}

/// Load the shared images from `archive` and name each of `names` as
/// `PREFIX:NAME`, recording each new name in `owned` before the next, so the
/// caller removes whatever this run created.
pub(super) fn load(
    archive: &Path,
    prefix: &str,
    names: &[&str],
    owned: &mut Vec<String>,
) -> Result<()> {
    let mut unpack = Command::new("zstd")
        .args(["-d", "-c", "-q"])
        .arg(archive)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .spawn()
        .map_err(|_| "loading the live images needs the zstd command")?;
    let images = unpack.stdout.take().ok_or("cannot read the live images")?;
    let loaded = Command::new("docker")
        .arg("load")
        .stdin(images)
        .stdout(Stdio::null())
        .status()?;
    if !unpack.wait()?.success() || !loaded.success() {
        return Err(format!("cannot load the live images from {}", archive.display()).into());
    }
    for name in names {
        let shared = format!("{SHARED}:{name}");
        let tag = format!("{prefix}:{name}");
        run(docker().args(["tag", &shared, &tag]))?;
        owned.push(tag);
        // Removing the shared name keeps the image, which the new name holds.
        let _ = docker()
            .args(["image", "rm", &shared])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    Ok(())
}
