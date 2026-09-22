// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use nemoclaw_sdk::{
    compile::{Generations, targets},
    config::Document,
};
use std::{env, fs, path::Path};

#[test]
fn parses_exports_and_generates_native_runtime_settings() {
    let input = env::var("NEMOCLAW_V1_CONFIG_INPUTS").expect("missing config input directory");
    let output =
        env::var("NEMOCLAW_V1_SETTINGS_OUTPUT").expect("missing settings output directory");
    fs::create_dir_all(&output).expect("cannot create settings output directory");
    let mut paths = fs::read_dir(input)
        .expect("cannot read config input directory")
        .map(|entry| entry.expect("cannot read config input entry").path())
        .collect::<Vec<_>>();
    paths.sort();
    assert!(
        !paths.is_empty(),
        "config input directory must not be empty"
    );

    for path in paths {
        let document = Document::parse(
            fs::read(&path)
                .expect("cannot read exported config")
                .as_slice(),
        )
        .unwrap_or_else(|error| panic!("{} did not parse: {error}", path.display()));
        let generations: Generations = ["workspace", "provider", "sandbox"]
            .map(|kind| (kind.into(), "a".repeat(32)))
            .into();
        let compiled = targets(&document, &generations)
            .unwrap_or_else(|error| panic!("{} did not compile: {error}", path.display()));
        let sandbox = compiled
            .iter()
            .find(|target| target.kind == "sandbox")
            .unwrap_or_else(|| panic!("{} compiled without a sandbox", path.display()));
        let settings: serde_json::Value = serde_json::from_str(&sandbox.values["inference_json"])
            .unwrap_or_else(|error| {
                panic!(
                    "{} emitted invalid runtime settings: {error}",
                    path.display()
                )
            });
        let name = path
            .file_stem()
            .and_then(|value| value.to_str())
            .expect("config fixture requires a UTF-8 file name");
        fs::write(
            Path::new(&output).join(format!("{name}.json")),
            serde_json::to_vec_pretty(&settings).expect("cannot serialize runtime settings"),
        )
        .expect("cannot write runtime settings");
    }
}
