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
        ("DEFAULT_HERMES_IMAGE", "/images/hermes"),
        ("DEFAULT_GATEWAY_IMAGE", "/images/gateway"),
        ("SANDBOX_RUNTIME_IMAGE", "/images/sandboxRuntime"),
        ("SUPERVISOR_IMAGE", "/images/supervisor"),
        ("OPENSHELL_VERSION", "/openshell"),
        ("OPENTOFU_VERSION", "/opentofu"),
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
    let recipe_path = root.join("image/fabric/Dockerfile");
    for path in [&catalog_path, &recipe_path] {
        println!("cargo:rerun-if-changed={}", path.display());
    }
    let catalog: serde_json::Value =
        serde_json::from_slice(&fs::read(catalog_path).unwrap()).unwrap();
    let recipe = fs::read_to_string(recipe_path).unwrap();
    for (field, prefix) in [
        ("fabric_revision", "ARG FABRIC_REVISION="),
        ("source_sha256", "ARG FABRIC_SHA256="),
    ] {
        let pinned = recipe
            .lines()
            .find_map(|line| line.strip_prefix(prefix))
            .expect("Fabric source pin");
        assert_eq!(
            catalog[field].as_str(),
            Some(pinned),
            "stale Fabric catalog: regenerate with image/fabric/catalog.py"
        );
    }
}
