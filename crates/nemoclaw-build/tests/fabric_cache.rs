// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Source archives must compile their own code, including when their file
//! timestamps match an earlier revision in a shared Docker cache.
//!
//! Archive extraction can give different revisions the same paths, package
//! versions and file timestamps, so Cargo's fingerprints match across
//! revisions unless compiled artifacts stay with their own build layer.

use std::{path::Path, process::Command};

#[test]
#[ignore = "builds with Docker Buildx; run through cargo ci live-docker"]
fn a_new_fabric_archive_cannot_reuse_an_older_compiled_core() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let dockerfile = std::fs::read_to_string(root.join("image/fabric/Dockerfile")).unwrap();
    let rust = dockerfile
        .lines()
        .find_map(|line| line.strip_prefix("ARG RUST_IMAGE="))
        .expect("Rust image pin");
    let stage = dockerfile
        .split_once("FROM base AS common-wheels\n")
        .and_then(|(_, rest)| rest.split_once("\nFROM "))
        .expect("common-wheels stage")
        .0;
    // Use the stage's own cache mounts under private ids, so the test neither
    // reads nor fills a real build cache.
    let run = format!("{}-{}", std::process::id(), stage.len());
    let mounts = stage
        .split_whitespace()
        .filter_map(|word| word.strip_prefix("--mount="))
        .filter(|options| options.split(',').any(|field| field == "type=cache"))
        .enumerate()
        .map(|(index, options)| format!("--mount={options},id=nemoclaw-cache-test-{run}-{index}"))
        .collect::<Vec<_>>()
        .join(" ");
    let context = tempfile::tempdir().unwrap();
    for (name, content) in [
        (
            "workspace/Cargo.toml",
            "[workspace]\nmembers = [\"core\", \"caller\"]\nresolver = \"2\"\n",
        ),
        (
            "workspace/core/Cargo.toml",
            "[package]\nname = \"fixture-core\"\nversion = \"0.1.0\"\nedition = \"2021\"\n",
        ),
        (
            "workspace/caller/Cargo.toml",
            "[package]\nname = \"fixture-caller\"\nversion = \"0.1.0\"\nedition = \"2021\"\n[dependencies]\nfixture-core = { path = \"../core\" }\n",
        ),
        ("old/core/src/lib.rs", "pub fn original() -> u8 { 1 }\n"),
        (
            "old/caller/src/main.rs",
            "fn main() { assert_eq!(fixture_core::original(), 1); }\n",
        ),
        (
            "new/core/src/lib.rs",
            "pub fn original() -> u8 { 1 }\npub fn added() -> u8 { 2 }\n",
        ),
        (
            "new/caller/src/main.rs",
            "fn main() { assert_eq!(fixture_core::added(), 2); }\n",
        ),
    ] {
        let path = context.path().join(name);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, content).unwrap();
    }
    // Each stage is one archive extraction at /src/fabric with a fixed
    // timestamp. Only the caller is touched, as when PyO3 rebuilds a binding.
    let fixture = format!(
        "FROM {rust} AS fixture\nWORKDIR /src/fabric\nCOPY workspace/ ./\n\
         FROM fixture AS previous\nCOPY old/ ./\n\
         RUN --network=none {mounts} touch -d @1789516800 core/src/lib.rs caller/src/main.rs \
         && cargo run --offline --release --package fixture-caller && touch /previous-complete\n\
         FROM fixture AS current\nCOPY new/ ./\nCOPY --from=previous /previous-complete /previous-complete\n\
         RUN --network=none {mounts} touch -d @1789516800 core/src/lib.rs && touch caller/src/main.rs \
         && cargo run --offline --release --package fixture-caller\n"
    );
    std::fs::write(context.path().join("Dockerfile"), fixture).unwrap();
    build_fixture(context.path());
}

#[test]
#[ignore = "builds with Docker Buildx; run through cargo ci live-docker"]
fn a_new_supervisor_archive_cannot_reuse_an_older_runtime() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let dockerfile = std::fs::read_to_string(root.join("image/supervisor/Dockerfile")).unwrap();
    let rust = dockerfile
        .lines()
        .find_map(|line| line.strip_prefix("ARG RUST_IMAGE="))
        .unwrap();
    // Exercise the production unpack/build/install command with tiny offline
    // archives. Cache ids are private; no production build cache is touched.
    let stage = dockerfile
        .split_once(" AS build\n")
        .unwrap()
        .1
        .split("\nFROM ")
        .next()
        .unwrap();
    let mut command = stage.split_once("\nRUN ").unwrap().1.trim().to_owned();
    let run = nemoclaw_build::ci::live::uuid().unwrap();
    for (index, mount) in command
        .clone()
        .split_whitespace()
        .filter(|word| word.starts_with("--mount=type=cache,"))
        .enumerate()
    {
        command = command.replace(
            mount,
            &format!("{mount},id=nemoclaw-supervisor-test-{run}-{index}"),
        );
    }
    let context = tempfile::tempdir().unwrap();
    for value in ["old", "new"] {
        let archive =
            std::fs::File::create(context.path().join(format!("{value}.tar.gz"))).unwrap();
        let mut archive = tar::Builder::new(flate2::write::GzEncoder::new(
            archive,
            flate2::Compression::fast(),
        ));
        for (name, text) in [
            (
                "Cargo.toml",
                "[workspace]\nmembers = [\"crates/nemoclaw-runtime\"]\nresolver = \"2\"\n"
                    .to_owned(),
            ),
            (
                "Cargo.lock",
                "version = 4\n[[package]]\nname = \"nemoclaw-runtime\"\nversion = \"0.1.0\"\n"
                    .to_owned(),
            ),
            (
                "crates/nemoclaw-runtime/Cargo.toml",
                "[package]\nname = \"nemoclaw-runtime\"\nversion = \"0.1.0\"\nedition = \"2021\"\n"
                    .to_owned(),
            ),
            (
                "crates/nemoclaw-runtime/src/main.rs",
                format!("fn main() {{ println!(\"{value}\"); }}\n"),
            ),
        ] {
            let mut header = tar::Header::new_gnu();
            header.set_size(text.len() as u64);
            header.set_mode(0o644);
            header.set_mtime(1789689600);
            header.set_cksum();
            archive
                .append_data(&mut header, name, text.as_bytes())
                .unwrap();
        }
        archive.into_inner().unwrap().finish().unwrap();
    }
    // The marker orders the two stages without copying compiled artifacts.
    // The changed source has the same path, package version, size and mtime.
    let fixture = format!(
        "FROM {rust} AS previous\nCOPY old.tar.gz /out/supervisor-source.tar.gz\n\
         RUN --network=none {command}\n\
         RUN test \"$(/out/nemoclaw-runtime)\" = old && touch /previous-complete\n\
         FROM {rust} AS current\nCOPY --from=previous /previous-complete /previous-complete\n\
         COPY new.tar.gz /out/supervisor-source.tar.gz\nRUN --network=none {command}\n\
         RUN test \"$(/out/nemoclaw-runtime)\" = new || {{ echo 'runtime is stale'; exit 1; }}\n"
    );
    std::fs::write(context.path().join("Dockerfile"), fixture).unwrap();
    build_fixture(context.path());
}

fn build_fixture(context: &Path) {
    let output = Command::new("docker")
        .args([
            "buildx",
            "build",
            "--progress=plain",
            "--output=type=cacheonly",
        ])
        .arg(context)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}
