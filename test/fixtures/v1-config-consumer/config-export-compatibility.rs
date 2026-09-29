// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use nemoclaw_sdk::{
    compile::{Generations, targets},
    config::Document,
};
use serde_json::{Value, json};
use std::{collections::BTreeMap, env, fs};

#[test]
fn parses_export_and_generates_runtime_settings() {
    let input = env::var("NEMOCLAW_V1_CONFIG_INPUT").expect("missing config input");
    let output = env::var("NEMOCLAW_V1_SETTINGS_OUTPUT").expect("missing settings output");
    let document = Document::parse(fs::read(input).expect("cannot read export").as_slice())
        .expect("raw export must parse");
    let generations: Generations = ["workspace", "provider", "sandbox"]
        .map(|kind| (kind.into(), "a".repeat(32)))
        .into();
    let compiled = targets(&document, &generations).expect("export must compile");
    let sandboxes: BTreeMap<String, Value> = compiled
        .iter()
        .filter(|target| target.kind == "sandbox")
        .map(|target| {
            (
                target.values["name"].clone(),
                json!({
                    "runtime": target.values["agent_runtime"].clone(),
                    "settings": serde_json::from_str::<Value>(&target.values["inference_json"])
                        .expect("sandbox inference settings must be JSON"),
                }),
            )
        })
        .collect();
    assert!(!sandboxes.is_empty(), "compiled export must contain a sandbox");
    fs::write(
        output,
        serde_json::to_vec(&sandboxes).expect("cannot serialize runtime settings"),
    )
        .expect("cannot write runtime settings");
}
