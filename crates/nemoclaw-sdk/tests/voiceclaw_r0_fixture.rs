// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use serde_json::Value;
use sha2::{Digest, Sha256};

const FIXTURE_SHA256: &str = "3e5f88079f5f8967008243b7a56b9916482a4655eb8f790a79320b097ec59c82";
const PROFILE: &str = "nemoclaw-voice-r0/2";

fn fixture() -> (&'static [u8], Value) {
    let bytes = include_bytes!("fixtures/voiceclaw-r0-v2/fixtures.json");
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

#[test]
fn published_voiceclaw_fixture_covers_the_fixed_one_shot_probe() {
    let (_, value) = fixture();
    assert_eq!(
        value["probe"]["clientRequest"],
        serde_json::json!({
            "profile": PROFILE,
            "question": "What is two plus two? Reply with only 4."
        })
    );
    assert_eq!(
        value["probe"]["success"],
        serde_json::json!({"profile": PROFILE, "answer": "4"})
    );
    let cases: std::collections::BTreeMap<_, _> = value["probeCases"]
        .as_array()
        .unwrap()
        .iter()
        .map(|case| (case["name"].as_str().unwrap(), case))
        .collect();
    for required in [
        "success",
        "missing_auth",
        "invalid_auth",
        "expired",
        "wrong_target",
        "replaced",
        "unavailable",
        "malformed",
        "oversized",
        "wrong_question",
        "extra_field",
        "duplicate_key",
        "before_connection",
        "second_probe",
        "unsupported_profile",
        "unsupported_media_type",
        "stream_lost",
    ] {
        assert!(cases.contains_key(required), "fixture lacks {required}");
    }
    for (name, case) in cases {
        let expected = if name == "success" || name == "second_probe" || name == "stream_lost" {
            1
        } else {
            0
        };
        assert_eq!(
            case["nativeDispatches"], expected,
            "unexpected dispatch count for {name}"
        );
    }
}
