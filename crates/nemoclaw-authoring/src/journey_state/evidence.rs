// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::*;

impl JourneyState {
    /// Resolve questions and readiness against current observations. Endpoint
    /// models remain suggestions, while target evidence can block readiness.
    pub fn resolve_with_evidence(
        &self,
        capabilities: &Capabilities,
        facts: &AuthoringFacts,
        evidence: Option<&DiscoveryEvidence>,
    ) -> Result<JourneyResolution, Diagnostics> {
        let mut resolution = self.resolve(capabilities)?;
        if let (Some(evidence), Some(document)) = (evidence, resolution.assessment.document()) {
            resolution.target_assessment = Some(evidence.assessment_for_document(document)?);
        }
        let Some(document) = resolution.assessment.document() else {
            return Ok(resolution);
        };
        let Some(request) = crate::inference_request_for_document(document, self.current_route())
            .ok()
            .flatten()
        else {
            return Ok(resolution);
        };
        let Some(observed) = facts.endpoint.as_ref().filter(|observed| {
            observed.request == request
                && observed.observation.status == ObservationStatus::Available
        }) else {
            return Ok(resolution);
        };
        let Some(path) = self.route_model_path() else {
            return Ok(resolution);
        };
        if let Some(question) = resolution
            .questions
            .iter_mut()
            .find(|question| question.id == path)
        {
            if let Some(suggestion) = question.suggestion.clone() {
                question.choices.push(suggestion);
            }
            for model in &observed.observation.models {
                if !model.is_empty() && model.len() <= 512 && !model.chars().any(char::is_control) {
                    let value = Value::String(model.clone());
                    if !question.choices.contains(&value) {
                        question.choices.push(value);
                    }
                }
            }
        }
        Ok(resolution)
    }

    /// Accept remaining suggestions as one explicit, evidence-gated action.
    /// Required questions without a suggestion and route choices stay manual.
    pub fn delegate_remaining(
        &self,
        capabilities: &Capabilities,
        evidence: Option<&DiscoveryEvidence>,
        facts: &AuthoringFacts,
    ) -> Result<Self, Diagnostics> {
        self.check_delegation(capabilities, evidence, facts)?;
        let mut candidate = self.clone();
        for _ in 0..256 {
            let resolution = candidate.resolve_with_evidence(capabilities, facts, evidence)?;
            let Some(question) = resolution.next_question() else {
                if resolution.materialized_document().is_some() {
                    candidate.check_delegation(capabilities, evidence, facts)?;
                    return Ok(candidate);
                }
                return Err(diagnostic(
                    "delegation",
                    "Remaining SDK or Fabric constraints need individual answers.",
                ));
            };
            if question.id == ROUTE_SELECTION {
                return Err(diagnostic(
                    "delegation",
                    "Select each inference route before delegating its questions.",
                ));
            }
            let value = question.suggestion.clone();
            if value.is_none() && question.required {
                return Err(diagnostic(
                    "delegation",
                    "A required question has no safe suggested answer.",
                ));
            }
            candidate.answer(capabilities, question.id(), value)?;
        }
        Err(diagnostic(
            "delegation",
            "Too many questions remain to delegate safely.",
        ))
    }

    pub(super) fn check_delegation(
        &self,
        capabilities: &Capabilities,
        evidence: Option<&DiscoveryEvidence>,
        facts: &AuthoringFacts,
    ) -> Result<(), Diagnostics> {
        if !self.decisions.accepted.contains(HARNESS) {
            return Err(diagnostic(
                "delegation",
                "Choose a harness before delegating settings.",
            ));
        }
        let resolution = self.resolve(capabilities)?;
        let document = resolution
            .assessment()
            .document()
            .ok_or_else(|| diagnostic("delegation", "The desired state is not SDK-valid yet."))?;
        let key = crate::discovery_key_for_document(document)?;
        let evidence = evidence
            .filter(|evidence| evidence.key == key)
            .ok_or_else(|| diagnostic("delegation", "Target discovery is missing or stale."))?;
        if evidence.assessment_for_document(document)?.status != CompatibilityStatus::Compatible {
            return Err(diagnostic(
                "delegation",
                "Target engine and image compatibility is not verified.",
            ));
        }
        let request = crate::inference_request_for_document(document, self.current_route())?
            .ok_or_else(|| {
                diagnostic(
                    "delegation",
                    "The selected route has no external model catalog to verify.",
                )
            })?;
        let endpoint = facts
            .endpoint
            .as_ref()
            .filter(|endpoint| endpoint.request == request)
            .ok_or_else(|| diagnostic("delegation", "Model discovery is missing or stale."))?;
        if endpoint.observation.status != ObservationStatus::Available
            || endpoint.observation.reachable != Some(true)
            || !matches!(
                endpoint.observation.authentication,
                AuthenticationStatus::Accepted | AuthenticationStatus::NotRequired
            )
        {
            return Err(diagnostic(
                "delegation",
                "The model catalog could not be verified.",
            ));
        }
        let model = self
            .route_model_path()
            .and_then(|path| self.authored.values.pointer(&path))
            .and_then(Value::as_str)
            .ok_or_else(|| {
                diagnostic("delegation", "Choose a model before delegating settings.")
            })?;
        if !endpoint
            .observation
            .models
            .iter()
            .any(|advertised| advertised == model)
        {
            return Err(diagnostic(
                "delegation",
                "The selected model was not advertised by the endpoint.",
            ));
        }
        if document.credential_names().iter().any(|reference| {
            !facts.credentials.iter().any(|credential| {
                credential.reference == *reference
                    && credential.status == ObservationStatus::Available
            })
        }) {
            return Err(diagnostic(
                "delegation",
                "Required credentials are unavailable or unverified.",
            ));
        }
        Ok(())
    }
}
