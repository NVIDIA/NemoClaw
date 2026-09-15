// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use serde_json::Value;
use sha2::{Digest, Sha256};

const FIXTURE_SHA256: &str = "20132310c2f14dd927b0ac50e30d5176a9e3c99b83d5890c9cf581e2320d3442";
const PROFILE: &str = "nemoclaw-voice-r0/1";

fn fixture() -> (&'static [u8], Value) {
    let bytes = include_bytes!("fixtures/voiceclaw-r0-v1/fixtures.json");
    let value = serde_json::from_slice(bytes).expect("published fixture must be valid JSON");
    (bytes, value)
}

#[test]
fn published_voiceclaw_fixture_bytes_match_the_agreed_revision() {
    let (bytes, value) = fixture();
    let digest: String = Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    assert_eq!(digest, FIXTURE_SHA256);
    assert_eq!(value["profile"], PROFILE);
}

#[test]
fn published_voiceclaw_fixture_covers_connection_and_denial_outcomes() {
    let (_, value) = fixture();
    let names: std::collections::BTreeSet<_> = value["cases"]
        .as_array()
        .unwrap()
        .iter()
        .map(|case| case["name"].as_str().unwrap())
        .collect();
    for required in [
        "ready",
        "missing_auth",
        "invalid_auth",
        "expired",
        "wrong_target",
        "replaced",
        "unavailable",
        "unsupported_profile",
        "invalid_request",
        "active",
        "oversized",
        "media_type",
        "stream_credential_expired",
        "stream_agent_unavailable",
        "stream_target_replaced",
        "stream_server_stopping",
        "abrupt_eof",
    ] {
        assert!(names.contains(required), "fixture lacks {required}");
    }
    let encoded = serde_json::to_string(&value).unwrap();
    for native_field in [
        "openclawCredential",
        "openShellCredential",
        "sessionKey",
        "runId",
        "nativeAgentId",
    ] {
        assert!(
            !encoded.contains(native_field),
            "fixture exposes native field {native_field}"
        );
    }
}
