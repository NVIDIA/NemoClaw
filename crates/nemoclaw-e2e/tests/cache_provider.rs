// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
#![cfg(unix)]

#[test]
#[ignore = "requires explicit NEMOCLAW_TEST_BUNDLE, NEMOCLAW_TEST_CACHE_ENGINE and NEMOCLAW_TEST_CACHE_IMAGE; owns isolated Docker resources"]
fn standalone_hcl_recovers_cache_and_guards_credentials_without_sdk_orchestration() {
    let bundle = std::env::var("NEMOCLAW_TEST_BUNDLE").expect("explicit bundle");
    nemoclaw_sdk::bundle::Bundle::open(std::path::Path::new(&bundle)).unwrap();
    let status = std::process::Command::new("python3")
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/fixtures/cache_provider.py"
        ))
        .status()
        .unwrap();
    assert!(status.success());
}
