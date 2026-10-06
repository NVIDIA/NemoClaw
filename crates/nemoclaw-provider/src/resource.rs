// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use crate::{Backend, Definition, Mutation, Row, State, plan_update};
use async_trait::async_trait;
use nemoclaw_sdk::backend::{OpenShellLifecycle, openshell_lifecycle};
use nemoclaw_sdk::{Binding, Bound, Observation, ObservationError, refresh};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use tf_provider::schema::{Attribute, AttributeConstraint, AttributeType, Block, Schema};
use tf_provider::value::{Value, ValueEmpty};
use tf_provider::{AttributePath, Diagnostics, Resource};

pub(crate) fn observation_message(error: ObservationError, sandbox: Option<&str>) -> String {
    if matches!(
        error,
        ObservationError::SandboxConfigurationRejected { .. }
            | ObservationError::SandboxStartup { .. }
            | ObservationError::FabricConfiguration { .. }
    ) {
        format!(
            "sandbox/{}: {error}",
            sandbox.unwrap_or("unknown").escape_default()
        )
    } else {
        error.to_string()
    }
}

fn attribute<'a>(state: &'a State, name: &str) -> Option<&'a str> {
    match state.get(name) {
        Some(Value::Value(value)) => Some(value),
        _ => None,
    }
}

pub struct ResourceAdapter {
    definition: Definition,
    backend: Arc<dyn Backend>,
    pub destroying: Arc<AtomicBool>,
}
impl ResourceAdapter {
    pub fn new(definition: Definition, backend: Arc<dyn Backend>) -> Self {
        Self {
            definition,
            backend,
            destroying: Arc::new(AtomicBool::new(false)),
        }
    }
    fn message(&self, error: String, name: Option<&str>, upstream: Option<&str>) -> String {
        if self.definition.kind != "ollama_external_model" {
            return error;
        }
        let name = name.unwrap_or("unknown");
        let source = name.split_once("-ollama-proxy-").map_or_else(
            || format!("external Ollama model/{}", name.escape_default()),
            |(_, service)| format!("services.{}.upstream", service.escape_default()),
        );
        // This package accepts only local, unauthenticated HTTP upstreams.
        // Invalid state must not echo userinfo, query strings, or fragments.
        let endpoint = upstream
            .and_then(|endpoint| url::Url::parse(endpoint).ok())
            .filter(|url| {
                url.scheme() == "http"
                    && url.path() == "/v1"
                    && url.port().is_some()
                    && url.username().is_empty()
                    && url.password().is_none()
                    && url.query().is_none()
                    && url.fragment().is_none()
                    && match url.host() {
                        Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
                        Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
                        _ => false,
                    }
            });
        let endpoint = endpoint.map(|url| format!(" ({url})")).unwrap_or_default();
        format!("{source}{endpoint}: {error}")
    }

    fn protected_binding(&self) -> bool {
        match openshell_lifecycle(self.definition.kind) {
            Some(OpenShellLifecycle::Retained) => true,
            Some(OpenShellLifecycle::Stateful) => !self.destroying.load(Ordering::Acquire),
            _ => false,
        }
    }
    fn optional(&self, field: &str) -> bool {
        (self.definition.kind == "provider_profile"
            && matches!(field, "endpoint" | "authenticated"))
            || matches!(
                field,
                "image_pull_policy"
                    | "credential_source"
                    | "profile_name"
                    | "credential_env"
                    | "agent_runtime"
                    | "provider_type"
                    | "policy_json"
                    | "provider_names_json"
            )
    }
    fn observed_running(&self) -> bool {
        self.definition.observed_running
    }
    fn observed_data_path(&self) -> bool {
        self.definition.kind == "gateway_storage"
    }
    fn observed_complete(&self) -> bool {
        self.definition.kind == "container_inputs"
    }
    fn validate_config(&self, diags: &mut Diagnostics, config: &State) -> Option<()> {
        if self.definition.fields.contains(&"spec") {
            match config.get("spec") {
                Some(Value::Unknown) => {}
                Some(Value::Value(encoded)) => {
                    if let Err(error) = nemoclaw_sdk::services::validate_resource_spec(
                        self.definition.kind,
                        encoded,
                    ) {
                        diags.error(
                            "Invalid resource specification",
                            error.to_string(),
                            AttributePath::new("spec"),
                        );
                        return None;
                    }
                }
                _ => {
                    diags.error_short(
                        "Resource specification is required",
                        AttributePath::new("spec"),
                    );
                    return None;
                }
            }
        }
        Some(())
    }

    async fn check_plan(
        &self,
        diags: &mut Diagnostics,
        proposed: &State,
        config: &State,
        prior: Option<&State>,
    ) -> Option<()> {
        self.validate_config(diags, config)?;
        // Unknown inputs may depend on upstream resources. OpenTofu will call
        // planning again with resolved configuration before applying changes.
        if self
            .definition
            .fields
            .iter()
            .any(|field| matches!(config.get(*field), Some(Value::Unknown)))
        {
            return Some(());
        }
        let result = async {
            let desired = self.row(proposed, true)?;
            let prior = prior.map(|state| self.row(state, false)).transpose()?;
            self.backend
                .plan(self.definition.kind, &desired, prior.as_ref())
                .await
        }
        .await;
        match result {
            Ok(()) => Some(()),
            Err(error) => {
                let message = self.message(
                    error.to_string(),
                    attribute(proposed, "name"),
                    attribute(proposed, "upstream"),
                );
                if self.definition.fields.contains(&"spec") {
                    diags.error(
                        "Resource planning failed",
                        message,
                        AttributePath::new("spec"),
                    );
                } else {
                    diags.root_error("Resource planning failed", message);
                }
                None
            }
        }
    }
    fn row(&self, state: &State, creating: bool) -> Result<Row, ObservationError> {
        state
            .iter()
            .map(|(k, v)| match v {
                Value::Value(v) => Ok((k.clone(), v.clone())),
                Value::Unknown | Value::Null
                    if (k == "running" && self.observed_running())
                        || (k == "complete" && self.observed_complete())
                        || (k == "data_path" && self.observed_data_path()) =>
                {
                    Ok((k.clone(), String::new()))
                }
                Value::Null if self.optional(k) => Ok((k.clone(), String::new())),
                Value::Unknown | Value::Null
                    if (creating || self.observed_complete()) && k == "id" =>
                {
                    Ok((k.clone(), String::new()))
                }
                _ => Err(ObservationError::Incomplete),
            })
            .collect()
    }
    fn checked(&self, prior: &Row, observed: Row) -> Result<Row, ObservationError> {
        for field in self
            .definition
            .fields
            .iter()
            .copied()
            .chain(["id"])
            .chain(self.observed_data_path().then_some("data_path"))
            .chain(self.observed_complete().then_some("complete"))
        {
            if observed
                .get(field)
                .is_none_or(|value| value.is_empty() && !self.optional(field))
            {
                return Err(ObservationError::Incomplete);
            }
        }
        for field in ["id", "name", "workspace", "spec"] {
            if let Some(expected) = prior.get(field)
                && !expected.is_empty()
                && observed.get(field) != Some(expected)
            {
                return Err(ObservationError::BindingMismatch);
            }
        }
        if prior.contains_key("owner") {
            let bound = |row: &Row| -> Result<Binding, ObservationError> {
                Binding::new(
                    row.get("owner").ok_or(ObservationError::Incomplete)?,
                    row.get("generation").ok_or(ObservationError::Incomplete)?,
                    row.get("id").ok_or(ObservationError::Incomplete)?,
                )
            };
            // For a newly created resource, ownership and generation are known
            // before its physical ID. Validate with that established ID.
            let mut expected = prior.clone();
            if expected.get("id").is_none_or(String::is_empty) {
                expected.insert("id".into(), observed["id"].clone());
            }
            refresh(
                &Bound {
                    binding: bound(&expected)?,
                    configuration: (),
                },
                Ok(Observation::Present(Bound {
                    binding: bound(&observed)?,
                    configuration: (),
                })),
            )?;
        }
        Ok(observed)
    }
    fn finish(
        &self,
        diags: &mut Diagnostics,
        mutation: Mutation,
        desired: &Row,
        prior: Option<State>,
    ) -> Option<State> {
        let (state, error) = mutation.into_parts();
        if let Some(error) = error {
            diags.root_error(
                "Apply incomplete",
                self.message(
                    observation_message(error, desired.get("name").map(String::as_str)),
                    desired.get("name").map(String::as_str),
                    desired.get("upstream").map(String::as_str),
                ),
            );
        }
        match state {
            Some(row) => match self.checked(desired, row) {
                Ok(row) => Some(row.into_iter().map(|(k, v)| (k, Value::Value(v))).collect()),
                Err(error) => {
                    diags.root_error("Apply incomplete", error.to_string());
                    prior
                }
            },
            None => prior,
        }
    }
}

#[async_trait]
impl Resource for ResourceAdapter {
    type State<'a> = State;
    type PrivateState<'a> = ValueEmpty;
    type ProviderMetaState<'a> = ValueEmpty;

    async fn validate<'a>(&self, diags: &mut Diagnostics, config: State) -> Option<()> {
        self.validate_config(diags, &config)
    }

    fn schema(&self, _: &mut Diagnostics) -> Option<Schema> {
        let attributes = self
            .definition
            .fields
            .iter()
            .copied()
            .chain(["id"])
            .chain(self.observed_data_path().then_some("data_path"))
            .chain(self.observed_complete().then_some("complete"))
            .map(|name| {
                (
                    name.into(),
                    Attribute {
                        attr_type: AttributeType::String,
                        constraint: if name == "id"
                            || (name == "complete" && self.observed_complete())
                            || (name == "running" && self.observed_running())
                            || (name == "data_path" && self.observed_data_path())
                        {
                            AttributeConstraint::Computed
                        } else if self.optional(name) {
                            AttributeConstraint::OptionalComputed
                        } else {
                            AttributeConstraint::Required
                        },
                        ..Default::default()
                    },
                )
            })
            .collect();
        Some(Schema {
            version: 0,
            block: Block {
                attributes,
                ..Default::default()
            },
        })
    }
    async fn read<'a>(
        &self,
        diags: &mut Diagnostics,
        state: State,
        private: ValueEmpty,
        _: ValueEmpty,
    ) -> Option<(State, ValueEmpty)> {
        let observation = match self.row(&state, false) {
            Ok(prior) => match self
                .backend
                .read(
                    self.definition.kind,
                    &prior,
                    self.destroying.load(Ordering::Acquire),
                )
                .await
            {
                Ok(None) if self.protected_binding() => Err(ObservationError::BindingMismatch),
                Ok(Some(row)) => self.checked(&prior, row).map(Some),
                other => other,
            },
            Err(error) => Err(error),
        };
        match observation {
            Ok(None) => None,
            Ok(Some(row)) => Some((
                row.into_iter().map(|(k, v)| (k, Value::Value(v))).collect(),
                private,
            )),
            Err(error) => {
                let name = attribute(&state, "name");
                diags.root_error(
                    "Resource observation",
                    self.message(
                        observation_message(error, name),
                        name,
                        attribute(&state, "upstream"),
                    ),
                );
                Some((state, private))
            }
        }
    }
    async fn plan_create<'a>(
        &self,
        diags: &mut Diagnostics,
        mut proposed: State,
        config: State,
        _: ValueEmpty,
    ) -> Option<(State, ValueEmpty)> {
        if self.destroying.load(Ordering::Acquire) {
            diags.root_error_short("Creation forbidden during destroy");
            return None;
        }
        proposed.insert("id".into(), Value::Unknown);
        if self.observed_complete() {
            proposed.insert("complete".into(), Value::Unknown);
        }
        if self.observed_data_path() {
            proposed.insert("data_path".into(), Value::Unknown);
        }
        if self.observed_running() {
            proposed.insert("running".into(), Value::Unknown);
        }
        for field in &self.definition.fields {
            // Core may propose unknown for an omitted OptionalComputed value.
            // Choose its default only when the configuration itself is null.
            if self.optional(field) && matches!(config.get(*field), Some(Value::Null) | None) {
                proposed.insert((*field).into(), Value::Value(String::new()));
            }
        }
        self.check_plan(diags, &proposed, &config, None).await?;
        Some((proposed, Value::Null))
    }
    async fn plan_update<'a>(
        &self,
        diags: &mut Diagnostics,
        prior: State,
        mut proposed: State,
        config: State,
        private: ValueEmpty,
        _: ValueEmpty,
    ) -> Option<(State, ValueEmpty, Vec<AttributePath>)> {
        // OptionalComputed normally carries the prior value forward. Omission
        // here means the runtime's default policy, not the previous selection.
        for field in [
            "image_pull_policy",
            "credential_env",
            "credential_source",
            "provider_type",
        ] {
            if self.definition.fields.contains(&field)
                && matches!(config.get(field), None | Some(Value::Null))
            {
                proposed.insert(field.into(), Value::Value(String::new()));
            }
        }
        self.check_plan(diags, &proposed, &config, Some(&prior))
            .await?;
        let (state, replacements) = plan_update(&self.definition, &prior, proposed);
        if matches!(
            openshell_lifecycle(self.definition.kind),
            Some(OpenShellLifecycle::Retained | OpenShellLifecycle::Stateful)
        ) && !replacements.is_empty()
        {
            let name = match prior.get("name") {
                Some(Value::Value(name)) => name.as_str(),
                _ => "unknown",
            };
            diags.root_error("Resource replacement refused", format!(
                "{}/{}: changed fields: {}. Replacement would discard retained identity or sandbox files; use explicit teardown and a new resource identity",
                self.definition.kind, name.escape_default(), replacements.join(", "),
            ));
            return None;
        }
        Some((
            state,
            private,
            replacements.into_iter().map(AttributePath::new).collect(),
        ))
    }
    async fn plan_destroy<'a>(
        &self,
        diags: &mut Diagnostics,
        _: State,
        private: ValueEmpty,
        _: ValueEmpty,
    ) -> Option<ValueEmpty> {
        if self.protected_binding() {
            diags.root_error_short(
                "Sandbox deletion requires destroy = true because files and history are removed; workspaces must be retained",
            );
            return None;
        }
        Some(private)
    }
    async fn create<'a>(
        &self,
        diags: &mut Diagnostics,
        planned: State,
        _: State,
        private: ValueEmpty,
        _: ValueEmpty,
    ) -> Option<(State, ValueEmpty)> {
        if self.destroying.load(Ordering::Acquire) {
            diags.root_error_short("Creation forbidden during destroy");
            return None;
        }
        let row = match self.row(&planned, true) {
            Ok(row) => row,
            Err(error) => {
                diags.root_error_short(error.to_string());
                return None;
            }
        };
        let mutation = crate::download::with_provider_download_progress(
            download_resource(self.definition.kind, &row),
            self.backend.ensure(self.definition.kind, &row),
        )
        .await;
        self.finish(diags, mutation, &row, None)
            .map(|state| (state, private))
    }
    async fn update<'a>(
        &self,
        diags: &mut Diagnostics,
        prior: State,
        planned: State,
        _: State,
        private: ValueEmpty,
        _: ValueEmpty,
    ) -> Option<(State, ValueEmpty)> {
        if self.destroying.load(Ordering::Acquire) {
            diags.root_error_short("Update forbidden during destroy");
            return Some((prior, private));
        }
        let mut row = match self.row(&planned, false) {
            Ok(row) => row,
            Err(error) => {
                diags.root_error_short(error.to_string());
                return Some((prior, private));
            }
        };
        if self.observed_complete()
            && row.get("id").is_none_or(String::is_empty)
            && let Some(Value::Value(id)) = prior.get("id")
        {
            // The helper's ID may change only while repairing recorded partial
            // setup. Carry the old binding into the backend's ownership check;
            // it is not a public state attribute.
            row.insert("prior_id".into(), id.clone());
        }
        let mutation = crate::download::with_provider_download_progress(
            download_resource(self.definition.kind, &row),
            self.backend.ensure(self.definition.kind, &row),
        )
        .await;
        self.finish(diags, mutation, &row, Some(prior))
            .map(|state| (state, private))
    }
    async fn destroy<'a>(
        &self,
        diags: &mut Diagnostics,
        state: State,
        _: ValueEmpty,
        _: ValueEmpty,
    ) -> Option<()> {
        let row = match self.row(&state, false) {
            Ok(row) => row,
            Err(error) => {
                diags.root_error_short(error.to_string());
                return None;
            }
        };
        match self
            .backend
            .remove(
                self.definition.kind,
                &row,
                self.destroying.load(Ordering::Acquire),
            )
            .await
        {
            Ok(()) => Some(()),
            Err(error) => {
                diags.root_error("Destroy incomplete", error.to_string());
                None
            }
        }
    }
}

fn download_resource(kind: &str, row: &Row) -> String {
    #[derive(serde::Deserialize)]
    struct NamedSpec {
        name: String,
    }
    let name = row
        .get("name")
        .or_else(|| row.get("model"))
        .cloned()
        .or_else(|| {
            serde_json::from_str::<NamedSpec>(row.get("spec")?)
                .ok()
                .map(|spec| spec.name)
        })
        .unwrap_or_else(|| "resource".into());
    format!("{kind}.{name}")
}

#[cfg(test)]
mod tests {
    use super::*;
    struct RepairedInputs;
    #[async_trait]
    impl Backend for RepairedInputs {
        async fn read(&self, _: &str, _: &Row, _: bool) -> Result<Option<Row>, ObservationError> {
            unreachable!("update must not refresh through this fixture")
        }
        async fn ensure(&self, kind: &str, desired: &Row) -> Mutation {
            assert_eq!(kind, "container_inputs");
            assert_eq!(desired["prior_id"], "old-helper");
            assert!(desired["id"].is_empty());
            let mut observed = desired.clone();
            observed.remove("prior_id");
            observed.insert("id".into(), "new-helper".into());
            observed.insert("complete".into(), "true".into());
            Mutation::complete(observed)
        }
        async fn remove(&self, _: &str, _: &Row, _: bool) -> Result<(), ObservationError> {
            unreachable!("update must not destroy through this fixture")
        }
    }
    #[tokio::test]
    async fn partial_input_update_preserves_old_binding_and_accepts_only_the_new_computed_id() {
        let definition = Definition::new("container_inputs", &["spec", "sandbox_id"], &[]);
        let prior: State = [
            ("spec".into(), Value::Value("{}".into())),
            ("sandbox_id".into(), Value::Value("none".into())),
            ("id".into(), Value::Value("old-helper".into())),
            ("complete".into(), Value::Value("false".into())),
        ]
        .into();
        let (planned, _) = plan_update(&definition, &prior, prior.clone());
        let adapter = ResourceAdapter::new(definition, Arc::new(RepairedInputs));
        let mut diags = Diagnostics::default();
        let (state, _) = adapter
            .update(
                &mut diags,
                prior,
                planned,
                State::default(),
                ValueEmpty::default(),
                ValueEmpty::default(),
            )
            .await
            .unwrap();
        assert_eq!(state["id"], Value::Value("new-helper".into()));
        assert_eq!(state["complete"], Value::Value("true".into()));
        assert!(!state.contains_key("prior_id"));
        assert!(diags.errors.is_empty(), "{diags:?}");
    }
    #[test]
    fn download_labels_distinguish_named_specs_and_models() {
        for name in ["first", "second"] {
            let row = Row::from([("spec".into(), serde_json::json!({"name":name}).to_string())]);
            assert_eq!(
                download_resource("inference_service", &row),
                format!("inference_service.{name}")
            );
        }
        let row = Row::from([("model".into(), "llama3:latest".into())]);
        assert_eq!(
            download_resource("model_snapshot", &row),
            "model_snapshot.llama3:latest"
        );
    }
}
