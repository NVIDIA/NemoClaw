// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Build agent images with their installed Fabric metadata, and qualify them.
//!
//! Every container these commands start is disposable, offline, and read-only;
//! none starts an adapter, contacts a model, or touches deployment resources.

use serde_json::Value;
use std::{
    fs,
    path::Path,
    process::{Command, Stdio},
    time::Duration,
};

type Result<T> = std::result::Result<T, String>;

pub const PLATFORMS: [&str; 2] = ["linux/arm64", "linux/amd64"];
const BRIDGE_LABEL: &str = "io.nemoclaw.fabric.bridge";
const CATALOG_LABEL: &str = "io.nemoclaw.fabric.catalog";
const REFERENCE_LABEL: &str = "io.nemoclaw.fabric.reference";
const QUALIFY_TIMEOUT: Duration = Duration::from_secs(180);

fn docker() -> Command {
    let mut command = Command::new("docker");
    command.stdin(Stdio::null());
    command
}

fn output(command: &mut Command, what: &str) -> Result<Vec<u8>> {
    let output = command
        .stderr(Stdio::inherit())
        .output()
        .map_err(|_| format!("cannot run docker to {what}"))?;
    if !output.status.success() {
        return Err(format!("docker failed to {what}"));
    }
    Ok(output.stdout)
}

fn status(command: &mut Command, what: &str) -> Result<()> {
    let succeeded = command
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .status()
        .map_err(|_| format!("cannot run docker to {what}"))?
        .success();
    succeeded
        .then_some(())
        .ok_or_else(|| format!("docker failed to {what}"))
}

/// Bake targets for `selection`, each with the tags it should publish locally.
pub fn plan(
    root: &Path,
    platform: &str,
    selection: &[String],
) -> Result<Vec<(String, Vec<String>)>> {
    if !PLATFORMS.contains(&platform) {
        return Err(format!("choose --platform {}", PLATFORMS.join(" or ")));
    }
    let printed = output(
        docker()
            .current_dir(root)
            .env("AGENT_PLATFORM", platform)
            .args(["buildx", "bake", "--print"])
            .args(selection),
        "plan the image build",
    )?;
    let plan: Value = serde_json::from_slice(&printed).map_err(|_| "unreadable bake plan")?;
    let targets = plan["target"]
        .as_object()
        .ok_or("bake plan has no targets")?;
    targets
        .iter()
        .map(|(name, target)| {
            let tags: Vec<String> = target["tags"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|tag| tag.as_str().map(str::to_owned))
                .collect();
            if tags.is_empty() {
                return Err(format!("{name} is not a tagged agent image"));
            }
            Ok((name.clone(), tags))
        })
        .collect()
}

/// Read one file's metadata from a disposable, offline, read-only container.
fn read_metadata(image: &str, args: &[&str]) -> Result<Value> {
    let bytes = output(
        docker()
            .args([
                "run",
                "--rm",
                "--network=none",
                "--read-only",
                "--entrypoint",
                "/opt/fabric/bin/python",
                image,
            ])
            .args(args),
        "read installed image metadata",
    )?;
    serde_json::from_slice(&bytes).map_err(|_| "image metadata is not JSON".into())
}

/// Labels that publish the image's bridge capabilities and, for real
/// harnesses, its installed Fabric discovery catalog.
pub fn labels(name: &str, bridge: Value, catalog: Option<Value>) -> Result<Vec<(String, String)>> {
    let compact = |value: &Value| {
        serde_json::to_string(value).map_err(|_| "unserializable metadata".to_owned())
    };
    let mut labels = vec![(BRIDGE_LABEL.to_owned(), compact(&bridge)?)];
    match (name, catalog) {
        ("dummy", None) => {}
        ("dummy", Some(_)) => return Err("the reference image carries no catalog".into()),
        (_, None) => return Err(format!("{name} has no installed catalog")),
        (_, Some(catalog)) => {
            if catalog["bridge"] != bridge {
                return Err("catalog and executable bridge capabilities disagree".into());
            }
            labels.push((CATALOG_LABEL.to_owned(), compact(&catalog)?));
        }
    }
    Ok(labels)
}

/// Build each target under a temporary tag, read its metadata, then publish
/// the labeled image under its real tags. The temporary tag is always removed.
pub fn build(root: &Path, platform: &str, selection: &[String]) -> Result<()> {
    for (name, tags) in plan(root, platform, selection)? {
        let mut nonce = [0u8; 16];
        getrandom::fill(&mut nonce).map_err(|_| "cannot name a temporary image")?;
        let temporary = format!("nemoclaw-build:{}", crate::hex(&nonce));
        let result = (|| {
            status(
                docker()
                    .current_dir(root)
                    .env("AGENT_PLATFORM", platform)
                    .args(["buildx", "bake", &name, "--load", "--set"])
                    .arg(format!("{name}.tags={temporary}")),
                &format!("build {name}"),
            )?;
            let bridge = read_metadata(
                &temporary,
                &[
                    "-c",
                    "from pathlib import Path; print(Path('/opt/nemoclaw/bridge.json').read_text())",
                ],
            )?;
            let catalog = (name != "dummy")
                .then(|| {
                    read_metadata(
                        &temporary,
                        &[
                            "/opt/nemoclaw/catalog.py",
                            "--installed",
                            "--provenance",
                            "/opt/nemoclaw/provenance.json",
                        ],
                    )
                })
                .transpose()?;
            let labels = labels(&name, bridge, catalog)?;
            let context = tempfile::tempdir().map_err(|_| "cannot create a label context")?;
            fs::write(
                context.path().join("Dockerfile"),
                format!("FROM {temporary}\n"),
            )
            .map_err(|_| "cannot write the label Dockerfile")?;
            let mut command = docker();
            command.arg("build");
            for (label, value) in &labels {
                command.arg("--label").arg(format!("{label}={value}"));
            }
            for tag in &tags {
                command.args(["--tag", tag]);
            }
            status(command.arg(context.path()), &format!("label {name}"))
        })();
        let _ = docker()
            .args(["image", "rm", &temporary])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
        result?;
    }
    Ok(())
}

/// Run the black-box command contract inside one image, offline and read-only.
pub fn qualify(root: &Path, image: &str) -> Result<()> {
    let inspected = output(
        docker().args(["image", "inspect", image]),
        "inspect the image",
    )?;
    let inspected: Value =
        serde_json::from_slice(&inspected).map_err(|_| "unreadable image inspection")?;
    let labels = &inspected[0]["Config"]["Labels"];
    let bridge = labels[BRIDGE_LABEL].as_str().ok_or_else(|| {
        format!("{image} has no {BRIDGE_LABEL} label; build it with cargo images build")
    })?;
    let reference = labels[REFERENCE_LABEL].as_str().unwrap_or("");
    let id = inspected[0]["Id"].as_str().ok_or("image has no ID")?;
    let test = std::path::absolute(root.join("image/test_agent_contract.py"))
        .map_err(|_| "cannot locate the contract test")?;
    let mut nonce = [0u8; 16];
    getrandom::fill(&mut nonce).map_err(|_| "cannot name the qualification container")?;
    let name = format!("nemoclaw-contract-{}", crate::hex(&nonce));
    let mut child = docker()
        .args([
            "run",
            "--name",
            &name,
            "--rm",
            "--runtime=runc",
            "--network=none",
            "--read-only",
            "--tmpfs",
            "/sandbox:rw,uid=10001,gid=10001,mode=0700",
            "--tmpfs",
            "/tmp:rw,mode=1777",
            "-e",
        ])
        .arg(format!("NEMOCLAW_TEST_BRIDGE={bridge}"))
        .arg("-e")
        .arg(format!("NEMOCLAW_TEST_REFERENCE={reference}"))
        .arg("--mount")
        .arg(format!(
            "type=bind,src={},dst=/test.py,readonly",
            test.display()
        ))
        .args([
            "--entrypoint",
            "/opt/fabric/bin/python",
            id,
            "-B",
            "/test.py",
        ])
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|_| "cannot run docker to qualify the image")?;
    let deadline = std::time::Instant::now() + QUALIFY_TIMEOUT;
    let outcome = loop {
        match child.try_wait() {
            Ok(Some(exit)) => {
                break exit
                    .success()
                    .then_some(())
                    .ok_or("the command contract failed");
            }
            Ok(None) if std::time::Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(200));
            }
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                break Err("the command contract timed out");
            }
            Err(_) => break Err("cannot observe the qualification container"),
        }
    };
    // Only this invocation's container is removed, including after a timeout.
    let _ = docker()
        .args(["rm", "--force", &name])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    outcome.map_err(|error| format!("{image}: {error}"))
}
