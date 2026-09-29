// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use crate::config::{constraints, schema::validation::property};
use serde_json::{Value, json};
pub(crate) fn constrain(defs: &mut serde_json::Map<String, Value>, normalized: bool) {
    nemoclaw_runtime::vllm::schema::constrain(defs, normalized);
    let service = defs["ServiceDefinition"]["oneOf"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|v| v["properties"]["kind"]["const"] == "vllm")
        .unwrap();
    property(service, "image", json!({"pattern":constraints::IMAGE}));
    service["dependentRequired"] =
        json!({"placement": ["publication"], "publication": ["placement"]});
    property(
        &mut defs["ServicePlacement"],
        "engine",
        json!({"pattern": "^ssh://"}),
    );
    property(
        &mut defs["ServicePlacement"],
        "networkCidr",
        json!({"pattern": "/24$"}),
    );
    property(
        &mut defs["ServicePublication"],
        "endpoint",
        json!({"pattern": "^http://.+:[0-9]+/v1$"}),
    );
    property(
        &mut defs["ServiceContainer"],
        "sharedMemoryGiB",
        json!({"minimum":1,"maximum":64}),
    );
}
