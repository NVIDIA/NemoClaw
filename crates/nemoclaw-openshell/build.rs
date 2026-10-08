// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use std::{env, fs, path::PathBuf};

fn main() {
    let path =
        PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").unwrap()).join("../../versions.json");
    println!("cargo:rerun-if-changed={}", path.display());
    let pins: serde_json::Value = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
    let version = pins["openshell"].as_str().expect("/openshell");
    fs::write(
        PathBuf::from(env::var_os("OUT_DIR").unwrap()).join("pins.rs"),
        format!("pub const OPENSHELL_VERSION: &str = {version:?};\n"),
    )
    .unwrap();
}
