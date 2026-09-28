// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use nemoclaw_sdk::fabric_capabilities::{ImageMetadata, Support, assess_image_platform};

#[test]
fn engine_platform_comparison_normalizes_aliases_and_preserves_unknowns() {
    let image = ImageMetadata {
        architecture: Some("arm64".into()),
        operating_system: Some("linux".into()),
        ..Default::default()
    };
    assert_eq!(
        assess_image_platform(&image, Some("aarch64"), Some("linux")).status,
        Support::Supported
    );
    assert_eq!(
        assess_image_platform(&image, Some("x86_64"), Some("linux")).status,
        Support::Unsupported
    );
    assert_eq!(
        assess_image_platform(&image, None, Some("linux")).status,
        Support::Unknown
    );
}

#[test]
fn image_digest_evidence_distinguishes_matching_substituted_and_unrecorded_images() {
    use nemoclaw_sdk::fabric_capabilities::assess_image_digest;
    let image = ImageMetadata {
        repo_digests: vec![format!("registry/agent@sha256:{}", "a".repeat(64))],
        ..Default::default()
    };
    assert_eq!(
        assess_image_digest(&image, &format!("mirror/agent@sha256:{}", "a".repeat(64))).status,
        Support::Supported
    );
    assert_eq!(
        assess_image_digest(&image, &format!("registry/agent@sha256:{}", "b".repeat(64))).status,
        Support::Unsupported
    );
    assert_eq!(
        assess_image_digest(
            &ImageMetadata::default(),
            &format!("agent@sha256:{}", "a".repeat(64))
        )
        .status,
        Support::Unknown
    );
}

#[test]
fn malformed_and_external_schemas_remain_unknown_without_io() {
    use nemoclaw_sdk::fabric_capabilities::schema_accepts;
    assert_eq!(
        schema_accepts(
            &serde_json::json!({"type":"invented"}),
            &serde_json::json!({})
        ),
        None
    );
    assert_eq!(
        schema_accepts(
            &serde_json::json!({"$ref":"file:///etc/passwd"}),
            &serde_json::json!({})
        ),
        None
    );
    assert_eq!(
        schema_accepts(
            &serde_json::json!({"$ref":"https://example.invalid/schema"}),
            &serde_json::json!({})
        ),
        None
    );
}
