// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Parse one V0 export with the pinned v1 SDK and write the parsed document as JSON.
//! Parsing runs v1's schema and semantic validation; a rejection exits nonzero.

use nemoclaw_sdk::config::Document;
use std::{env, fs};

fn main() {
    let input = env::var("NEMOCLAW_V1_CONFIG_INPUT").expect("missing config input");
    let output = env::var("NEMOCLAW_V1_DOCUMENT_OUTPUT").expect("missing document output");
    let bytes = fs::read(input).expect("cannot read export");
    let document = Document::parse(bytes.as_slice()).unwrap_or_else(|error| {
        eprintln!("configuration rejected: {error}");
        std::process::exit(2);
    });
    fs::write(
        output,
        serde_json::to_vec(&document).expect("cannot serialize parsed document"),
    )
    .expect("cannot write parsed document");
}
