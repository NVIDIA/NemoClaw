// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use nemoclaw_sdk::{
    bundle::{Manifest, hash_file},
    config::Document,
};
use std::{fs, path::Path, process::Command};

fn command(root: &Path, name: &str, script: &str) -> Command {
    let document =
        Document::parse(include_bytes!("../../../examples/agents/openclaw.yaml").as_slice())
            .unwrap();
    let state = root.join("state");
    fs::create_dir_all(&state).unwrap();
    // A saved deployment in the SDK's version-33 intent format.
    let record = serde_json::json!({
        "version":33, "digest":document.digest(), "document":document,
        "generations":{
            "workspace":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "sandbox":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "provider":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "managed_gateway":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        }
    });
    fs::write(
        state.join("intent.json"),
        serde_json::to_vec(&record).unwrap(),
    )
    .unwrap();
    let bundle = root.join("bundle");
    crate::bundle::write_bundle(&bundle, None);
    let binary = bundle.join("libexec/openshell");
    crate::executable::write_executable(&binary, script);
    let path = bundle.join("manifest.json");
    let mut manifest: Manifest = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    manifest
        .files
        .insert("libexec/openshell".into(), hash_file(&binary).unwrap());
    fs::write(path, serde_json::to_vec(&manifest).unwrap()).unwrap();
    let mut cli = crate::nemoclaw();
    cli.arg(name)
        .arg("--state-dir")
        .arg(state)
        .arg("--bundle")
        .arg(bundle)
        .arg("--");
    cli
}

#[test]
fn both_command_names_preserve_child_arguments_output_and_exit_code() {
    for name in ["openshell", "osh"] {
        let root = tempfile::tempdir().unwrap();
        let output = command(
            root.path(),
            name,
            "#!/bin/sh\nprintf '%s\\0' \"$@\"\nprintf 'child stderr\\n' >&2\nexit 37\n",
        )
        .args(["sandbox", "exec", "--verbose", "--", "hello world"])
        .output()
        .unwrap();
        assert_eq!(
            output.status.code(),
            Some(37),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(
            output.stdout,
            b"sandbox\0exec\0--verbose\0--\0hello world\0"
        );
        assert_eq!(output.stderr, b"child stderr\n");
        assert_eq!(
            fs::read_dir(root.path().join("state/openshell"))
                .unwrap()
                .count(),
            0
        );
    }
}

#[test]
fn termination_reaches_the_child_and_removes_its_configuration() {
    use nix::{
        sys::signal::{Signal, kill},
        unistd::Pid,
    };
    let root = tempfile::tempdir().unwrap();
    let ready = root.path().join("ready");
    let mut child = command(
        root.path(),
        "osh",
        "#!/bin/sh\nprintf '%s' \"$XDG_CONFIG_HOME\" > \"$OSH_READY\"\nexec sleep 60\n",
    )
    .env("OSH_READY", &ready)
    .spawn()
    .unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while !ready.is_file() && std::time::Instant::now() < deadline {
        if let Some(status) = child.try_wait().unwrap() {
            panic!("wrapper exited before starting child: {status}");
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    assert!(ready.is_file(), "child must start before the signal");
    let configuration = fs::read_to_string(&ready).unwrap();
    kill(
        Pid::from_raw(child.id().try_into().unwrap()),
        Signal::SIGTERM,
    )
    .unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    loop {
        if let Some(status) = child.try_wait().unwrap() {
            assert_eq!(status.code(), Some(143));
            break;
        }
        if std::time::Instant::now() >= deadline {
            child.kill().unwrap();
            child.wait().unwrap();
            panic!("termination did not stop the child");
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    assert!(!Path::new(&configuration).exists());
}
