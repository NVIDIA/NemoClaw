// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Offline JSON Schema checks for untrusted schemas, such as those that
//! images and Fabric adapters advertise.
use serde_json::Value;

struct OfflineSchemas;
impl jsonschema::Retrieve for OfflineSchemas {
    fn retrieve(
        &self,
        uri: &jsonschema::Uri<String>,
    ) -> Result<Value, Box<dyn std::error::Error + Send + Sync>> {
        Err(format!("external schema retrieval is disabled: {uri}").into())
    }
}

/// Validate an instance against advertised metadata without network or file
/// retrieval. Invalid or unresolved schemas provide no evidence of support.
pub fn schema_accepts(schema: &Value, value: &Value) -> Option<bool> {
    jsonschema::options()
        .with_retriever(OfflineSchemas)
        .build(schema)
        .ok()
        .map(|validator| validator.is_valid(value))
}
