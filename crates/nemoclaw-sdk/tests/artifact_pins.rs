// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use nemoclaw_sdk::config::{DEFAULT_AGENT_IMAGE, DEFAULT_GATEWAY_IMAGE};

#[test]
fn runtime_defaults_use_the_artifact_manifest() {
    let pins: serde_json::Value =
        serde_json::from_str(include_str!("../../../versions.json")).unwrap();
    assert_eq!(pins["images"]["agent"], DEFAULT_AGENT_IMAGE);
    assert_eq!(pins["images"]["gateway"], DEFAULT_GATEWAY_IMAGE);
    let revision = pins["openshellRevision"].as_str().unwrap();
    let manifest = include_str!("../../../Cargo.toml");
    for dependency in ["openshell-core =", "openshell-policy ="] {
        assert!(
            manifest
                .lines()
                .find(|line| line.starts_with(dependency))
                .unwrap()
                .contains(revision)
        );
    }
    for image in pins["images"].as_object().unwrap().values() {
        let digest = image.as_str().unwrap().split_once("@sha256:").unwrap().1;
        assert_eq!(digest.len(), 64);
        assert!(
            digest
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        );
    }
}
