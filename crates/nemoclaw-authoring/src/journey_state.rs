// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Resolution of the bounded journey surface against sparse authored values.

use std::collections::{BTreeMap, BTreeSet};

use nemoclaw_sdk::config::{Document, InferenceApi, InferenceProviderKind};
use nemoclaw_sdk::discovery::ObservationStatus;
use nemoclaw_sdk::fabric_capabilities::schema_accepts;
use nemoclaw_sdk::inference_discovery::AuthenticationStatus;
use serde_json::{Map, Value};

use crate::{
    AuthoringFacts, Capabilities, CompatibilityStatus, Diagnostics, DiscoveryAssessment,
    DiscoveryEvidence, PartialAssessment, PartialDocument, PartialIssueKind, ProviderPreset,
    diagnostics::diagnostic,
    journey_definition::{
        HARNESS, INFERENCE_PRESET, JourneyDefinition, JourneyScope, NAME, adapter_field,
        adapter_schema, sdk_field_schema,
    },
    settings::SettingQuestion,
};

const PROVIDER_API: &str = "/spec/inferenceProviders/0/api";
const ROUTE_SELECTION: &str = "route:selection";
const ROUTES: &str = "/spec/sandboxes/0/agent/inference/routes";
const RUNTIME_PROVIDER: &str = "/spec/sandboxes/0/runtime/provider";

/// Why an applicable decision is still open.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum JourneyQuestionReason {
    Missing,
    ExplicitAsk,
    InvalidSupplied,
}

/// One currently applicable decision in the bounded journey surface.
#[derive(Clone, Debug, PartialEq)]
pub struct JourneyQuestion {
    id: String,
    reason: JourneyQuestionReason,
    required: bool,
    choices: Vec<Value>,
    suggestion: Option<Value>,
    schema: Value,
}

impl JourneyQuestion {
    pub fn id(&self) -> &str {
        &self.id
    }
    pub fn reason(&self) -> JourneyQuestionReason {
        self.reason
    }
    pub fn required(&self) -> bool {
        self.required
    }
    pub fn choices(&self) -> &[Value] {
        &self.choices
    }
    pub fn suggestion(&self) -> Option<&Value> {
        self.suggestion.as_ref()
    }
    pub fn schema(&self) -> &Value {
        &self.schema
    }
}

/// A fresh result, recomputed after each answer or catalog change.
#[derive(Clone, Debug)]
pub struct JourneyResolution {
    questions: Vec<JourneyQuestion>,
    omitted: Vec<String>,
    warnings: Vec<String>,
    unverified: Vec<String>,
    assessment: PartialAssessment,
    target_required: bool,
    target_assessment: Option<DiscoveryAssessment>,
}

impl JourneyResolution {
    pub fn questions(&self) -> &[JourneyQuestion] {
        &self.questions
    }
    pub fn question(&self, id: &str) -> Option<&JourneyQuestion> {
        self.questions.iter().find(|question| question.id == id)
    }
    pub fn next_question(&self) -> Option<&JourneyQuestion> {
        self.questions.first()
    }
    pub fn omitted(&self) -> &[String] {
        &self.omitted
    }
    pub fn warnings(&self) -> &[String] {
        &self.warnings
    }
    pub fn unverified(&self) -> &[String] {
        &self.unverified
    }
    pub fn assessment(&self) -> &PartialAssessment {
        &self.assessment
    }

    pub fn target_assessment(&self) -> Option<&DiscoveryAssessment> {
        self.target_assessment.as_ref()
    }

    /// SDK-valid desired state only after every question in this resolver's
    /// current surface is answered and no Fabric schema is unverified.
    /// Target compatibility remains a separate check.
    pub fn materialized_document(&self) -> Option<&Document> {
        if self.questions.is_empty() && self.unverified.is_empty() {
            self.assessment.document()
        } else {
            None
        }
    }

    /// A completed document whose configured target prerequisites are met.
    pub fn ready_document(&self) -> Option<&Document> {
        let document = self.materialized_document()?;
        if self.target_required
            && self
                .target_assessment
                .as_ref()
                .is_none_or(|assessment| assessment.status != CompatibilityStatus::Compatible)
        {
            return None;
        }
        Some(document)
    }
}

/// Mutable answers and explicit omissions over a journey definition's sparse base.
#[derive(Clone, Debug)]
pub struct JourneyState {
    definition: JourneyDefinition,
    values: Value,
    accepted: BTreeSet<String>,
    omitted: BTreeSet<String>,
    inactive_settings: BTreeMap<String, Value>,
    selected_presets: BTreeMap<usize, ProviderPreset>,
    accepted_presets: BTreeSet<usize>,
    accepted_model_settings: BTreeSet<(usize, String)>,
    omitted_model_settings: BTreeSet<(usize, String)>,
    generated_gateway_engine: bool,
    selected_route: Option<usize>,
    completed_routes: BTreeSet<usize>,
}

impl JourneyState {
    pub(crate) fn new(definition: JourneyDefinition) -> Self {
        let values = definition.base.supplied().clone();
        let selected_route = (routes_path(&values)
            .and_then(|path| values.pointer(&path))
            .and_then(Value::as_array)
            .map_or(0, Vec::len)
            <= 1)
            .then_some(0);
        Self {
            definition,
            values,
            accepted: BTreeSet::new(),
            omitted: BTreeSet::new(),
            inactive_settings: BTreeMap::new(),
            selected_presets: BTreeMap::new(),
            accepted_presets: BTreeSet::new(),
            accepted_model_settings: BTreeSet::new(),
            omitted_model_settings: BTreeSet::new(),
            generated_gateway_engine: false,
            selected_route,
            completed_routes: BTreeSet::new(),
        }
    }

    pub fn values(&self) -> &Value {
        &self.values
    }

    pub fn current_route(&self) -> Option<&str> {
        let index = self.selected_route?;
        self.values
            .pointer(&format!("{}/{index}/name", routes_path(&self.values)?))
            .and_then(Value::as_str)
    }

    /// Add current endpoint observations to model suggestions. The model remains
    /// free text; a discovery response is never an allowlist.
    pub fn resolve_with_facts(
        &self,
        capabilities: &Capabilities,
        facts: &AuthoringFacts,
    ) -> Result<JourneyResolution, Diagnostics> {
        let mut resolution = self.resolve(capabilities)?;
        let Some(document) = resolution.assessment.document() else {
            return Ok(resolution);
        };
        let Some(request) =
            crate::inference_request_for_document(document, self.current_route()).ok()
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

    /// Recheck target evidence against the current desired state. A missing or
    /// stale observation is unverified, never an implicit approval.
    pub fn resolve_with_target(
        &self,
        capabilities: &Capabilities,
        evidence: Option<&DiscoveryEvidence>,
    ) -> Result<JourneyResolution, Diagnostics> {
        let mut resolution = self.resolve(capabilities)?;
        if let (Some(evidence), Some(document)) = (evidence, resolution.assessment.document()) {
            resolution.target_assessment = Some(evidence.assessment_for_document(document)?);
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
            let resolution = candidate.resolve_with_facts(capabilities, facts)?;
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

    fn check_delegation(
        &self,
        capabilities: &Capabilities,
        evidence: Option<&DiscoveryEvidence>,
        facts: &AuthoringFacts,
    ) -> Result<(), Diagnostics> {
        if !self.accepted.contains(HARNESS) {
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
        let request = crate::inference_request_for_document(document, self.current_route())?;
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
            .and_then(|path| self.values.pointer(&path))
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

    fn route_model_path(&self) -> Option<String> {
        let index = self.selected_route?;
        Some(format!(
            "{}/{index}/overrides/model",
            routes_path(&self.values)?
        ))
    }

    fn route_provider(&self) -> Option<(usize, usize)> {
        let route = self.selected_route?;
        let reference = self
            .values
            .pointer(&format!(
                "{}/{route}/providerRef",
                routes_path(&self.values)?
            ))?
            .as_str()?;
        let providers = self
            .values
            .pointer("/spec/inferenceProviders")?
            .as_array()?;
        let provider = providers
            .iter()
            .position(|item| item.get("name").and_then(Value::as_str) == Some(reference))?;
        (providers[provider].get("serviceRef").is_none()).then_some((route, provider))
    }

    fn provider_path(&self) -> Option<String> {
        self.route_provider()
            .map(|(_, provider)| format!("/spec/inferenceProviders/{provider}"))
    }

    fn current_preset(&self) -> Option<ProviderPreset> {
        let (route, provider_index) = self.route_provider()?;
        if let Some(preset) = self.selected_presets.get(&route).copied() {
            return Some(preset);
        }
        let provider = self
            .values
            .pointer(&format!("/spec/inferenceProviders/{provider_index}"))?;
        let kind: InferenceProviderKind =
            serde_json::from_value(provider.get("provider")?.clone()).ok()?;
        let endpoint = provider.get("endpoint")?.as_str()?;
        ProviderPreset::ALL
            .into_iter()
            .find(|preset| preset.profile().kind == kind && preset.profile().endpoint == endpoint)
            .or_else(|| {
                ProviderPreset::ALL.into_iter().find(|preset| {
                    preset.profile().kind == kind && preset.profile().custom_endpoint
                })
            })
    }

    /// Resolve identity, harness, guided SDK field guidance, and top-level adapter
    /// settings. Unasked SDK requirements and conditional Fabric branches remain explicit.
    pub fn resolve(&self, capabilities: &Capabilities) -> Result<JourneyResolution, Diagnostics> {
        self.definition.validate_guidance(capabilities)?;
        let assessment = PartialDocument::from_value(self.values.clone()).assess();
        let mut questions = Vec::new();
        let mut omitted = Vec::new();
        let mut unverified = Vec::new();
        let mut warnings = Vec::new();
        let name = self.values.pointer(NAME);
        let invalid_name = assessment
            .issues()
            .iter()
            .any(|issue| issue.path() == NAME && issue.kind() == PartialIssueKind::Invalid);
        if name.is_none()
            || invalid_name
            || (self.definition.ask.contains(NAME) && !self.accepted.contains(NAME))
        {
            questions.push(JourneyQuestion {
                id: NAME.into(),
                reason: if invalid_name {
                    JourneyQuestionReason::InvalidSupplied
                } else if name.is_none() {
                    JourneyQuestionReason::Missing
                } else {
                    JourneyQuestionReason::ExplicitAsk
                },
                required: true,
                choices: Vec::new(),
                suggestion: name.cloned(),
                schema: serde_json::json!({"type":"string"}),
            });
        }

        for field in &self.definition.ask {
            if field == NAME
                || field == HARNESS
                || field == INFERENCE_PRESET
                || adapter_field(field).is_some()
            {
                continue;
            }
            if self.omitted.contains(field) {
                omitted.push(field.clone());
                continue;
            }
            let Some((mut schema, required)) = sdk_field_schema(field) else {
                continue;
            };
            if field == PROVIDER_API
                && self.definition.ask.contains(INFERENCE_PRESET)
                && let Some(preset) = self.current_preset()
            {
                schema["enum"] = Value::Array(
                    preset
                        .apis()
                        .iter()
                        .map(|api| serde_json::to_value(api).expect("SDK API serializes"))
                        .collect(),
                );
            }
            let value = self.values.pointer(field);
            let valid = value.is_some_and(|value| schema_accepts(&schema, value) == Some(true));
            if value.is_none() || !valid || !self.accepted.contains(field) {
                questions.push(JourneyQuestion {
                    id: field.clone(),
                    reason: if value.is_some() && !valid {
                        JourneyQuestionReason::InvalidSupplied
                    } else if value.is_none() {
                        JourneyQuestionReason::Missing
                    } else {
                        JourneyQuestionReason::ExplicitAsk
                    },
                    required,
                    choices: finite_choices(&schema),
                    suggestion: value.cloned().or_else(|| schema.get("default").cloned()),
                    schema,
                });
            }
        }

        if self
            .definition
            .ask_scopes
            .contains(&JourneyScope::RouteModels)
        {
            if let Some(path) = self.route_model_path()
                && !self.accepted.contains(&path)
                && !questions.iter().any(|question| question.id == path)
                && let Some((schema, required)) = sdk_field_schema(&path)
            {
                let value = self.values.pointer(&path);
                questions.push(JourneyQuestion {
                    id: path,
                    reason: if value.is_some() {
                        JourneyQuestionReason::ExplicitAsk
                    } else {
                        JourneyQuestionReason::Missing
                    },
                    required,
                    choices: Vec::new(),
                    suggestion: value.cloned(),
                    schema,
                });
            }
            if let Some(routes) = routes_path(&self.values)
                .and_then(|path| self.values.pointer(&path))
                .and_then(Value::as_array)
                && routes.len() > 1
            {
                let current_pending = self
                    .route_model_path()
                    .is_some_and(|path| questions.iter().any(|question| question.id == path));
                if !current_pending {
                    let choices = routes
                        .iter()
                        .enumerate()
                        .filter(|(index, _)| {
                            Some(*index) != self.selected_route
                                && !self.completed_routes.contains(index)
                        })
                        .filter_map(|(_, route)| route.get("name").cloned())
                        .collect::<Vec<_>>();
                    let choices = if self.selected_route.is_none() {
                        routes
                            .iter()
                            .filter_map(|route| route.get("name").cloned())
                            .collect::<Vec<_>>()
                    } else {
                        choices
                    };
                    if !choices.is_empty() {
                        questions.push(JourneyQuestion {
                            id: ROUTE_SELECTION.into(),
                            reason: JourneyQuestionReason::Missing,
                            required: true,
                            choices,
                            suggestion: None,
                            schema: serde_json::json!({"type":"string"}),
                        });
                    }
                }
            }
        }

        if self.definition.ask.contains(INFERENCE_PRESET)
            && self.route_provider().is_some()
            && !self
                .selected_route
                .is_some_and(|route| self.accepted_presets.contains(&route))
        {
            let suggestion = self
                .current_preset()
                .map(|preset| Value::String(preset.id().into()));
            questions.push(JourneyQuestion {
                id: INFERENCE_PRESET.into(),
                reason: if suggestion.is_some() {
                    JourneyQuestionReason::ExplicitAsk
                } else {
                    JourneyQuestionReason::Missing
                },
                required: true,
                choices: ProviderPreset::ALL
                    .into_iter()
                    .map(|preset| Value::String(preset.id().into()))
                    .collect(),
                suggestion,
                schema: serde_json::json!({"type":"string"}),
            });
        }
        if self
            .definition
            .ask_scopes
            .contains(&JourneyScope::InferenceApi)
            && let Some(provider) = self.provider_path()
        {
            let path = format!("{provider}/api");
            if !self.accepted.contains(&path)
                && let Some((mut schema, required)) = sdk_field_schema(&path)
            {
                if let Some(preset) = self.current_preset() {
                    schema["enum"] = Value::Array(
                        preset
                            .apis()
                            .iter()
                            .map(|api| serde_json::to_value(api).expect("SDK API serializes"))
                            .collect(),
                    );
                }
                let value = self.values.pointer(&path);
                questions.push(JourneyQuestion {
                    id: path,
                    reason: if value.is_some() {
                        JourneyQuestionReason::ExplicitAsk
                    } else {
                        JourneyQuestionReason::Missing
                    },
                    required,
                    choices: finite_choices(&schema),
                    suggestion: value.cloned(),
                    schema,
                });
            }
        }
        if self.definition.ask.contains(INFERENCE_PRESET)
            && self
                .selected_route
                .and_then(|route| self.selected_presets.get(&route))
                .is_some_and(|preset| preset.profile().custom_endpoint)
            && self
                .provider_path()
                .is_some_and(|path| !self.accepted.contains(&format!("{path}/endpoint")))
            && !questions.iter().any(|question| {
                self.provider_path()
                    .is_some_and(|path| question.id == format!("{path}/endpoint"))
            })
        {
            let endpoint = format!(
                "{}/endpoint",
                self.provider_path().expect("external provider")
            );
            let schema = sdk_field_schema(&endpoint)
                .expect("external provider endpoint is in the SDK schema")
                .0;
            questions.push(JourneyQuestion {
                id: endpoint.clone(),
                reason: JourneyQuestionReason::ExplicitAsk,
                required: true,
                choices: Vec::new(),
                suggestion: self.values.pointer(&endpoint).cloned(),
                schema,
            });
        }

        let active_harness = harness_path(&self.values);
        let chosen = harness_kind(&self.values);
        let harness_open = chosen.is_none()
            || (self.definition.ask.contains(HARNESS) && !self.accepted.contains(HARNESS));
        let reachable: Vec<&str> = if harness_open {
            capabilities
                .harnesses()
                .iter()
                .map(|harness| harness.as_str())
                .collect()
        } else {
            chosen.into_iter().collect()
        };
        for field in self.definition.ask.union(&self.definition.omit) {
            if let Some((adapter, _)) = adapter_field(field)
                && !reachable.contains(&adapter)
            {
                let reason = if harness_open {
                    "available harness choices".to_owned()
                } else {
                    format!("selected harness '{}'", chosen.expect("selected harness"))
                };
                warnings.push(format!("{field} is not reachable from {reason}"));
            }
        }
        if harness_open {
            if let Some(harness) = chosen
                && adapter_schema(capabilities, harness)?.is_none()
            {
                unverified.push(format!("adapter schema unverified for '{harness}'"));
            }
            if capabilities.harnesses().is_empty() {
                unverified
                    .push("no harness choices are advertised by the current Fabric catalog".into());
            }
            questions.push(JourneyQuestion {
                id: HARNESS.into(),
                reason: if chosen.is_none() {
                    JourneyQuestionReason::Missing
                } else {
                    JourneyQuestionReason::ExplicitAsk
                },
                required: true,
                choices: capabilities
                    .harnesses()
                    .iter()
                    .map(|harness| Value::String(harness.as_str().into()))
                    .collect(),
                suggestion: chosen.map(|kind| Value::String(kind.into())),
                schema: serde_json::json!({"type":"string"}),
            });
        } else if let Some(harness) = chosen {
            let Some(schema) = adapter_schema(capabilities, harness)? else {
                unverified.push(format!("adapter schema unverified for '{harness}'"));
                return Ok(self.resolution(questions, omitted, warnings, unverified, assessment));
            };
            let settings = self
                .values
                .pointer(&format!(
                    "{}/settings",
                    active_harness
                        .as_deref()
                        .expect("chosen harness has an owner")
                ))
                .cloned()
                .unwrap_or_else(|| Value::Object(Map::new()));
            let mut fields = Vec::new();
            crate::settings::collect(schema, schema, &settings, "", false, &mut fields, 0)?;
            for field in fields {
                if field.path.is_empty() {
                    unverified.push(format!("adapter '{harness}' needs a settings object answer; root alternatives are not yet supported"));
                    continue;
                }
                let id = format!("adapter:{harness}:{}", field.path);
                let value = settings.pointer(&field.path);
                if self.definition.omit.contains(&id) || self.omitted.contains(&id) {
                    omitted.push(id);
                    continue;
                }
                let valid =
                    value.is_some_and(|value| schema_accepts(&field.schema, value) == Some(true));
                if value.is_none()
                    || !valid
                    || ((self
                        .definition
                        .ask_scopes
                        .contains(&JourneyScope::ActiveAdapterSettings)
                        || self.definition.ask.contains(&id))
                        && !self.accepted.contains(&id))
                {
                    questions.push(JourneyQuestion {
                        id,
                        reason: if value.is_some() && !valid {
                            JourneyQuestionReason::InvalidSupplied
                        } else if value.is_none() {
                            JourneyQuestionReason::Missing
                        } else {
                            JourneyQuestionReason::ExplicitAsk
                        },
                        required: field.required,
                        choices: field.choices,
                        suggestion: field.suggestion,
                        schema: field.schema,
                    });
                }
            }
            if questions
                .iter()
                .all(|question| !question.id.starts_with("adapter:"))
                && schema_accepts(schema, &settings) != Some(true)
            {
                unverified.push(format!(
                    "adapter '{harness}' settings do not satisfy the complete Fabric schema"
                ));
            }
        }

        if self
            .definition
            .ask_scopes
            .contains(&JourneyScope::DeploymentFields)
            && let Some(document) = assessment.document()
        {
            for field in crate::deployment::deployment_questions_for_document(document)? {
                if self.accepted.contains(&field.path)
                    || questions.iter().any(|question| question.id == field.path)
                {
                    continue;
                }
                questions.push(JourneyQuestion {
                    id: field.path,
                    reason: JourneyQuestionReason::ExplicitAsk,
                    required: true,
                    choices: field.choices,
                    suggestion: field.suggestion,
                    schema: field.schema,
                });
            }
        }
        if self
            .definition
            .ask_scopes
            .contains(&JourneyScope::NativeSettings)
            && let Some(document) = assessment.document()
        {
            for field in native_questions_for_document(document, capabilities, self.selected_route)?
            {
                if field.path == "model:" {
                    unverified.push(
                        "selected native model configuration does not satisfy its Fabric schema"
                            .into(),
                    );
                    continue;
                }
                let value = native_value(&self.values, self.selected_route, &field.path);
                let valid =
                    value.is_some_and(|value| schema_accepts(&field.schema, value) == Some(true));
                let route_key = self.selected_route.map(|route| (route, field.path.clone()));
                let accepted = if field.path.starts_with("model:") {
                    route_key
                        .as_ref()
                        .is_some_and(|key| self.accepted_model_settings.contains(key))
                } else {
                    self.accepted.contains(&field.path)
                };
                let omitted_route = route_key
                    .as_ref()
                    .is_some_and(|key| self.omitted_model_settings.contains(key));
                if self.omitted.contains(&field.path) || omitted_route {
                    omitted.push(field.path);
                } else if !valid || !accepted {
                    questions.push(JourneyQuestion {
                        id: field.path,
                        reason: if value.is_some() && !valid {
                            JourneyQuestionReason::InvalidSupplied
                        } else if value.is_some() {
                            JourneyQuestionReason::ExplicitAsk
                        } else {
                            JourneyQuestionReason::Missing
                        },
                        required: field.required,
                        choices: field.choices,
                        suggestion: field.suggestion,
                        schema: field.schema,
                    });
                }
            }
        }

        Ok(self.resolution(questions, omitted, warnings, unverified, assessment))
    }

    fn resolution(
        &self,
        mut questions: Vec<JourneyQuestion>,
        omitted: Vec<String>,
        warnings: Vec<String>,
        unverified: Vec<String>,
        assessment: PartialAssessment,
    ) -> JourneyResolution {
        if self.definition.ask.contains(INFERENCE_PRESET)
            && self.route_provider().is_some()
            && !self
                .selected_route
                .is_some_and(|route| self.accepted_presets.contains(&route))
        {
            let provider = self.provider_path().expect("external provider");
            let model = self.route_model_path().expect("selected route");
            questions.retain(|question| {
                !question.id.starts_with(&format!("{provider}/")) && question.id != model
            });
        } else if self
            .selected_route
            .and_then(|route| self.selected_presets.get(&route))
            .is_some_and(|preset| preset.profile().custom_endpoint)
            && self
                .provider_path()
                .is_some_and(|path| !self.accepted.contains(&format!("{path}/endpoint")))
            && let Some(model) = self.route_model_path()
        {
            questions.retain(|question| question.id != model);
        }
        questions.sort_by_key(|question| {
            (
                question.id == ROUTE_SELECTION,
                self.definition
                    .ask_order
                    .iter()
                    .position(|id| id == question.id())
                    .unwrap_or(usize::MAX),
            )
        });
        JourneyResolution {
            questions,
            omitted,
            warnings,
            unverified,
            assessment,
            target_required: !self.definition.target_prerequisites.is_empty(),
            target_assessment: (!self.definition.target_prerequisites.is_empty()).then(|| {
                DiscoveryAssessment {
                    status: CompatibilityStatus::Unverified,
                    reasons: vec![
                        "Target compatibility has not been observed for this desired state.".into(),
                    ],
                    pending: Vec::new(),
                }
            }),
        }
    }

    /// Accept or omit an active answer. Previously accepted fields may be
    /// revisited; invalid answers leave the state unchanged.
    pub fn answer(
        &mut self,
        capabilities: &Capabilities,
        id: &str,
        value: Option<Value>,
    ) -> Result<(), Diagnostics> {
        let resolution = self.resolve(capabilities)?;
        let question = if let Some(question) = resolution.question(id) {
            question.clone()
        } else if self.accepted.contains(id) {
            self.revisitable_question(capabilities, id)?
        } else {
            return Err(diagnostic("journey", "This question is not active."));
        };
        if value.is_none() && question.required {
            return Err(diagnostic("journey", "This question is required."));
        }
        if id == HARNESS && question.choices.is_empty() {
            return Err(diagnostic(
                "journey",
                "No harness choices are advertised by the current Fabric catalog.",
            ));
        }
        if let Some(value) = &value
            && !question.choices.is_empty()
            && !question.choices.contains(value)
        {
            return Err(diagnostic(
                "journey",
                "The answer is not an advertised choice.",
            ));
        }
        if let Some(value) = &value
            && schema_accepts(&question.schema, value) != Some(true)
        {
            return Err(diagnostic(
                "journey",
                "The answer does not satisfy its field schema.",
            ));
        }
        if self
            .provider_path()
            .is_some_and(|path| id == format!("{path}/endpoint"))
            && let Some(endpoint) = value.as_ref().and_then(Value::as_str)
        {
            nemoclaw_sdk::config::validate_endpoint(endpoint, false)
                .map_err(|error| diagnostic("journey", &error.to_string()))?;
        }
        let mut candidate = self.clone();
        if id == NAME {
            candidate.put_name(value.expect("required"))?;
            if PartialDocument::from_value(candidate.values.clone())
                .assess()
                .issues()
                .iter()
                .any(|issue| issue.path() == NAME && issue.kind() == PartialIssueKind::Invalid)
            {
                return Err(diagnostic(
                    "journey",
                    "The deployment name does not satisfy the SDK schema.",
                ));
            }
        } else if id == HARNESS {
            candidate.put_harness(value.expect("required"))?;
        } else if id == ROUTE_SELECTION {
            let name = value
                .as_ref()
                .and_then(Value::as_str)
                .expect("advertised route");
            let routes =
                candidate
                    .values
                    .pointer(&routes_path(&candidate.values).ok_or_else(|| {
                        diagnostic("journey", "Inference routes are unavailable.")
                    })?)
                    .and_then(Value::as_array)
                    .ok_or_else(|| diagnostic("journey", "Inference routes are unavailable."))?;
            let index = routes
                .iter()
                .position(|route| route["name"] == name)
                .ok_or_else(|| diagnostic("journey", "The selected route is unavailable."))?;
            if let Some(current) = candidate.selected_route {
                candidate.completed_routes.insert(current);
            }
            candidate.selected_route = Some(index);
        } else if id == INFERENCE_PRESET {
            let preset = ProviderPreset::from_id(
                value
                    .as_ref()
                    .and_then(Value::as_str)
                    .expect("advertised preset"),
            )
            .expect("advertised preset");
            candidate.put_inference_preset(preset)?;
        } else if let Some((adapter, pointer)) = adapter_field(id) {
            if harness_kind(&candidate.values) != Some(adapter) {
                return Err(diagnostic("journey", "This adapter setting is not active."));
            }
            candidate.put_setting(pointer, value.clone())?;
            if value.is_none() {
                candidate.omitted.insert(id.into());
            } else {
                candidate.omitted.remove(id);
            }
        } else if self
            .definition
            .ask_scopes
            .contains(&JourneyScope::NativeSettings)
            && (id.starts_with("workflow:") || id.starts_with("model:"))
        {
            candidate.put_native_field(id, value.clone())?;
            if id.starts_with("model:") {
                let route = candidate.selected_route.ok_or_else(|| {
                    diagnostic("journey", "Select a route before model settings.")
                })?;
                let key = (route, id.to_owned());
                if value.is_none() {
                    candidate.omitted_model_settings.insert(key.clone());
                } else {
                    candidate.omitted_model_settings.remove(&key);
                }
                candidate.accepted_model_settings.insert(key);
            } else if value.is_none() {
                candidate.omitted.insert(id.into());
            } else {
                candidate.omitted.remove(id);
            }
        } else if ((self.definition.ask.contains(id)
            || self
                .definition
                .ask_scopes
                .contains(&JourneyScope::InferenceApi)
                && self
                    .provider_path()
                    .is_some_and(|path| id == format!("{path}/api"))
            || self
                .provider_path()
                .is_some_and(|path| id == format!("{path}/endpoint"))
            || self
                .definition
                .ask_scopes
                .contains(&JourneyScope::RouteModels)
                && self.route_model_path().as_deref() == Some(id))
            && sdk_field_schema(id).is_some())
            || self
                .definition
                .ask_scopes
                .contains(&JourneyScope::DeploymentFields)
                && id.starts_with('/')
        {
            let previous = candidate.values.pointer(id).cloned();
            let provider_for_dependency = candidate.provider_path().and_then(|path| {
                (id == format!("{path}/api") || id == format!("{path}/endpoint"))
                    .then(|| candidate.values.pointer(&format!("{path}/name")))
                    .flatten()
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            });
            candidate.put_sdk_field(id, value.clone())?;
            if previous != candidate.values.pointer(id).cloned()
                && let Some(provider) = provider_for_dependency
            {
                candidate.reopen_models_for_provider(&provider);
            }
            if id == "/spec/gateway/engine" {
                candidate.generated_gateway_engine = false;
            }
            if id == RUNTIME_PROVIDER {
                candidate.sync_gateway_engine_for_runtime()?;
            }
            if self
                .definition
                .ask_scopes
                .contains(&JourneyScope::DeploymentFields)
                && !self.definition.ask.contains(id)
                && self.resolve(capabilities)?.question(id).is_some()
                && PartialDocument::from_value(self.values.clone())
                    .assess()
                    .document()
                    .is_some()
                && PartialDocument::from_value(candidate.values.clone())
                    .assess()
                    .document()
                    .is_none()
            {
                return Err(diagnostic(
                    "journey",
                    "The deployment answer invalidates the SDK document.",
                ));
            }
            if value.is_none() {
                candidate.omitted.insert(id.into());
            } else {
                candidate.omitted.remove(id);
            }
        } else {
            return Err(diagnostic("journey", "This question is not supported."));
        }
        candidate.accepted.insert(id.into());
        if id == INFERENCE_PRESET
            && let Some(route) = candidate.selected_route
        {
            candidate.accepted_presets.insert(route);
        }
        *self = candidate;
        Ok(())
    }

    fn revisitable_question(
        &self,
        capabilities: &Capabilities,
        id: &str,
    ) -> Result<JourneyQuestion, Diagnostics> {
        let mut previous = self.clone();
        previous.accepted.remove(id);
        if id == INFERENCE_PRESET
            && let Some(route) = previous.selected_route
        {
            previous.accepted_presets.remove(&route);
        }
        previous.omitted.remove(id);
        let suggestion = if id == NAME {
            let value = previous.values.pointer(id).cloned();
            previous
                .values
                .pointer_mut("/metadata")
                .and_then(Value::as_object_mut)
                .ok_or_else(|| diagnostic("journey", "Metadata must be an object."))?
                .remove("name");
            value
        } else if id == HARNESS {
            let owner_path = harness_path(&previous.values)
                .ok_or_else(|| diagnostic("journey", "Harness is unavailable."))?;
            let value = previous
                .values
                .pointer(&format!("{owner_path}/kind"))
                .cloned();
            previous
                .values
                .pointer_mut(&owner_path)
                .and_then(Value::as_object_mut)
                .ok_or_else(|| diagnostic("journey", "Harness must be an object."))?
                .remove("kind");
            value
        } else if let Some((adapter, pointer)) = adapter_field(id) {
            if harness_kind(&previous.values) != Some(adapter) {
                return Err(diagnostic(
                    "journey",
                    "This question is no longer applicable.",
                ));
            }
            let value = previous
                .values
                .pointer(&format!(
                    "{}{pointer}",
                    settings_path(&previous.values).ok_or_else(|| diagnostic(
                        "journey",
                        "Harness settings are unavailable."
                    ))?
                ))
                .cloned();
            previous.put_setting(pointer, None)?;
            value
        } else if id == INFERENCE_PRESET {
            self.current_preset()
                .map(|preset| Value::String(preset.id().into()))
        } else if sdk_field_schema(id).is_some()
            || (self
                .definition
                .ask_scopes
                .contains(&JourneyScope::DeploymentFields)
                && self.values.pointer(id).is_some())
        {
            previous.values.pointer(id).cloned()
        } else {
            return Err(diagnostic(
                "journey",
                "This question is no longer applicable.",
            ));
        };
        let mut question = previous
            .resolve(capabilities)?
            .question(id)
            .cloned()
            .ok_or_else(|| diagnostic("journey", "This question is no longer applicable."))?;
        if suggestion.is_some() {
            question.suggestion = suggestion;
        }
        Ok(question)
    }

    fn put_name(&mut self, value: Value) -> Result<(), Diagnostics> {
        let root = self
            .values
            .as_object_mut()
            .ok_or_else(|| diagnostic("journey", "The document root must be an object."))?;
        let metadata = root
            .entry("metadata")
            .or_insert_with(|| Value::Object(Map::new()));
        metadata
            .as_object_mut()
            .ok_or_else(|| diagnostic("journey", "Metadata must be an object."))?
            .insert("name".into(), value);
        Ok(())
    }

    fn put_harness(&mut self, value: Value) -> Result<(), Diagnostics> {
        let next = value
            .as_str()
            .ok_or_else(|| diagnostic("journey", "Harness must be a string."))?
            .to_owned();
        let previous = harness_kind(&self.values).map(str::to_owned);
        if previous.as_deref() != Some(&next)
            && let Some(old) = &previous
            && let Some(settings) =
                settings_path(&self.values).and_then(|path| self.values.pointer(&path))
        {
            self.inactive_settings.insert(old.clone(), settings.clone());
        }
        let owner_path = harness_path(&self.values)
            .ok_or_else(|| diagnostic("journey", "Harness is unavailable."))?;
        let harness = if owner_path == "/spec/sandboxes/0/harness" {
            self.values
                .pointer_mut("/spec/sandboxes/0")
                .and_then(Value::as_object_mut)
                .ok_or_else(|| {
                    diagnostic("journey", "The v1 journey requires one sandbox object.")
                })?
                .entry("harness")
                .or_insert_with(|| Value::Object(Map::new()))
        } else {
            self.values
                .pointer_mut(&owner_path)
                .ok_or_else(|| diagnostic("journey", "Referenced harness is unavailable."))?
        };
        let harness = harness
            .as_object_mut()
            .ok_or_else(|| diagnostic("journey", "Harness must be an object."))?;
        if previous.as_deref() != Some(&next) {
            harness.remove("settings");
            if let Some(settings) = self.inactive_settings.get(&next) {
                harness.insert("settings".into(), settings.clone());
            }
        }
        harness.insert("kind".into(), Value::String(next));
        Ok(())
    }

    fn put_setting(&mut self, pointer: &str, value: Option<Value>) -> Result<(), Diagnostics> {
        let harness = self
            .values
            .pointer_mut(
                &harness_path(&self.values)
                    .ok_or_else(|| diagnostic("journey", "Harness is unavailable."))?,
            )
            .and_then(Value::as_object_mut)
            .ok_or_else(|| diagnostic("journey", "Harness must be an object."))?;
        let settings = harness
            .entry("settings")
            .or_insert_with(|| Value::Object(Map::new()));
        crate::settings::put(settings, pointer, value)
    }

    fn put_native_field(&mut self, id: &str, value: Option<Value>) -> Result<(), Diagnostics> {
        let (root, path) = if let Some(path) = id.strip_prefix("workflow:") {
            (
                harness_path(&self.values)
                    .ok_or_else(|| diagnostic("journey", "Harness is unavailable."))?,
                path,
            )
        } else if let Some(path) = id.strip_prefix("model:") {
            (
                format!(
                    "{}/{}",
                    routes_path(&self.values).ok_or_else(|| diagnostic(
                        "journey",
                        "Inference routes are unavailable."
                    ))?,
                    self.selected_route.ok_or_else(|| diagnostic(
                        "journey",
                        "Select a route before model settings."
                    ))?
                ),
                path,
            )
        } else {
            return Err(diagnostic("journey", "Invalid native question path."));
        };
        let owner = self
            .values
            .pointer_mut(&root)
            .and_then(Value::as_object_mut)
            .ok_or_else(|| diagnostic("journey", "The native setting owner is unavailable."))?;
        let settings = if id.starts_with("workflow:") {
            owner
                .entry("config")
                .or_insert_with(|| Value::Object(Map::new()))
                .as_object_mut()
                .ok_or_else(|| diagnostic("journey", "Harness config must be an object."))?
                .entry("workflow")
                .or_insert_with(|| Value::Object(Map::new()))
        } else {
            owner
                .entry("overrides")
                .or_insert_with(|| Value::Object(Map::new()))
                .as_object_mut()
                .ok_or_else(|| diagnostic("journey", "Route overrides must be an object."))?
                .entry("settings")
                .or_insert_with(|| Value::Object(Map::new()))
        };
        crate::settings::put(settings, path, value)
    }

    fn reopen_models_for_provider(&mut self, provider: &str) {
        let Some(routes_path) = routes_path(&self.values) else {
            return;
        };
        let route_indexes = self
            .values
            .pointer(&routes_path)
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .enumerate()
            .filter_map(|(index, route)| {
                (route.get("providerRef").and_then(Value::as_str) == Some(provider))
                    .then_some(index)
            })
            .collect::<Vec<_>>();
        for index in route_indexes {
            self.accepted
                .remove(&format!("{routes_path}/{index}/overrides/model"));
            self.completed_routes.remove(&index);
            self.accepted_model_settings
                .retain(|(route, _)| *route != index);
            self.omitted_model_settings
                .retain(|(route, _)| *route != index);
        }
    }

    fn put_inference_preset(&mut self, preset: ProviderPreset) -> Result<(), Diagnostics> {
        let (route_index, provider_index) = self.route_provider().ok_or_else(|| {
            diagnostic(
                "journey",
                "Inference presets require a selected route using an external provider.",
            )
        })?;
        let provider_path = format!("/spec/inferenceProviders/{provider_index}");
        let route_path = format!(
            "{}/{route_index}",
            routes_path(&self.values)
                .ok_or_else(|| { diagnostic("journey", "Inference routes are unavailable.") })?
        );
        let api_path = format!("{provider_path}/api");
        let endpoint_path = format!("{provider_path}/endpoint");
        let model_path = format!("{route_path}/overrides/model");
        let previous_name = self
            .values
            .pointer(&format!("{provider_path}/name"))
            .and_then(Value::as_str)
            .ok_or_else(|| diagnostic("journey", "The shared provider needs a name."))?
            .to_owned();
        if self
            .values
            .pointer(&format!("{route_path}/providerRef"))
            .and_then(Value::as_str)
            != Some(&previous_name)
        {
            return Err(diagnostic(
                "journey",
                "The route must reference the shared provider.",
            ));
        }
        let previous = self.current_preset();
        if previous == Some(preset) {
            self.selected_presets.insert(route_index, preset);
            return Ok(());
        }
        let before_values = self.values.clone();
        let profile = preset.profile();
        let old_api = self
            .values
            .pointer(&api_path)
            .cloned()
            .and_then(|value| serde_json::from_value::<InferenceApi>(value).ok());
        let api = old_api
            .filter(|api| preset.apis().contains(api))
            .unwrap_or(preset.apis()[0]);
        let provider = self
            .values
            .pointer_mut(&provider_path)
            .and_then(Value::as_object_mut)
            .ok_or_else(|| diagnostic("journey", "The shared provider must be an object."))?;
        provider.insert("name".into(), Value::String(profile.name.into()));
        provider.insert(
            "provider".into(),
            Value::String(profile.kind.as_str().into()),
        );
        provider.insert(
            "api".into(),
            serde_json::to_value(api).expect("SDK API serializes"),
        );
        provider.insert("endpoint".into(), Value::String(profile.endpoint.into()));
        provider.insert(
            "credential".into(),
            serde_json::json!({"env": profile.credential}),
        );
        let route = self
            .values
            .pointer_mut(&route_path)
            .and_then(Value::as_object_mut)
            .ok_or_else(|| diagnostic("journey", "The route must be an object."))?;
        route.insert("providerRef".into(), Value::String(profile.name.into()));
        let overrides = route
            .get_mut("overrides")
            .and_then(Value::as_object_mut)
            .ok_or_else(|| diagnostic("journey", "The route needs model overrides."))?;
        if let Some(model) = profile.default_model {
            overrides.insert("model".into(), Value::String(model.into()));
        } else {
            overrides.remove("model");
        }
        self.selected_presets.insert(route_index, preset);
        if previous != Some(preset) {
            for field in [
                api_path,
                model_path,
                endpoint_path,
                format!("{provider_path}/credential/env"),
            ] {
                self.accepted.remove(&field);
                self.omitted.remove(&field);
            }
            for field in self.accepted.clone() {
                if field.starts_with('/')
                    && before_values.pointer(&field) != self.values.pointer(&field)
                {
                    self.accepted.remove(&field);
                    self.omitted.remove(&field);
                }
            }
        }
        Ok(())
    }

    fn put_sdk_field(&mut self, pointer: &str, value: Option<Value>) -> Result<(), Diagnostics> {
        let (parent, property) = pointer
            .rsplit_once('/')
            .ok_or_else(|| diagnostic("journey", "Invalid SDK field path."))?;
        let property = property.replace("~1", "/").replace("~0", "~");
        if value.is_none() && self.values.pointer(parent).is_none() {
            return Ok(());
        }
        let mut current = &mut self.values;
        for segment in parent.split('/').skip(1) {
            let key = segment.replace("~1", "/").replace("~0", "~");
            current = match current {
                Value::Array(items) => {
                    let index = key
                        .parse::<usize>()
                        .map_err(|_| diagnostic("journey", "Invalid SDK array index."))?;
                    items
                        .get_mut(index)
                        .ok_or_else(|| diagnostic("journey", "SDK array index is unavailable."))?
                }
                Value::Object(object) => object
                    .entry(key)
                    .or_insert_with(|| Value::Object(Map::new())),
                _ => {
                    return Err(diagnostic(
                        "journey",
                        "The SDK field's parent is not an object.",
                    ));
                }
            };
        }
        let object = current
            .as_object_mut()
            .ok_or_else(|| diagnostic("journey", "The SDK field's parent is not an object."))?;
        if let Some(value) = value {
            object.insert(property, value);
        } else {
            object.remove(&property);
        }
        Ok(())
    }

    fn sync_gateway_engine_for_runtime(&mut self) -> Result<(), Diagnostics> {
        if self
            .values
            .pointer("/spec/gateway/management")
            .and_then(Value::as_str)
            != Some("managed")
        {
            return Ok(());
        }
        if self.values.pointer("/spec/gateway/engine").is_some() && !self.generated_gateway_engine {
            return Ok(());
        }
        let engine = match self
            .values
            .pointer(RUNTIME_PROVIDER)
            .and_then(Value::as_str)
        {
            Some("podman") => "unix:///run/user/1000/podman/podman.sock",
            Some("docker") => "unix:///var/run/docker.sock",
            _ => return Ok(()),
        };
        self.put_sdk_field("/spec/gateway/engine", Some(Value::String(engine.into())))?;
        self.generated_gateway_engine = true;
        self.accepted.remove("/spec/gateway/engine");
        Ok(())
    }
}

fn native_value<'a>(
    values: &'a Value,
    selected_route: Option<usize>,
    id: &str,
) -> Option<&'a Value> {
    if let Some(path) = id.strip_prefix("workflow:") {
        values.pointer(&format!("{}/config/workflow{path}", harness_path(values)?))
    } else if let Some(path) = id.strip_prefix("model:") {
        values.pointer(&format!(
            "{}/{}/overrides/settings{path}",
            routes_path(values)?,
            selected_route?
        ))
    } else {
        None
    }
}

fn routes_path(values: &Value) -> Option<String> {
    let agent = values.pointer("/spec/sandboxes/0/agent")?;
    if agent.get("inference").is_some() {
        return Some(ROUTES.into());
    }
    let reference = agent.get("inferenceRef")?.as_str()?;
    let escaped = reference.replace('~', "~0").replace('/', "~1");
    let path = format!("/spec/inferences/{escaped}/routes");
    values.pointer(&path).is_some().then_some(path)
}

fn harness_path(values: &Value) -> Option<String> {
    let sandbox = values.pointer("/spec/sandboxes/0")?;
    if let Some(reference) = sandbox.get("harnessRef").and_then(Value::as_str) {
        let escaped = reference.replace('~', "~0").replace('/', "~1");
        let path = format!("/spec/harnesses/{escaped}");
        return values.pointer(&path).is_some().then_some(path);
    }
    Some("/spec/sandboxes/0/harness".into())
}

fn harness_kind(values: &Value) -> Option<&str> {
    values
        .pointer(&format!("{}/kind", harness_path(values)?))
        .and_then(Value::as_str)
}

fn settings_path(values: &Value) -> Option<String> {
    harness_path(values).map(|path| format!("{path}/settings"))
}

fn finite_choices(schema: &Value) -> Vec<Value> {
    let mut choices = Vec::new();
    if let Some(values) = schema.get("enum").and_then(Value::as_array) {
        choices.extend(
            values
                .iter()
                .filter(|value| value.as_str() != Some(""))
                .cloned(),
        );
    }
    if let Some(value) = schema.get("const")
        && value.as_str() != Some("")
        && !choices.contains(value)
    {
        choices.push(value.clone());
    }
    for keyword in ["anyOf", "oneOf"] {
        if let Some(branches) = schema.get(keyword).and_then(Value::as_array) {
            for branch in branches {
                for choice in finite_choices(branch) {
                    if !choices.contains(&choice) {
                        choices.push(choice);
                    }
                }
            }
        }
    }
    choices
}

fn native_questions_for_document(
    document: &Document,
    capabilities: &Capabilities,
    selected_route: Option<usize>,
) -> Result<Vec<SettingQuestion>, Diagnostics> {
    let sandbox = &document.spec.sandboxes[0];
    let harness = document
        .sandbox_harness(sandbox)
        .map_err(|error| diagnostic("journey", &error.to_string()))?;
    let harness_id = harness.kind.as_str();
    let workflow = harness
        .config
        .as_ref()
        .and_then(|config| config.get("workflow"))
        .cloned()
        .unwrap_or_else(|| Value::Object(Map::new()));
    let targets = capabilities
        .targets
        .iter()
        .map(|record| &record["descriptor"])
        .filter(|target| target["type"] == "workflow" && target["adapter_id"] == harness_id)
        .collect::<Vec<_>>();
    let workflow_required = capabilities
        .config_schemas
        .get(harness_id)
        .and_then(|schema| schema["required"].as_array())
        .is_some_and(|fields| fields.iter().any(|field| field == "workflow"));
    let mut fields = Vec::new();
    if !targets.is_empty() || workflow_required {
        let mut choices = targets
            .iter()
            .filter_map(|target| target["id"].as_str())
            .map(|id| Value::String(id.into()))
            .collect::<Vec<_>>();
        choices.sort_by(|left, right| left.as_str().cmp(&right.as_str()));
        choices.dedup();
        let mut schema = serde_json::json!({"type":"string","minLength":1});
        if !choices.is_empty() {
            schema["enum"] = Value::Array(choices.clone());
        }
        fields.push(SettingQuestion {
            path: "workflow:/target_id".into(),
            title: "Workflow target".into(),
            description: "Select a workflow target advertised by this Fabric adapter.".into(),
            required: workflow_required,
            schema,
            choices,
            suggestion: workflow.get("target_id").cloned(),
        });
        if let Some(target) = targets
            .iter()
            .find(|target| target["id"] == workflow["target_id"])
            && let Some(schema) = target["spec"].get("settings_schema")
        {
            let settings = workflow
                .get("settings")
                .cloned()
                .unwrap_or_else(|| Value::Object(Map::new()));
            let mut native = Vec::new();
            crate::settings::collect(schema, schema, &settings, "", false, &mut native, 0)?;
            for mut field in native {
                field.path = format!("workflow:/settings{}", field.path);
                fields.push(field);
            }
        }
    }
    if let Some(schema) = capabilities.model_schemas.get(harness_id) {
        let inference = document
            .sandbox_inference(sandbox)
            .map_err(|error| diagnostic("journey", &error.to_string()))?;
        if let Some(route) = selected_route.and_then(|index| inference.routes.get(index)) {
            let config =
                nemoclaw_sdk::fabric_config::for_sandbox(document, sandbox).map_err(|_| {
                    diagnostic(
                        "journey",
                        "Cannot project the selected model configuration.",
                    )
                })?;
            let mut model = Vec::new();
            crate::settings::collect(
                schema,
                schema,
                &config["models"][&route.name],
                "",
                false,
                &mut model,
                0,
            )?;
            for mut field in model {
                if field.path.is_empty() {
                    field.path = "model:".into();
                    fields.push(field);
                    continue;
                }
                if field.path == "/settings" || field.path.starts_with("/settings/") {
                    field.path = format!("model:{}", &field.path["/settings".len()..]);
                    fields.push(field);
                }
            }
        }
    }
    Ok(fields)
}
