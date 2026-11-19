// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use serde_json::{Value, json};
pub fn constrain(defs: &mut serde_json::Map<String, Value>) {
    use crate::schema::property;
    for (field, rule) in [
        (
            "repository",
            json!({"pattern":crate::vllm::constraints::REPOSITORY,"maxLength":200}),
        ),
        ("revision", json!({"pattern":"^[a-f0-9]{40}$"})),
        ("sha256", json!({"pattern":"^[a-f0-9]{64}$"})),
        (
            "file",
            json!({"minLength":6,"maxLength":512,"pattern":r"^[a-zA-Z0-9][a-zA-Z0-9._/-]*\.gguf$"}),
        ),
        (
            "sizeBytes",
            json!({"minimum":1,"maximum":1099511627776_u64}),
        ),
    ] {
        property(&mut defs["GgufModel"], field, rule);
    }
    for (field, min, max) in [
        ("port", 1024, 65535),
        ("contextTokens", 8192, 131072),
        ("batchTokens", 1, 4096),
        ("microBatchTokens", 1, 4096),
        ("startupTimeoutSeconds", 60, 3600),
    ] {
        property(
            &mut defs["LlamaCppServing"],
            field,
            json!({"minimum":min,"maximum":max}),
        );
    }
    property(
        &mut defs["LlamaCppServing"],
        "modelName",
        json!({"pattern":crate::schema::MODEL,"minLength":1}),
    );
    property(
        &mut defs["LlamaCppServing"],
        "reasoningStrength",
        json!({"enum":["low","medium","high"]}),
    );
}
