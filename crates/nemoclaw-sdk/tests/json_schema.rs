// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Offline JSON Schema checks.

use nemoclaw_sdk::json_schema::schema_accepts;
use serde_json::json;

#[test]
fn valid_and_invalid_values_are_judged() {
    let schema = json!({"type": "object", "required": ["name"]});
    assert_eq!(schema_accepts(&schema, &json!({"name": "a"})), Some(true));
    assert_eq!(schema_accepts(&schema, &json!({})), Some(false));
}

#[test]
fn malformed_and_external_schemas_remain_unknown_without_io() {
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
