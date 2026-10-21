// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Image labels publish exactly the metadata the image itself reports.

use nemoclaw_build::images::{PLATFORMS, labels, plan};
use serde_json::json;
use std::path::Path;

#[test]
fn harness_images_carry_their_catalog() {
    let catalog = json!({"adapters": [{"descriptor": {"adapter_id": "nvidia.fabric.pi"}}]});
    assert_eq!(
        labels("pi", catalog.clone()).unwrap(),
        [("io.nemoclaw.fabric.catalog".to_owned(), catalog.to_string())]
    );
    // Only the reference image may publish the reference adapter.
    let impostor = json!({"adapters": [{"descriptor": {"adapter_id": "org.nemoclaw.dummy"}}]});
    assert!(labels("pi", impostor).is_err());
}

#[test]
fn the_reference_image_carries_a_catalog_so_deployments_can_select_it() {
    let catalog = json!({"adapters": [{"descriptor": {"adapter_id": "org.nemoclaw.dummy"}}]});
    assert_eq!(
        labels("dummy", catalog.clone()).unwrap(),
        [("io.nemoclaw.fabric.catalog".to_owned(), catalog.to_string())]
    );
    // The reference image lists only the reference adapter.
    let production = json!({"adapters": [{"descriptor": {"adapter_id": "nvidia.fabric.pi"}}]});
    assert!(labels("dummy", production).is_err());
    assert!(labels("dummy", json!({"adapters": []})).is_err());
}

#[test]
fn builds_require_one_of_the_qualified_platforms() {
    // Rejected before Docker runs, so this needs no daemon.
    let error = plan(Path::new("."), "linux/riscv64", &["agents".into()]).unwrap_err();
    assert!(error.contains("--platform"), "{error}");
    for platform in PLATFORMS {
        assert!(error.contains(platform), "{error}");
    }
}
