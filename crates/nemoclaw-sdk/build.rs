// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use std::{env, fs, path::PathBuf};

fn main() {
    validate_fabric_catalog();
    let path =
        PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").unwrap()).join("../../versions.json");
    println!("cargo:rerun-if-changed={}", path.display());
    let pins: serde_json::Value = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
    let mut source = String::new();
    for (name, pointer) in [
        ("DEFAULT_AGENT_IMAGE", "/images/agent"),
        ("DEFAULT_GATEWAY_IMAGE", "/images/gateway"),
        ("SANDBOX_RUNTIME_IMAGE", "/images/sandboxRuntime"),
        ("SUPERVISOR_IMAGE", "/images/supervisor"),
        ("GATEWAY_CHART", "/images/gatewayChart"),
        ("DEVELOPMENT_ISSUER_IMAGE", "/images/developmentIssuer"),
        ("OPENTOFU_VERSION", "/opentofu"),
        ("HELM_PROVIDER_VERSION", "/helmProvider"),
    ] {
        let value = pins
            .pointer(pointer)
            .and_then(|v| v.as_str())
            .expect(pointer);
        source.push_str(&format!("pub const {name}: &str = {value:?};\n"));
    }
    fs::write(
        PathBuf::from(env::var_os("OUT_DIR").unwrap()).join("artifact_pins.rs"),
        source,
    )
    .unwrap();
}

// Keep offline discovery tied to the image recipe even when building without Docker.
fn validate_fabric_catalog() {
    let root = PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").unwrap()).join("../..");
    let catalog_path = root.join("image/fabric/catalog.json");
    let pins_path = root.join("versions.json");
    let manifest_path = root.join("crates/nemoclaw-sdk/Cargo.toml");
    for path in [&catalog_path, &pins_path, &manifest_path] {
        println!("cargo:rerun-if-changed={}", path.display());
    }
    let catalog: serde_json::Value =
        serde_json::from_slice(&fs::read(catalog_path).unwrap()).unwrap();
    let manifest: toml::Value =
        toml::from_str(&fs::read_to_string(manifest_path).unwrap()).unwrap();
    let dependency = &manifest["dependencies"]["nemo-fabric-core"];
    assert!(
        dependency.get("path").is_none(),
        "Fabric planner must use a pinned owner source revision"
    );
    assert_eq!(
        dependency.get("git").and_then(toml::Value::as_str),
        Some("https://github.com/NVIDIA/NeMo-Fabric"),
        "Fabric planner must use the canonical owner repository"
    );
    assert_eq!(
        dependency.get("rev").and_then(toml::Value::as_str),
        catalog["fabric_revision"].as_str(),
        "Fabric planner and image catalog revisions must match"
    );
    // The image records the revision that its source archive holds.
    let pins: serde_json::Value = serde_json::from_slice(&fs::read(pins_path).unwrap()).unwrap();
    let source = &pins["imageSources"]["fabric"]["fabric.tar.gz"];
    let revision = source["url"]
        .as_str()
        .and_then(|url| url.strip_prefix("https://codeload.github.com/NVIDIA/NeMo-Fabric/tar.gz/"))
        .expect("versions.json pins the Fabric source archive of one revision");
    for (field, pinned) in [
        ("fabric_revision", Some(revision)),
        ("source_sha256", source["sha256"].as_str()),
    ] {
        assert_eq!(
            catalog[field].as_str(),
            pinned,
            "stale Fabric catalog: regenerate with image/fabric/catalog.py"
        );
    }
}
