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

/// The operation represented by a question. IDs remain stable UI keys; this
/// target carries the meaning needed to apply and record an answer.
#[derive(Clone, Debug, PartialEq, Eq)]
enum QuestionTarget {
    DeploymentName,
    Harness,
    SdkField { path: String, role: SdkFieldRole },
    StructuralForm { path: String },
    RouteSelection { routes: Vec<(String, usize)> },
    InferencePreset { route: usize },
    AdapterSetting { adapter: String, pointer: String },
    WorkflowSetting { pointer: String },
    ModelSetting { route: usize, pointer: String },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SdkFieldRole {
    Plain,
    ProviderApi,
    ProviderEndpoint,
    RuntimeProvider,
    GatewayManagement,
    GatewayEngine,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum NativeSettingOwner {
    Workflow,
    Model(usize),
}

impl QuestionTarget {
    fn sdk(path: impl Into<String>) -> Self {
        let path = path.into();
        if path == NAME {
            return Self::DeploymentName;
        }
        if path == HARNESS {
            return Self::Harness;
        }
        let segments = path.split('/').collect::<Vec<_>>();
        let provider_field = segments.len() == 5
            && segments[1] == "spec"
            && segments[2] == "inferenceProviders"
            && segments[3].parse::<usize>().is_ok();
        let role = if path == RUNTIME_PROVIDER {
            SdkFieldRole::RuntimeProvider
        } else if path == "/spec/gateway/management" {
            SdkFieldRole::GatewayManagement
        } else if path == "/spec/gateway/engine" {
            SdkFieldRole::GatewayEngine
        } else if provider_field && segments[4] == "api" {
            SdkFieldRole::ProviderApi
        } else if provider_field && segments[4] == "endpoint" {
            SdkFieldRole::ProviderEndpoint
        } else {
            SdkFieldRole::Plain
        };
        Self::SdkField { path, role }
    }
}

/// One currently applicable decision in the bounded journey surface.
#[derive(Clone, Debug, PartialEq)]
pub struct JourneyQuestion {
    id: String,
    target: QuestionTarget,
    reason: JourneyQuestionReason,
    reopened_because: Option<String>,
    required: bool,
    choices: Vec<Value>,
    kind: JourneyQuestionKind,
    suggestion: Option<Value>,
    schema: Value,
    title: Option<String>,
    description: Option<String>,
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
    /// Display title from the SDK or Fabric schema, when one is advertised.
    pub fn title(&self) -> Option<&str> {
        self.title.as_deref()
    }
    /// Why the field exists, from the SDK or Fabric schema, when advertised.
    pub fn description(&self) -> Option<&str> {
        self.description
            .as_deref()
            .or_else(|| self.schema["description"].as_str())
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

/// How a question has been handled in this run. Supplied values may still be
/// unreviewed when the definition deliberately asks for confirmation.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DecisionStatus {
    Unreviewed,
    Accepted,
    Omitted,
    Reopened { because: String },
}

/// One mutable authoring run. Values, decisions, and navigation have distinct
/// owners; resolution reads them without changing the run.
#[derive(Clone, Debug)]
pub struct JourneyState {
    definition: JourneyDefinition,
    authored: AuthoredValues,
    decisions: DecisionRecord,
    position: JourneyPosition,
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
            authored: AuthoredValues::new(values),
            decisions: DecisionRecord::default(),
            position: JourneyPosition::new(selected_route),
        }
    }

    pub fn values(&self) -> &Value {
        &self.authored.values
    }

    /// Decision status for the currently selected route when the ID is route-scoped.
    pub fn decision_status(&self, id: &str) -> DecisionStatus {
        self.decisions.status(id, self.position.selected_route)
    }

    /// Recompute the applicable questions from this run without changing it.
    pub fn resolve(&self, capabilities: &Capabilities) -> Result<JourneyResolution, Diagnostics> {
        resolver::QuestionResolver::new(self, capabilities).resolve()
    }

    pub fn current_route(&self) -> Option<&str> {
        let index = self.position.selected_route?;
        self.authored
            .values
            .pointer(&format!(
                "{}/{index}/name",
                routes_path(&self.authored.values)?
            ))
            .and_then(Value::as_str)
    }
}

mod answer;
mod authored_values;
mod decision_record;
mod evidence;
mod journey_position;
mod mutation;
mod paths;
mod resolver;
mod selection;

use authored_values::AuthoredValues;
use decision_record::DecisionRecord;
use journey_position::JourneyPosition;
use paths::{
    escape_pointer, harness_kind, harness_path, native_value, routes_path, scalar_question,
    settings_path,
};
