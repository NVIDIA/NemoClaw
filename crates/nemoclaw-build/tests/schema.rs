// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use std::{fs, path::Path, process::Command};

fn generate(directory: &Path, check: bool) -> std::process::Output {
    let mut command = Command::new(env!("CARGO_BIN_EXE_nemoclaw-build"));
    command.current_dir(directory).arg("schema");
    if check {
        command.arg("--check");
    }
    command.output().unwrap()
}

#[test]
fn schema_generation_is_repeatable_and_check_rejects_missing_or_stale_output() {
    let directory = tempfile::tempdir().unwrap();
    assert!(!generate(directory.path(), true).status.success());
    assert!(
        !directory.path().join("schemas").exists(),
        "check must not create files"
    );
    let result = generate(directory.path(), false);
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    let path = directory
        .path()
        .join("schemas/nemoclaw-v1alpha1.schema.json");
    let first = fs::read(&path).unwrap();
    let schema: serde_json::Value = serde_json::from_slice(&first).unwrap();
    assert_eq!(
        schema["$schema"],
        "https://json-schema.org/draft/2020-12/schema"
    );
    assert_eq!(schema["$id"], "urn:nemoclaw:config:v1alpha1");
    assert!(generate(directory.path(), false).status.success());
    assert_eq!(fs::read(&path).unwrap(), first);
    assert!(generate(directory.path(), true).status.success());
    let reference = directory.path().join("docs/reference/configuration.md");
    let markdown =
        fs::read_to_string(&reference).expect("generation includes the YAML field reference");
    fs::write(&reference, "stale reference\n").unwrap();
    assert!(!generate(directory.path(), true).status.success());
    assert_eq!(fs::read_to_string(&reference).unwrap(), "stale reference\n");
    assert!(generate(directory.path(), false).status.success());
    assert_eq!(fs::read_to_string(&reference).unwrap(), markdown);
    fs::write(&path, b"{}\n").unwrap();
    let stale = generate(directory.path(), true);
    assert!(!stale.status.success());
    assert!(
        String::from_utf8_lossy(&stale.stderr).contains("schemas/nemoclaw-v1alpha1.schema.json")
    );
    assert_eq!(fs::read(&path).unwrap(), b"{}\n");
}

#[test]
fn bundle_rejects_a_builder_compiled_from_different_source_inputs() {
    let root = tempfile::tempdir().unwrap();
    let repository = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    for name in [
        "Cargo.toml",
        "Cargo.lock",
        "rust-toolchain.toml",
        "versions.json",
        "LICENSE",
        "examples/onboarding/openclaw.yaml",
        "image/fabric/catalog.json",
        "image/fabric/Dockerfile",
        "image/fabric/FABRIC-LICENSE",
        "image/NOTICE.md",
    ] {
        fs::create_dir_all(root.path().join(name).parent().unwrap()).unwrap();
        fs::copy(repository.join(name), root.path().join(name)).unwrap();
    }
    fs::create_dir(root.path().join("crates")).unwrap();
    fs::create_dir(root.path().join("runtimes")).unwrap();
    fs::create_dir_all(root.path().join("examples/onboarding-tui")).unwrap();
    fs::write(root.path().join("crates/changed.rs"), "changed source\n").unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_nemoclaw-build"))
        .current_dir(root.path())
        .args(["bundle", "--platform", "fixture"])
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("build tool source inputs changed"),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(!root.path().join("dist").exists());
    assert!(!root.path().join(".build").exists());
}

#[test]
fn bundled_schema_matches_the_compiled_contract_and_is_hashed() {
    let directory = tempfile::tempdir().unwrap();
    let mut manifest = nemoclaw_sdk::bundle::Manifest {
        version: "0.1.0".into(),
        rust: "1.98.1".into(),
        opentofu: nemoclaw_sdk::compile::OPENTOFU_VERSION.into(),
        files: Default::default(),
    };
    let name = nemoclaw_sdk::config::schema::SCHEMA_PATH;
    let path = directory.path().join(name);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(&path, b"stale checked-in schema").unwrap();
    nemoclaw_build::schema::add_to_bundle(directory.path(), &mut manifest).unwrap();
    assert_eq!(
        fs::read(&path).unwrap(),
        nemoclaw_build::schema::schema_bytes()
    );
    assert_eq!(
        manifest.files[name],
        nemoclaw_sdk::bundle::hash_file(&path).unwrap()
    );
    let value: serde_json::Value = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
    assert_eq!(value, nemoclaw_sdk::config::schema::input_schema());
}

#[test]
fn compiled_source_identity_stays_fixed_when_inputs_change_during_assembly() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let mut files = nemoclaw_build::source_inputs(&root).unwrap();
    let expected = nemoclaw_build::BUILDER_SOURCE_VERSION;
    nemoclaw_build::verify_source_version(expected, &files).unwrap();
    files
        .iter_mut()
        .find(|(name, _)| name.ends_with(".rs"))
        .expect("source archive must contain Rust inputs")
        .1
        .extend(b"\n// changed contract\n");
    assert!(nemoclaw_build::verify_source_version(expected, &files).is_err());
    assert_ne!(expected, nemoclaw_build::source_version(&files));
}
