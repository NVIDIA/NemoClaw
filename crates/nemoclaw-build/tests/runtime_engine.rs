// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
#![cfg(target_os = "linux")]
use std::{fs, os::unix::fs::PermissionsExt, path::Path, process::Command};
fn executable(path: &Path, script: &str) {
    fs::write(path, script).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
}
#[test]
fn unsupported_image_stores_fail_before_compilation_or_downloads() {
    for info in [r#"[["Backing Filesystem","extfs"]]"#, "null", "invalid"] {
        let root = tempfile::tempdir().unwrap();
        for name in ["crates", "runtimes", "bin", "examples/onboarding-tui"] {
            fs::create_dir_all(root.path().join(name)).unwrap();
        }
        for name in ["Cargo.toml", "Cargo.lock", "rust-toolchain.toml", "LICENSE"] {
            fs::write(root.path().join(name), "fixture").unwrap();
        }
        fs::write(
            root.path().join("versions.json"),
            r#"{"rust":"1.98.1","protobuf":"36.1","opentofu":"1.12.6","dockerProvider":"4.6.0","platforms":{}}"#,
        )
        .unwrap();
        let manifest = serde_json::json!({"name":"fixture","platform":nemoclaw_sdk::bundle::platform().unwrap(),"image":"fixture:test","sourceDateEpoch":1234,"files":["Dockerfile"],"downloads":{}});
        fs::write(root.path().join("runtime.json"), manifest.to_string()).unwrap();
        let bin = root.path().join("bin");
        executable(
            &bin.join("cargo"),
            "#!/bin/sh\nif [ \"$1\" = --version ]; then echo 'cargo 1.98.1 (fixture)'; exit 0; fi\ntouch compiled\nexit 1\n",
        );
        executable(&bin.join("protoc"), "#!/bin/sh\necho 'libprotoc 36.1'\n");
        executable(
            &bin.join("docker"),
            "#!/bin/sh\n[ \"$1\" = info ] || exit 2\nprintf '%s\\n' \"$NEMOCLAW_FIXTURE_INFO\"\n",
        );
        let path = std::env::join_paths(
            std::iter::once(bin.clone())
                .chain(std::env::split_paths(&std::env::var_os("PATH").unwrap())),
        )
        .unwrap();
        let output = Command::new(env!("CARGO_BIN_EXE_nemoclaw-build"))
            .args(["runtime", "runtime.json"])
            .current_dir(root.path())
            .env("PATH", path)
            .env("CARGO", bin.join("cargo"))
            .env("PROTOC", bin.join("protoc"))
            .env("NEMOCLAW_FIXTURE_INFO", info)
            .output()
            .unwrap();
        let error = String::from_utf8_lossy(&output.stderr);
        assert!(!output.status.success());
        assert!(error.contains("containerd image store"), "{error}");
        assert!(!root.path().join("compiled").exists());
        assert!(!root.path().join(".build").exists());
    }
}
