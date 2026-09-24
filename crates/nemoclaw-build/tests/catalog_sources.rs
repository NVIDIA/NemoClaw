// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

#[test]
fn source_bundle_retains_embedded_catalog_and_revision_check_inputs() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let files = nemoclaw_build::source_inputs(&root).unwrap();
    for name in [
        "examples/onboarding/openclaw.yaml",
        "image/fabric/catalog.json",
        "image/fabric/Dockerfile",
        "image/fabric/FABRIC-LICENSE",
        "image/NOTICE.md",
    ] {
        assert!(
            files.iter().any(|(path, _)| path == name),
            "source bundle omitted {name}"
        );
    }
}
