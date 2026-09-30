// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use nemoclaw_authoring::{
    AnswerOverrides, ApiChoice, EditableField, PartialTemplate, ProviderPreset, RuntimeChoice,
};

/// The example's partial template keeps its existing questions and defaults.
pub(crate) fn onboarding_template() -> PartialTemplate {
    PartialTemplate::new("example-onboarding")
        .with_values(AnswerOverrides {
            runtime: Some(RuntimeChoice::Docker),
            inference: Some(ProviderPreset::NvidiaEndpoints),
            api: Some(ApiChoice::OpenaiCompletions),
            ..AnswerOverrides::default()
        })
        .ask([
            EditableField::Harness,
            EditableField::Runtime,
            EditableField::Inference,
            EditableField::Api,
            EditableField::DeploymentName,
            EditableField::Model,
        ])
}
