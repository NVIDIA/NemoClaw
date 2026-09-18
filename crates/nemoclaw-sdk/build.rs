// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use std::{env, fs, path::PathBuf};

fn main() {
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
