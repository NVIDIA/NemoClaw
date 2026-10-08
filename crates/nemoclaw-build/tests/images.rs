// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Image labels publish exactly the metadata the image itself reports.

use nemoclaw_build::images::{PLATFORMS, export_arguments, labels, plan};
use serde_json::json;
use std::path::Path;

#[test]
fn harness_images_carry_a_catalog_that_agrees_with_their_bridge() {
    let bridge = json!({"interface_version": 1});
    let catalog = json!({"bridge": bridge, "adapters": []});
    let published = labels("openclaw", bridge.clone(), Some(catalog.clone())).unwrap();
    assert_eq!(
        published,
        [
            ("io.nemoclaw.fabric.bridge".to_owned(), bridge.to_string()),
            ("io.nemoclaw.fabric.catalog".to_owned(), catalog.to_string()),
        ]
    );
    let disagreeing = json!({"bridge": {"interface_version": 2}});
    assert!(labels("openclaw", bridge.clone(), Some(disagreeing)).is_err());
    assert!(labels("openclaw", bridge, None).is_err());
}

#[test]
fn the_reference_image_carries_only_its_bridge() {
    let bridge = json!({"interface_version": 1});
    assert_eq!(labels("dummy", bridge.clone(), None).unwrap().len(), 1);
    assert!(labels("dummy", bridge.clone(), Some(json!({"bridge": bridge}))).is_err());
}

/// An exported image, such as Brev's OCI archive, must carry the same labels
/// as a local one: its digest covers them, and plan reads them from it.
#[test]
fn an_export_rebuilds_the_target_with_its_labels_to_the_output() {
    let labels = [
        (
            "io.nemoclaw.fabric.bridge".to_owned(),
            "{\"interface_version\":1}".to_owned(),
        ),
        ("io.nemoclaw.fabric.catalog".to_owned(), "{}".to_owned()),
    ];
    let arguments = export_arguments(
        "openclaw",
        &labels,
        "type=oci,dest=image.tar",
        Some(Path::new("metadata.json")),
    );
    assert_eq!(
        arguments,
        [
            "buildx",
            "bake",
            "openclaw",
            "--set",
            "openclaw.labels.io.nemoclaw.fabric.bridge={\"interface_version\":1}",
            "--set",
            "openclaw.labels.io.nemoclaw.fabric.catalog={}",
            "--set",
            "openclaw.output=type=oci,dest=image.tar",
            "--metadata-file",
            "metadata.json",
        ]
    );
}

#[test]
fn builds_require_one_of_the_qualified_platforms() {
    assert_eq!(PLATFORMS, ["linux/arm64", "linux/amd64"]);
    // Rejected before Docker runs, so this needs no daemon.
    let error = plan(Path::new("."), "linux/riscv64", &["agents".into()]).unwrap_err();
    assert!(error.contains("--platform"), "{error}");
}
