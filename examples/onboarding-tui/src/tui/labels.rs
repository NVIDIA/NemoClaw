// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use nemoclaw_authoring::{JourneyQuestion, JourneyQuestionKind};
use serde_json::Value;

pub(super) fn display_value(value: &Value) -> String {
    value
        .as_str()
        .map_or_else(|| value.to_string(), str::to_owned)
}

pub(super) fn label(question: &JourneyQuestion) -> String {
    let id = question.id();
    if id.starts_with("adapter:") && id.ends_with(':') {
        return "Adapter settings".into();
    }
    if question.kind() == JourneyQuestionKind::StructuralForm {
        return format!(
            "Choose {} form",
            id.rsplit('/').next().unwrap_or("configuration")
        );
    }
    match id {
        "/metadata/name" => "Deployment name".into(),
        "/spec/sandboxes/0/harness/kind" => "Agent harness".into(),
        "/spec/sandboxes/0/runtime/provider" => "Container runtime".into(),
        "inference:preset" => "Inference provider".into(),
        "route:selection" => "Inference route".into(),
        _ => id.rsplit('/').next().unwrap_or(id).replace(['-', '_'], " "),
    }
}

// External labels stay unchanged in authored values; escape them only for the terminal.
pub(super) fn terminal_text(value: &str) -> String {
    value
        .chars()
        .flat_map(|character| {
            if character.is_control()
                || matches!(character, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
            {
                character.escape_default().collect::<Vec<_>>()
            } else {
                vec![character]
            }
        })
        .collect()
}
