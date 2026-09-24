// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use nemoclaw_authoring::{ApiChoice, FieldValue, HarnessChoice, ProviderPreset, RuntimeChoice};

pub(super) fn harness(choice: &HarnessChoice) -> &str {
    choice.as_str()
}

pub(super) fn runtime(choice: RuntimeChoice) -> &'static str {
    match choice {
        RuntimeChoice::Docker => "Docker",
        RuntimeChoice::Podman => "Podman",
    }
}

pub(super) fn inference(choice: ProviderPreset) -> &'static str {
    choice.label()
}

pub(super) fn api(choice: ApiChoice) -> &'static str {
    match choice {
        ApiChoice::OpenaiCompletions => "OpenAI chat completions",
        ApiChoice::OpenaiResponses => "OpenAI Responses",
        ApiChoice::AnthropicMessages => "Anthropic Messages",
    }
}

pub(super) fn field_value(value: &FieldValue) -> &str {
    match value {
        FieldValue::Harness(value) => harness(value),
        FieldValue::Runtime(value) => runtime(*value),
        FieldValue::Inference(value) => inference(*value),
        FieldValue::Api(value) => api(*value),
        FieldValue::Text(value) | FieldValue::Model(value) => value,
    }
}
