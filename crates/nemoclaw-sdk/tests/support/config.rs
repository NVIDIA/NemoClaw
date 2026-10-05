// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Configuration inputs shared by the SDK integration tests.

use serde_json::Value;
use std::path::Path;

/// A maintained example, relative to the repository's `examples/` directory.
pub fn example(name: &str) -> Value {
    load(
        &Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../examples")
            .join(name),
    )
}

/// A test fixture, relative to `tests/fixtures/config/`.
pub fn fixture(name: &str) -> Value {
    load(
        &Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/config")
            .join(name),
    )
}

fn load(path: &Path) -> Value {
    let text =
        std::fs::read_to_string(path).unwrap_or_else(|error| panic!("{}: {error}", path.display()));
    serde_saphyr::from_str(&text).unwrap_or_else(|error| panic!("{}: {error}", path.display()))
}
