// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use nemoclaw_sdk::compile::Target;

pub fn normalized(rows: Vec<Target>) -> Vec<Target> {
    normalized_as(rows, "local")
}

pub fn normalized_as(rows: Vec<Target>, original: &str) -> Vec<Target> {
    let names: Vec<_> = rows
        .iter()
        .filter(|row| row.kind == "provider")
        .map(|row| row.values["name"].clone())
        .filter(|name| name.starts_with("local-"))
        .collect();
    let mut text = serde_json::to_string(&rows).unwrap();
    for name in names {
        text = text
            .replace(
                &name.replace('-', "_").to_ascii_uppercase(),
                &original.replace('-', "_").to_ascii_uppercase(),
            )
            .replace(&name, original);
    }
    serde_json::from_str(&text).unwrap()
}
