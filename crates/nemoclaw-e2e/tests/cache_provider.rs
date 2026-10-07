// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Opt-in real Docker/OpenTofu resource qualification; no SDK coordinator or GPU.
#![cfg(unix)]

use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::PathBuf,
    process::{Command, Output},
    time::Duration,
};

const UID_LABEL: &str = "nemoclaw.nvidia.com/uid";

struct Run {
    bundle: PathBuf,
    root: PathBuf,
    engine: String,
    name: String,
}

impl Run {
    fn tofu(&self, args: &[&str], success: bool) -> Vec<u8> {
        let output = Command::new(self.bundle.join("libexec/tofu"))
            .args(args)
            .arg("-no-color")
            .current_dir(&self.root)
            .env("TF_CLI_CONFIG_FILE", self.root.join("providers.tfrc"))
            .env("TF_IN_AUTOMATION", "1")
            .env("CHECKPOINT_DISABLE", "1")
            .output()
            .unwrap();
        let mut log = fs::read(self.root.join("run.log")).unwrap_or_default();
        log.extend(&output.stdout);
        log.extend(&output.stderr);
        fs::write(self.root.join("run.log"), log).unwrap();
        assert_eq!(
            output.status.success(),
            success,
            "tofu {args:?}\n{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        output.stdout
    }

    fn apply(&self, args: &[&str]) {
        self.tofu(
            &[&["apply", "-auto-approve", "-input=false"], args].concat(),
            true,
        );
    }

    fn rejected_apply(&self, args: &[&str]) {
        self.tofu(
            &[&["apply", "-auto-approve", "-input=false"], args].concat(),
            false,
        );
    }

    fn noop(&self) {
        self.tofu(&["plan", "-out=noop.plan", "-input=false"], true);
        let plan: Value =
            serde_json::from_slice(&self.tofu(&["show", "-json", "noop.plan"], true)).unwrap();
        for change in plan["resource_changes"].as_array().unwrap() {
            assert_eq!(
                change["change"]["actions"],
                json!(["no-op"]),
                "{} changed",
                change["address"]
            );
        }
    }

    fn docker_output(&self, args: &[&str]) -> Output {
        Command::new("docker")
            .args(["--host", &self.engine])
            .args(args)
            .output()
            .unwrap()
    }

    fn docker(&self, args: &[&str]) -> Vec<u8> {
        let output = self.docker_output(args);
        assert!(
            output.status.success(),
            "docker {args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        output.stdout
    }

    fn exists(&self, kind: &str, name: &str) -> bool {
        self.docker_output(&[kind, "inspect", name])
            .status
            .success()
    }

    /// The credential's digest, once the fixture container has written it.
    fn key(&self) -> Vec<u8> {
        for _ in 0..100 {
            let output = self.docker_output(&["exec", &self.name, "sha256sum", "/credentials/key"]);
            if output.status.success() {
                return output.stdout;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        panic!("fixture credential did not become ready");
    }

    /// The cache contents, once the fixture container has written them.
    fn model(&self) -> Vec<u8> {
        for _ in 0..100 {
            let output = self.docker_output(&["exec", &self.name, "cat", "/data/model"]);
            if output.status.success() && !output.stdout.is_empty() {
                return output.stdout;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        panic!("fixture cache did not become ready");
    }

    fn state(&self) -> Vec<u8> {
        fs::read(self.root.join("terraform.tfstate")).unwrap()
    }
}

/// Removes only resources carrying this run's owner label.
struct Owned<'a> {
    run: &'a Run,
    uid: String,
}

impl Drop for Owned<'_> {
    fn drop(&mut self) {
        let name = &self.run.name;
        for (kind, resource) in [
            ("container", name.clone()),
            ("volume", format!("{name}-data")),
            ("volume", format!("{name}-auth")),
        ] {
            let output = self.run.docker_output(&[kind, "inspect", &resource]);
            if !output.status.success() {
                continue;
            }
            let inspected: Value = serde_json::from_slice(&output.stdout).unwrap();
            let labels = if kind == "container" {
                &inspected[0]["Config"]["Labels"]
            } else {
                &inspected[0]["Labels"]
            };
            if labels[UID_LABEL] != self.uid {
                eprintln!("left {kind} {resource}: it is not owned by this run");
                continue;
            }
            let force: &[&str] = if kind == "container" { &["-f"] } else { &[] };
            let _ = self
                .run
                .docker_output(&[&[kind, "rm"], force, &[resource.as_str()]].concat());
        }
    }
}

fn uuid() -> String {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).unwrap();
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &hex[..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..]
    )
}

#[test]
#[ignore = "requires explicit NEMOCLAW_TEST_BUNDLE, NEMOCLAW_TEST_CACHE_ENGINE and NEMOCLAW_TEST_CACHE_IMAGE; owns isolated Docker resources"]
fn standalone_hcl_recovers_cache_and_guards_credentials_without_sdk_orchestration() {
    let bundle = PathBuf::from(std::env::var("NEMOCLAW_TEST_BUNDLE").expect("explicit bundle"));
    let manifest = nemoclaw_sdk::bundle::Bundle::open(&bundle)
        .unwrap()
        .manifest;
    let engine = std::env::var("NEMOCLAW_TEST_CACHE_ENGINE").expect("explicit engine");
    assert!(engine.starts_with("unix:///"), "use a local engine socket");
    let image = std::env::var("NEMOCLAW_TEST_CACHE_IMAGE").expect("explicit fixture image");
    let uid = uuid();
    let digest: String = Sha256::digest(uid.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    let name = format!("nc-{}-inference-fixture", &digest[..16]);
    // Kept after the run for diagnosis; it holds only this run's logs and state.
    let root = tempfile::Builder::new()
        .prefix("nemoclaw-cache-provider-")
        .tempdir()
        .unwrap()
        .keep();
    eprintln!("logs and state: {}", root.display());
    fs::write(
        root.join("providers.tfrc"),
        format!(
            "provider_installation {{ filesystem_mirror {{ path = {} }} }}\n",
            json!(bundle.join("providers"))
        ),
    )
    .unwrap();
    let hcl = include_str!("fixtures/cache_provider.tf")
        .replace("@PROVIDER_VERSION@", &manifest.version)
        .replace("@FIXTURE_IMAGE@", &image)
        .replace("@ENGINE@", &engine);
    fs::write(root.join("main.tf"), hcl).unwrap();
    fs::write(
        root.join("terraform.tfvars.json"),
        json!({"name": name, "owner": uid}).to_string(),
    )
    .unwrap();
    let run = Run {
        bundle,
        root,
        engine,
        name: name.clone(),
    };
    let _owned = Owned {
        run: &run,
        uid: uid.clone(),
    };
    let auth = format!("{name}-auth");

    run.tofu(&["init", "-input=false"], true);
    run.apply(&[]);
    run.noop();
    let original = run.key();
    run.apply(&["-var=revision=replaced"]);
    assert_eq!(run.key(), original);
    run.rejected_apply(&["-var=fail_start=true"]);
    run.apply(&[]);
    assert_eq!(run.key(), original);
    run.noop();

    // Teardown removes compute and keeps both retained volumes.
    run.apply(&["-var=enabled=false"]);
    assert!(!run.exists("container", &name));
    assert!(run.exists("volume", &auth));
    run.apply(&[]);
    assert_eq!(run.key(), original);
    run.noop();

    // A lost cache is reconstructed with the same credential.
    run.docker(&["rm", "-f", &name]);
    run.docker(&["volume", "rm", &format!("{name}-data")]);
    run.apply(&["-var=revision=replaced"]);
    assert_eq!(run.key(), original);
    assert_eq!(run.model(), b"reconstructed");
    let unchanged = run.state();

    // Missing bound credentials must block a pending compute replacement.
    run.docker(&["rm", "-f", &name]);
    run.docker(&["volume", "rm", &auth]);
    run.rejected_apply(&["-var=revision=must-not-create"]);
    assert_eq!(run.state(), unchanged);
    assert!(!run.exists("container", &name));

    // A same-named, same-labelled replacement is still not the bound credential volume.
    std::thread::sleep(Duration::from_millis(1100));
    run.docker(&[
        "volume",
        "create",
        "--label",
        &format!("{UID_LABEL}={uid}"),
        "--label",
        &format!("nemoclaw.nvidia.com/generation={}", "a".repeat(32)),
        &auth,
    ]);
    run.rejected_apply(&["-var=revision=must-not-create"]);
    assert_eq!(run.state(), unchanged);
    assert!(!run.exists("container", &name));
}
