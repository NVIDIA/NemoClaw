// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Offline JSON Schema checks for untrusted schemas, such as those that
//! images and Fabric adapters advertise.
use serde_json::Value;
use std::{
    collections::HashMap,
    sync::{Arc, LazyLock, Mutex},
};

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
    validator(schema).map(|validator| validator.is_valid(value))
}

/// Compiling a schema costs far more than checking a value against it, and
/// authoring checks the same few adapter schemas on every answer, so keep the
/// compiled validators. The cache is keyed by the schema's text and emptied
/// when full, so advertised schemas cannot grow it without bound.
fn validator(schema: &Value) -> Option<Arc<jsonschema::Validator>> {
    const CAPACITY: usize = 256;
    static COMPILED: LazyLock<Mutex<HashMap<String, Option<Arc<jsonschema::Validator>>>>> =
        LazyLock::new(Default::default);
    let key = schema.to_string();
    if let Some(compiled) = COMPILED.lock().expect("schema cache").get(&key) {
        return compiled.clone();
    }
    let compiled = jsonschema::options()
        .with_retriever(OfflineSchemas)
        .build(schema)
        .ok()
        .map(Arc::new);
    let mut cache = COMPILED.lock().expect("schema cache");
    if cache.len() >= CAPACITY {
        cache.clear();
    }
    cache.insert(key, compiled.clone());
    compiled
}
