// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Mutable journey answers and a single resolution API over sparse authored values.
//! Question collectors, answer updates, and evidence checks live in private modules.

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
        adapter_schema, native_field,
    },
    sdk_schema::{
        finite_choices, sdk_discriminator, sdk_exclusive_required_fields, sdk_field_possible,
        sdk_field_schema, sdk_field_schema_for, sdk_selected_branch,
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

/// The domain decision a frontend is presenting.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum JourneyQuestionKind {
    Field,
    InferenceModel,
    StructuralForm,
}

/// One currently applicable decision in the bounded journey surface.
#[derive(Clone, Debug, PartialEq)]
pub struct JourneyQuestion {
    id: String,
    reason: JourneyQuestionReason,
    reopened_because: Option<String>,
    required: bool,
    choices: Vec<Value>,
    kind: JourneyQuestionKind,
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
    /// The earlier answer that caused an accepted decision to reopen.
    pub fn reopened_because(&self) -> Option<&str> {
        self.reopened_because.as_deref()
    }
    pub fn required(&self) -> bool {
        self.required
    }
    pub fn choices(&self) -> &[Value] {
        &self.choices
    }
    pub fn kind(&self) -> JourneyQuestionKind {
        self.kind
    }
    /// Suggested model choices do not restrict an otherwise schema-valid answer.
    pub fn allows_custom_answer(&self) -> bool {
        self.kind == JourneyQuestionKind::InferenceModel
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

    /// A completed document without a known target conflict, and with any
    /// configured target prerequisites met.
    pub fn ready_document(&self) -> Option<&Document> {
        let document = self.materialized_document()?;
        if self.target_assessment.as_ref().is_some_and(|assessment| {
            assessment.status == CompatibilityStatus::Conflict
                || (self.target_required && assessment.status != CompatibilityStatus::Compatible)
        }) || (self.target_required && self.target_assessment.is_none())
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
    reopened_by: BTreeMap<String, String>,
    selected_forms: BTreeMap<String, String>,
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
            reopened_by: BTreeMap::new(),
            selected_forms: BTreeMap::new(),
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
}

mod adapter_questions;
mod answer;
mod deployment_questions;
mod evidence;
mod inference_questions;
mod mutation;
mod native_questions;
mod paths;
mod resolve;
mod schema_questions;
mod sdk_questions;
mod selection;

use paths::{
    escape_pointer, harness_kind, harness_path, native_value, routes_path, scalar_question,
    settings_path,
};
use resolve::ResolutionWork;
use schema_questions::collect_required_leaf_questions;
