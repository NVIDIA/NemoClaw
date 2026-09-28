// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use crate::{
    AnswerStatus, AuthoringFacts, Capabilities, CompatibilityStatus, Diagnostics,
    DiscoveryEvidence, Draft, EditableField, diagnostics::diagnostic,
};
use nemoclaw_sdk::{discovery::ObservationStatus, inference_discovery::AuthenticationStatus};

impl Draft {
    /// Check whether observations support delegating the remaining suggestions.
    /// This qualifies an authoring shortcut, not deployment or inference readiness.
    /// Consumers supply observations for the current inputs, refresh credential
    /// availability at delegation, and refresh network observations at review.
    pub fn check_delegation(
        &self,
        capabilities: &Capabilities,
        evidence: Option<&DiscoveryEvidence>,
        facts: &AuthoringFacts,
    ) -> Result<(), Diagnostics> {
        if self.answer_status(EditableField::Harness) != AnswerStatus::Accepted {
            return Err(diagnostic(
                "delegation",
                "Choose a harness before delegating settings.",
            ));
        }
        let key = self.discovery_key()?;
        let Some(evidence) = evidence.filter(|evidence| evidence.key == key) else {
            return Err(diagnostic(
                "delegation",
                "Target discovery is missing or stale. Continue answering individually.",
            ));
        };
        if evidence.assessment(self)?.status != CompatibilityStatus::Compatible {
            return Err(diagnostic(
                "delegation",
                "Discovery has not established compatible engine and image settings. Continue answering individually.",
            ));
        }
        let request = self.inference_request(capabilities)?;
        let Some(endpoint) = facts
            .endpoint
            .as_ref()
            .filter(|endpoint| endpoint.request == request)
        else {
            return Err(diagnostic(
                "delegation",
                "Model discovery is missing or stale. Continue answering individually.",
            ));
        };
        let observation = &endpoint.observation;
        if observation.status != ObservationStatus::Available
            || observation.reachable != Some(true)
            || !matches!(
                observation.authentication,
                AuthenticationStatus::Accepted | AuthenticationStatus::NotRequired
            )
        {
            return Err(diagnostic(
                "delegation",
                "The model catalog could not be verified. Continue answering individually.",
            ));
        }
        let answers = self.guided_answers(capabilities)?;
        if !observation.models.contains(&answers.model) {
            return Err(diagnostic(
                "delegation",
                "The suggested model was not advertised. Choose a model before delegating settings.",
            ));
        }
        if self.document().credential_names().iter().any(|reference| {
            !facts.credentials.iter().any(|credential| {
                credential.reference == *reference
                    && credential.status == ObservationStatus::Available
            })
        }) {
            return Err(diagnostic(
                "delegation",
                "Required credentials are unavailable or unverified. Continue answering individually.",
            ));
        }
        self.validate_settings(capabilities)?;
        self.review()?;
        Ok(())
    }

    /// Explicitly authorize the remaining current suggestions as a group.
    /// Preserve accepted answers and commit atomically after checking the whole
    /// configuration; do not search other engines, providers, or images.
    pub fn delegate_remaining(
        &self,
        capabilities: &Capabilities,
        evidence: Option<&DiscoveryEvidence>,
        facts: &AuthoringFacts,
    ) -> Result<Self, Diagnostics> {
        let mut candidate = self.clone();
        candidate.delegate_setting_defaults(capabilities)?;
        candidate.check_delegation(capabilities, evidence, facts)?;
        while let Some(question) = candidate.next_question(capabilities)? {
            candidate.delegate(capabilities, question.id())?;
        }
        candidate.check_delegation(capabilities, evidence, facts)?;
        Ok(candidate)
    }

    /// Return delegated choices to the interview without losing explicit answers.
    pub fn revoke_delegation(&mut self) {
        self.decisions
            .retain(|_, status| *status != AnswerStatus::Delegated);
        self.revoke_setting_delegation();
    }

    pub fn has_delegated_answers(&self) -> bool {
        self.decisions
            .values()
            .any(|status| *status == AnswerStatus::Delegated)
            || !self.delegated_settings.is_empty()
    }
}
