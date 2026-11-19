// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::*;

impl JourneyState {
    /// Resolve questions and readiness against the observations gathered so far.
    /// A vendor's recommended models, narrowed to those its endpoint lists,
    /// are the model suggestions, while target observations can block
    /// readiness. Credential availability is the review's to report; an empty
    /// sheet leaves compatibility unverified.
    pub fn resolve_with_observations(
        &self,
        capabilities: &Capabilities,
        observations: &DiscoveryObservations,
    ) -> Result<JourneyResolution, Diagnostics> {
        let mut resolution = self.resolve(capabilities)?;
        // A host that can run only one local runtime makes it the suggestion,
        // even over a supplied value; the user still decides.
        let answered = self.answered_engines.as_deref().unwrap_or_default();
        let mut runtimes: Vec<&str> = Vec::new();
        for engine in answered {
            if !runtimes.contains(&engine.compute_driver.as_str()) {
                runtimes.push(engine.compute_driver.as_str());
            }
        }
        if let [only] = runtimes.as_slice()
            && let Some(question) = resolution
                .questions
                .iter_mut()
                .find(|question| question.id == GATEWAY_TARGET)
        {
            question.suggestion = Some(Value::String((*only).into()));
        }
        if !observations.is_empty()
            && let Some(document) = resolution.assessment.document()
        {
            resolution.target_assessment = Some(crate::assess_target(document, observations)?);
        }
        // Without an engine for its target, a managed Docker gateway falls back
        // to the SDK's default socket, whose read reports a mismatch rather
        // than the cause. So that socket is not offered as the engine either:
        // accepting it would author a socket no engine answered on.
        if let Some((target, path)) = self.target_without_local_engine() {
            let reason = format!(
                "No {target} engine answered on this machine. Start it, or set spec.gateway.target.{target}.engine to its socket."
            );
            // The question states the cause where the user answers; the
            // assessment keeps it for review.
            if let Some(question) = resolution
                .questions
                .iter_mut()
                .find(|question| question.id == path)
            {
                question.suggestion = None;
                question.note = Some(reason.clone());
            }
            // Podman has no default engine, so its document stays incomplete
            // and no target was assessed; the cause is still the first thing
            // to report.
            resolution
                .target_assessment
                .get_or_insert_with(|| crate::DiscoveryAssessment {
                    status: crate::CompatibilityStatus::Unverified,
                    reasons: Vec::new(),
                })
                .reasons
                .insert(0, reason);
        }
        self.offer_agent_images(&mut resolution.questions, observations);
        let Some(document) = resolution.assessment.document() else {
            return Ok(resolution);
        };
        let Some(request) = crate::inference_request_for_document(document, self.current_route())
            .ok()
            .flatten()
        else {
            return Ok(resolution);
        };
        let Some(observed) = observations.get(&request) else {
            return Ok(resolution);
        };
        if let Some(note) = catalog_credential_note(&request, observed) {
            resolution.information.push(note);
            // An authentication requirement says nothing about the offline
            // recommendations. It still blocks fact-gated bulk acceptance.
            if self.catalog_preset().is_none()
                && let Some(path) = self.route_model_path()
                && let Some(question) = resolution
                    .questions
                    .iter_mut()
                    .find(|question| question.id == path)
            {
                question.choices.clear();
                question.suggestion = None;
            }
            return Ok(resolution);
        }
        if observed.status != ObservationStatus::Available {
            return Ok(resolution);
        }
        let Some(path) = self.route_model_path() else {
            return Ok(resolution);
        };
        // A list with no usable entry says nothing about what the endpoint offers.
        let listed: Vec<&str> = observed
            .models
            .iter()
            .map(String::as_str)
            .filter(|model| {
                !model.is_empty() && model.len() <= 512 && !model.chars().any(char::is_control)
            })
            .collect();
        // A vendor with recommendations offers only those the endpoint lists,
        // since its full catalog holds models that cannot drive an agent.
        // Endpoints without recommendations offer what they list, and so does
        // a vendor whose endpoint lists none of its recommendations, rather
        // than leaving the user with an empty menu.
        let vendor = self.catalog_preset().filter(|_| !listed.is_empty());
        if let Some(question) = resolution
            .questions
            .iter_mut()
            .find(|question| question.id == path)
        {
            let mut offer_listed = true;
            if let Some(preset) = vendor {
                let recommended = preset.recommended_models();
                let missing = |value: &Value| {
                    value.as_str().is_some_and(|model| {
                        recommended.contains(&model) && !listed.contains(&model)
                    })
                };
                question.choices.retain(|choice| !missing(choice));
                if question.suggestion.as_ref().is_some_and(missing) {
                    question.suggestion = question.choices.first().cloned();
                }
                offer_listed = !question.choices.iter().any(|choice| {
                    choice
                        .as_str()
                        .is_some_and(|model| recommended.contains(&model))
                });
            }
            if offer_listed {
                if let Some(suggestion) = question.suggestion.clone()
                    && !question.choices.contains(&suggestion)
                {
                    question.choices.push(suggestion);
                }
                for model in &listed {
                    let value = Value::String((*model).into());
                    if !question.choices.contains(&value) {
                        question.choices.push(value);
                    }
                }
            }
        }
        // The endpoint's list also checks a model the user typed. Say so only
        // once the model is settled, and never echo it: it may be sensitive.
        if !listed.is_empty()
            && !resolution
                .questions
                .iter()
                .any(|question| question.id == path)
            && let Some(model) = self.authored.values.pointer(&path).and_then(Value::as_str)
            && !listed.contains(&model)
        {
            resolution.information.push(
                "The endpoint's model list does not include the selected model. Check the identifier before you deploy."
                    .into(),
            );
        }
        Ok(resolution)
    }

    /// Offer each sandbox image question the images on the engine that install
    /// its harness, suggesting the newest unless the suggestion is one of
    /// them; with none, link the build instructions.
    fn offer_agent_images(
        &self,
        questions: &mut [JourneyQuestion],
        observations: &DiscoveryObservations,
    ) {
        for question in questions {
            let Some(request) = self.agent_images_request(&question.id) else {
                continue;
            };
            let Some(observed) = observations
                .get(&request)
                .filter(|observed| observed.status == ObservationStatus::Available)
            else {
                continue;
            };
            let references: Vec<Value> = observed
                .references
                .iter()
                .cloned()
                .map(Value::String)
                .collect();
            if references.is_empty() {
                question.note = Some(format!(
                    "No image on this engine installs {}; see {BUILD_AGENT_IMAGES}.",
                    request.adapter_id
                ));
                continue;
            }
            if !question
                .suggestion
                .as_ref()
                .is_some_and(|suggestion| references.contains(suggestion))
            {
                question.suggestion = references.first().cloned();
            }
            question.choices = references;
        }
    }

    /// Answer the sandbox image question with the one image the engine holds
    /// for the harness, unless the document names another. The read depends
    /// on the harness, the target and the engine, so it waits until none of
    /// their questions is open.
    pub fn answer_single_agent_images(
        &mut self,
        capabilities: &Capabilities,
        observations: &DiscoveryObservations,
    ) {
        let Ok(resolution) = self.resolve(capabilities) else {
            return;
        };
        let open = |id: &str| resolution.questions().iter().any(|open| open.id() == id);
        if open(GATEWAY_TARGET)
            || gateway_engine(&self.authored.values).is_some_and(|(_, engine)| open(&engine))
            || harness_question(&self.authored.values).is_some_and(|id| open(&id))
        {
            return;
        }
        for question in resolution.questions() {
            let Some(observed) = self
                .agent_images_request(question.id())
                .and_then(|request| observations.get(&request))
                .filter(|observed| observed.status == ObservationStatus::Available)
            else {
                continue;
            };
            let [only] = observed.references.as_slice() else {
                continue;
            };
            if self
                .authored
                .values
                .pointer(question.id())
                .is_some_and(|named| named.as_str() != Some(only))
            {
                continue;
            }
            // A reference the schema rejects leaves the question to its user.
            let _ = self.answer(
                capabilities,
                question.id(),
                Some(Value::String(only.clone())),
            );
        }
    }

    /// The chosen local target of a managed gateway without an authored
    /// engine, and that engine's path, when this machine was asked and no
    /// engine answered for that target.
    fn target_without_local_engine(&self) -> Option<(&str, String)> {
        let answered = self.answered_engines.as_deref()?;
        let values = &self.authored.values;
        if values
            .pointer("/spec/gateway/management")
            .and_then(Value::as_str)
            != Some("managed")
        {
            return None;
        }
        let (target, path) = gateway_engine(values)?;
        (values.pointer(&path).is_none()
            && !answered
                .iter()
                .any(|engine| engine.compute_driver.as_str() == target))
        .then_some((target, path))
    }

    /// Accept remaining suggestions as one explicit, fact-gated action.
    /// Required questions without a suggestion and route choices stay manual.
    pub fn delegate_remaining(
        &self,
        capabilities: &Capabilities,
        observations: &DiscoveryObservations,
    ) -> Result<Self, Diagnostics> {
        self.check_delegation(capabilities, observations)?;
        let mut candidate = self.clone();
        for _ in 0..256 {
            let resolution = candidate.resolve_with_observations(capabilities, observations)?;
            let Some(question) = resolution.next_question() else {
                if resolution.materialized_document().is_some() {
                    candidate.check_delegation(capabilities, observations)?;
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
            // A choice that cannot be omitted takes its schema default.
            let value = question.suggestion.clone().or_else(|| {
                (!question.omittable())
                    .then(|| question.schema.get("default").cloned())
                    .flatten()
            });
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
        observations: &DiscoveryObservations,
    ) -> Result<(), Diagnostics> {
        if !harness_question(&self.authored.values)
            .is_some_and(|id| self.decisions.accepted.contains(&id))
        {
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
        let target = crate::assess_target(document, observations)?;
        if target.status != CompatibilityStatus::Compatible {
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
        let endpoint = observations
            .get(&request)
            .ok_or_else(|| diagnostic("delegation", "Model discovery is missing or stale."))?;
        if let Some(note) = catalog_credential_note(&request, endpoint) {
            return Err(diagnostic("inference:catalog:credential", &note));
        }
        if endpoint.status != ObservationStatus::Available
            || endpoint.reachable != Some(true)
            || !matches!(
                endpoint.authentication,
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
        if !endpoint.models.iter().any(|advertised| advertised == model) {
            return Err(diagnostic(
                "delegation",
                "The selected model was not advertised by the endpoint.",
            ));
        }
        Ok(())
    }
}

/// Where the documentation says how to build an agent image.
const BUILD_AGENT_IMAGES: &str =
    "https://github.com/NVIDIA/NemoClaw/blob/v1/docs/build-deploy/build.md#build-agent-images";

/// Only a reachable server's explicit authentication requirement establishes
/// this condition. A denied key or unreachable catalog remains a real failure.
fn catalog_credential_note(
    request: &nemoclaw_sdk::inference_discovery::EndpointRequest,
    endpoint: &nemoclaw_sdk::inference_discovery::EndpointObservation,
) -> Option<String> {
    if endpoint.status != ObservationStatus::Unavailable
        || endpoint.reachable != Some(true)
        || endpoint.authentication != AuthenticationStatus::Required
    {
        return None;
    }
    request.credential_env.as_ref().map(|reference| format!(
        "Model catalog needs credential {reference}. Set it to see model suggestions and use bulk acceptance, or enter a model identifier to continue individually."
    ))
}
