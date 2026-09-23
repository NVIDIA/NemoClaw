// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use nemoclaw_sdk::{
    compile::{Generations, targets},
    config::Document,
};
use std::{env, fs};

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
    let sandbox = compiled
        .iter()
        .find(|target| target.kind == "sandbox")
        .expect("compiled export must contain a sandbox");
    fs::write(output, &sandbox.values["inference_json"])
        .expect("cannot write runtime settings");
}
