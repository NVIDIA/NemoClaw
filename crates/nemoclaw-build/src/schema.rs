// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use nemoclaw_sdk::config::schema::{SCHEMA_PATH, input_schema};
use std::{fs, path::Path};
mod reference;
pub use reference::render_reference;
pub const REFERENCE_PATH: &str = "docs/reference/configuration.md";

pub fn schema_bytes() -> Vec<u8> {
    let mut bytes = serde_json::to_vec_pretty(&input_schema()).expect("schema serialization");
    bytes.push(b'\n');
    bytes
}

pub fn generate(root: &Path, check: bool) -> Result<(), String> {
    let reference = render_reference(&input_schema())?;
    generated_file(root, SCHEMA_PATH, &schema_bytes(), check)?;
    generated_file(root, REFERENCE_PATH, reference.as_bytes(), check)
}

fn generated_file(root: &Path, relative: &str, bytes: &[u8], check: bool) -> Result<(), String> {
    let path = root.join(relative);
    if check {
        if fs::read(&path).is_ok_and(|existing| existing == bytes) {
            Ok(())
        } else {
            Err(format!(
                "{relative} is missing or stale; run cargo run --locked -p nemoclaw-build -- schema"
            ))
        }
    } else {
        fs::create_dir_all(path.parent().ok_or("invalid generated path")?)
            .map_err(|error| format!("cannot create {relative}: {error}"))?;
        fs::write(path, bytes).map_err(|error| format!("cannot write {relative}: {error}"))
    }
}
