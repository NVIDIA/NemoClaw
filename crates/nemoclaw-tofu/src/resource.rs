// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use crate::{Backend, Definition, Mutation, Protection, Row, State, plan_update};
use async_trait::async_trait;
use nemoclaw_backend::{Binding, Bound, Observation, ObservationError, refresh};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use tf_provider::schema::{Attribute, AttributeConstraint, AttributeType, Block, Schema};
use tf_provider::value::{Value, ValueEmpty};
use tf_provider::{AttributePath, Diagnostics, Resource};

/// A diagnostic for an observation failure, with sandbox guidance when one is named.
pub fn observation_message(error: ObservationError, sandbox: Option<&str>) -> String {
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

/// The sandbox a resource's diagnostics name: the one it belongs to, else itself.
fn sandbox_name(row: &Row) -> Option<&str> {
    row.get("sandbox")
        .or_else(|| row.get("name"))
        .map(String::as_str)
}

fn known(state: &State) -> Row {
    state
        .iter()
        .filter_map(|(name, value)| match value {
            Value::Value(value) => Some((name.clone(), value.clone())),
            _ => None,
        })
        .collect()
}

pub struct ResourceAdapter {
    definition: Definition,
    backend: Arc<dyn Backend>,
    pub destroying: Arc<AtomicBool>,
}
impl ResourceAdapter {
    pub fn definition(&self) -> &Definition {
        &self.definition
    }
    pub fn new(definition: Definition, backend: Arc<dyn Backend>) -> Self {
        Self {
            definition,
            backend,
            destroying: Arc::new(AtomicBool::new(false)),
        }
    }
    fn message(&self, error: String, attributes: &Row) -> String {
        match self.definition.describe {
            Some(describe) => describe(error, attributes),
            None => error,
        }
    }

    fn protected_binding(&self) -> bool {
        match self.definition.protection {
            Protection::Always => true,
            Protection::UnlessDestroying => !self.destroying.load(Ordering::Acquire),
            Protection::None => false,
        }
    }
    fn optional(&self, field: &str) -> bool {
        self.definition.is_optional(field)
    }
    fn validate_config(&self, diags: &mut Diagnostics, config: &State) -> Option<()> {
        if self.definition.fields.contains(&"spec") {
            match config.get("spec") {
                Some(Value::Unknown) => {}
                Some(Value::Value(encoded)) => {
                    if let Some(validate) = self.definition.validate_spec
                        && let Err(error) = validate(self.definition.kind, encoded)
                    {
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
        if let Some(check) = self.definition.validate_attribute {
            let mut valid = true;
            for field in &self.definition.fields {
                if let Some(Value::Value(value)) = config.get(*field)
                    && let Err(requirement) = check(field, value)
                {
                    diags.error(
                        format!("Invalid {field}"),
                        format!("{field} {requirement}"),
                        AttributePath::new(*field),
                    );
                    valid = false;
                }
            }
            if !valid {
                return None;
            }
        }
        if let Some(check) = self.definition.validate_inputs {
            let known: Row = self
                .definition
                .fields
                .iter()
                .filter_map(|field| match config.get(*field) {
                    Some(Value::Value(value)) => Some(((*field).to_owned(), value.clone())),
                    _ => None,
                })
                .collect();
            let unknown: Vec<&str> = self
                .definition
                .fields
                .iter()
                .copied()
                .filter(|field| matches!(config.get(*field), Some(Value::Unknown)))
                .collect();
            if let Err(requirement) = check(&known, &unknown) {
                diags.root_error("Invalid configuration", requirement.into_owned());
                return None;
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
        // Omitted identity is generated during apply, so the backend cannot
        // observe the binding this plan would create.
        if self
            .definition
            .generated
            .iter()
            .any(|(name, _)| matches!(proposed.get(*name), Some(Value::Unknown)))
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
                let message = self.message(error.to_string(), &known(proposed));
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
    /// The backend row for `state`. Derived attributes stay out: backends
    /// never observe them, and they are recomputed from every observation.
    fn row(&self, state: &State, creating: bool) -> Result<Row, ObservationError> {
        state
            .iter()
            .filter(|(k, _)| !self.definition.derived.iter().any(|(name, _)| name == k))
            .map(|(k, v)| match v {
                Value::Value(v) => Ok((k.clone(), v.clone())),
                Value::Unknown | Value::Null if self.definition.is_computed(k) => {
                    Ok((k.clone(), String::new()))
                }
                Value::Null if self.optional(k) => Ok((k.clone(), String::new())),
                Value::Unknown | Value::Null if creating && k == "id" => {
                    Ok((k.clone(), String::new()))
                }
                _ => Err(ObservationError::Incomplete),
            })
            .collect()
    }
    /// Set derived attributes from the inputs in `state`. While planning, one
    /// whose inputs are unknown is unknown; after an observation, absent.
    fn derive(&self, state: &mut State, planning: bool) {
        if self.definition.derived.is_empty() {
            return;
        }
        let row = known(state);
        let unknown: Vec<&str> = self
            .definition
            .fields
            .iter()
            .copied()
            .filter(|field| matches!(state.get(*field), Some(Value::Unknown)))
            .collect();
        for (name, derive) in &self.definition.derived {
            let value = match derive(&row, &unknown) {
                Some(value) => Value::Value(value),
                None if planning => Value::Unknown,
                None => Value::Null,
            };
            state.insert((*name).into(), value);
        }
    }
    /// Copy fields the backend uses without observing from `source`.
    fn carry(&self, source: &Row, mut observed: Row) -> Row {
        for field in &self.definition.carried {
            if let Some(value) = source.get(*field) {
                observed.insert((*field).into(), value.clone());
            }
        }
        observed
    }
    fn checked(&self, prior: &Row, observed: Row) -> Result<Row, ObservationError> {
        let observed = self.carry(prior, observed);
        for field in &self.definition.bound_fields {
            if prior.get(*field).map(String::as_str).unwrap_or("")
                != observed.get(*field).map(String::as_str).unwrap_or("")
            {
                return Err(ObservationError::BindingMismatch);
            }
        }
        for field in self.definition.attributes() {
            // Backends do not observe derived attributes; inputs determine them.
            if self
                .definition
                .derived
                .iter()
                .any(|(name, _)| *name == field)
            {
                continue;
            }
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
                self.message(observation_message(error, sandbox_name(desired)), desired),
            );
        }
        match state {
            Some(row) => match self.checked(desired, row) {
                Ok(row) => {
                    let mut state = row.into_iter().map(|(k, v)| (k, Value::Value(v))).collect();
                    self.derive(&mut state, false);
                    Some(state)
                }
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
            .attributes()
            .map(|name| {
                (
                    name.into(),
                    Attribute {
                        attr_type: AttributeType::String,
                        constraint: if name == "id" || self.definition.is_computed(name) {
                            AttributeConstraint::Computed
                        } else if self.optional(name) || self.definition.is_generated(name) {
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
            version: self.definition.schema_version,
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
            Ok(Some(row)) => {
                let mut state = row.into_iter().map(|(k, v)| (k, Value::Value(v))).collect();
                self.derive(&mut state, false);
                Some((state, private))
            }
            Err(error) => {
                let known = known(&state);
                diags.root_error(
                    "Resource observation",
                    self.message(observation_message(error, sandbox_name(&known)), &known),
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
        for (name, _) in &self.definition.computed {
            proposed.insert((*name).into(), Value::Unknown);
        }
        for field in &self.definition.fields {
            // Core may propose unknown for an omitted OptionalComputed value.
            // Choose its default only when the configuration itself is null.
            if self.optional(field) && matches!(config.get(*field), Some(Value::Null) | None) {
                proposed.insert((*field).into(), Value::Value(String::new()));
            }
        }
        for (name, _) in &self.definition.generated {
            if matches!(config.get(*name), Some(Value::Null) | None) {
                proposed.insert((*name).into(), Value::Unknown);
            }
        }
        self.derive(&mut proposed, true);
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
        for field in &self.definition.reset_when_omitted {
            if matches!(config.get(*field), None | Some(Value::Null)) {
                proposed.insert((*field).into(), Value::Value(String::new()));
            }
        }
        self.check_plan(diags, &proposed, &config, Some(&prior))
            .await?;
        let (mut state, replacements) = plan_update(&self.definition, &prior, proposed);
        self.derive(&mut state, true);
        if self.destroying.load(Ordering::Acquire)
            && self.definition.keep_running_during_destroy
            && let Some(running) = prior.get("running")
        {
            // Teardown retains incomplete platform storage without retrying its
            // installation. Apply still reconciles running:false.
            state.insert("running".into(), running.clone());
        }
        if self.definition.refuse_replacement && !replacements.is_empty() {
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
            diags.root_error_short(match self.definition.protection {
                Protection::Always => "This resource is retained and cannot be deleted",
                _ => {
                    "Deletion requires the provider's destroy = true, because it removes data such as sandbox files and history"
                }
            });
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
        let mut planned = planned;
        for (name, generate) in &self.definition.generated {
            if matches!(
                planned.get(*name),
                Some(Value::Unknown | Value::Null) | None
            ) {
                match generate() {
                    Ok(value) => planned.insert((*name).into(), Value::Value(value)),
                    Err(error) => {
                        diags.root_error_short(error.to_string());
                        return None;
                    }
                };
            }
        }
        let row = match self.row(&planned, true) {
            Ok(row) => row,
            Err(error) => {
                diags.root_error_short(error.to_string());
                return None;
            }
        };
        let mutation = self.backend.ensure(self.definition.kind, &row).await;
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
        let row = match self.row(&planned, false) {
            Ok(row) => row,
            Err(error) => {
                diags.root_error_short(error.to_string());
                return Some((prior, private));
            }
        };
        let mutation = self.backend.ensure(self.definition.kind, &row).await;
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
#[cfg(test)]
mod tests {
    use super::*;

    struct UnusedBackend;
    #[async_trait]
    impl Backend for UnusedBackend {
        async fn read(&self, _: &str, _: &Row, _: bool) -> Result<Option<Row>, ObservationError> {
            unreachable!("binding checks do not contact the backend")
        }
        async fn ensure(&self, _: &str, _: &Row) -> Mutation {
            unreachable!("binding checks do not mutate resources")
        }
        async fn remove(&self, _: &str, _: &Row, _: bool) -> Result<(), ObservationError> {
            unreachable!("binding checks do not mutate resources")
        }
    }

    /// Observes rows without the connection fields the adapter carries.
    struct Observer(Row);
    #[async_trait]
    impl Backend for Observer {
        async fn read(&self, _: &str, _: &Row, _: bool) -> Result<Option<Row>, ObservationError> {
            Ok(Some(self.0.clone()))
        }
        async fn ensure(&self, _: &str, _: &Row) -> Mutation {
            Mutation::complete(self.0.clone())
        }
        async fn remove(&self, _: &str, _: &Row, _: bool) -> Result<(), ObservationError> {
            Ok(())
        }
    }

    #[tokio::test]
    async fn carried_fields_survive_refresh_and_apply_without_being_observed() {
        let observed: Row = [("id", "workspace/1"), ("name", "team")]
            .map(|(key, value)| (key.into(), value.into()))
            .into();
        let definition = Definition::new(
            "workspace",
            &["name", "gateway_endpoint"],
            &["gateway_endpoint"],
        )
        .carried(&["gateway_endpoint"]);
        let adapter = ResourceAdapter::new(definition, Arc::new(Observer(observed)));
        let state: State = [
            ("id", "workspace/1"),
            ("name", "team"),
            ("gateway_endpoint", "https://gateway.example"),
        ]
        .map(|(key, value)| (key.into(), Value::Value(value.into())))
        .into();
        let mut diags = Diagnostics::default();
        let (refreshed, _) = adapter
            .read(
                &mut diags,
                state.clone(),
                ValueEmpty::default(),
                ValueEmpty::default(),
            )
            .await
            .unwrap();
        assert!(diags.errors.is_empty(), "{diags:?}");
        assert_eq!(refreshed, state);
        let (created, _) = adapter
            .create(
                &mut diags,
                state.clone(),
                state.clone(),
                ValueEmpty::default(),
                ValueEmpty::default(),
            )
            .await
            .unwrap();
        assert!(diags.errors.is_empty(), "{diags:?}");
        assert_eq!(created, state);
    }

    /// Inputs that constrain each other are checked together while planning,
    /// even while others are unknown; the check learns which ones are.
    #[test]
    fn related_inputs_are_validated_together() {
        fn check(known: &Row, unknown: &[&str]) -> Result<(), std::borrow::Cow<'static, str>> {
            if unknown.contains(&"limit") {
                return Ok(());
            }
            let number = |field: &str| known[field].parse::<u32>().unwrap();
            if number("count") > number("limit") {
                return Err("count exceeds limit".into());
            }
            Ok(())
        }
        let definition =
            Definition::new("pool", &["count", "limit", "other"], &[]).validate_inputs(check);
        let adapter = ResourceAdapter::new(definition, Arc::new(UnusedBackend));
        let config = |limit: Value<String>| -> State {
            [
                ("count", Value::Value("3".into())),
                ("limit", limit),
                ("other", Value::Unknown),
            ]
            .map(|(key, value)| (key.into(), value))
            .into()
        };
        let mut diags = Diagnostics::default();
        assert!(
            adapter
                .validate_config(&mut diags, &config(Value::Value("5".into())))
                .is_some()
        );
        assert!(
            adapter
                .validate_config(&mut diags, &config(Value::Unknown))
                .is_some()
        );
        assert!(diags.errors.is_empty(), "{diags:?}");
        assert!(
            adapter
                .validate_config(&mut diags, &config(Value::Value("2".into())))
                .is_none()
        );
        assert!(
            format!("{diags:?}").contains("count exceeds limit"),
            "{diags:?}"
        );
    }

    /// A derived attribute is a function of inputs: known while planning once
    /// those inputs are, and recomputed from every observation.
    #[tokio::test]
    async fn derived_attributes_follow_their_inputs() {
        fn total(known: &Row, unknown: &[&str]) -> Option<String> {
            if unknown.iter().any(|field| ["a", "b"].contains(field)) {
                return None;
            }
            let number = |field: &str| known[field].parse::<u32>().unwrap();
            Some((number("a") + number("b")).to_string())
        }
        let observed: Row = [("id", "pool/1"), ("a", "2"), ("b", "5"), ("other", "")]
            .map(|(key, value)| (key.into(), value.into()))
            .into();
        let definition = Definition::new("pool", &["a", "b", "other"], &["a", "b", "other"])
            .optional(&["other"])
            .derived("total", total);
        let adapter = ResourceAdapter::new(definition, Arc::new(Observer(observed)));
        let state = |pairs: &[(&str, Value<String>)]| -> State {
            pairs
                .iter()
                .map(|(key, value)| ((*key).into(), value.clone()))
                .collect()
        };
        let known = |value: &str| Value::Value(value.to_owned());
        let mut diags = Diagnostics::default();
        let config = state(&[
            ("a", known("1")),
            ("b", known("2")),
            ("other", Value::Unknown),
        ]);
        let (planned, _) = adapter
            .plan_create(&mut diags, config.clone(), config, ValueEmpty::default())
            .await
            .unwrap();
        assert_eq!(planned["total"], known("3"));
        let config = state(&[
            ("a", known("1")),
            ("b", Value::Unknown),
            ("other", known("")),
        ]);
        let (planned, _) = adapter
            .plan_create(&mut diags, config.clone(), config, ValueEmpty::default())
            .await
            .unwrap();
        assert_eq!(planned["total"], Value::Unknown);
        let prior = state(&[
            ("id", known("pool/1")),
            ("a", known("1")),
            ("b", known("2")),
            ("other", known("")),
            ("total", known("3")),
        ]);
        let proposed = state(&[
            ("id", known("pool/1")),
            ("a", known("4")),
            ("b", known("2")),
            ("other", known("")),
            ("total", known("3")),
        ]);
        let (planned, _, _) = adapter
            .plan_update(
                &mut diags,
                prior.clone(),
                proposed.clone(),
                proposed,
                ValueEmpty::default(),
                ValueEmpty::default(),
            )
            .await
            .unwrap();
        assert_eq!(planned["total"], known("6"));
        let (refreshed, _) = adapter
            .read(
                &mut diags,
                prior,
                ValueEmpty::default(),
                ValueEmpty::default(),
            )
            .await
            .unwrap();
        assert_eq!(refreshed["total"], known("7"));
        assert!(diags.errors.is_empty(), "{diags:?}");
    }

    /// A resource in a sandbox, such as a Fabric agent, names that sandbox in
    /// diagnostics; a sandbox names itself.
    #[test]
    fn diagnostics_name_the_sandbox_a_resource_belongs_to() {
        let agent: Row = [("name", "main"), ("sandbox", "coder")]
            .map(|(key, value)| (key.into(), value.into()))
            .into();
        assert_eq!(sandbox_name(&agent), Some("coder"));
        let sandbox: Row = [("name".to_owned(), "coder".to_owned())].into();
        assert_eq!(sandbox_name(&sandbox), Some("coder"));
    }

    #[test]
    fn refresh_preserves_declared_bound_fields() {
        let definition = Definition::new("profile", &["name", "workspace", "source"], &[])
            .optional(&["source"])
            .bound_fields(&["source"]);
        let adapter = ResourceAdapter::new(definition, Arc::new(UnusedBackend));
        let prior: Row = [
            ("id", "profile/1"),
            ("name", "model"),
            ("workspace", "owned"),
            ("source", "bound-service"),
        ]
        .map(|(key, value)| (key.into(), value.into()))
        .into();
        assert!(adapter.checked(&prior, prior.clone()).is_ok());
        let mut changed = prior.clone();
        changed.insert("source".into(), "substituted-service".into());
        assert!(adapter.checked(&prior, changed).is_err());
    }
}
