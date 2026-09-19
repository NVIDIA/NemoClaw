// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use crate::{Backend, Definition, Mutation, Row, State, plan_update};
use async_trait::async_trait;
use nemoclaw_sdk::{Binding, Bound, Observation, ObservationError, refresh};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use tf_provider::schema::{Attribute, AttributeConstraint, AttributeType, Block, Schema};
use tf_provider::value::{Value, ValueEmpty};
use tf_provider::{AttributePath, Diagnostics, Resource};

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
    fn optional(&self, field: &str) -> bool {
        (self.definition.kind == "provider_profile"
            && matches!(field, "endpoint" | "authenticated"))
            || matches!(
                field,
                "image_pull_policy"
                    | "credential_source"
                    | "credential_env"
                    | "agent_runtime"
                    | "provider_type"
                    | "policy_json"
                    | "proxy_host"
                    | "proxy_port"
                    | "inference_json"
            )
    }
    fn computed_digest(&self) -> bool {
        self.definition.computed_digest
    }
    fn observed_running(&self) -> bool {
        self.definition.observed_running
    }
    fn observed_data_path(&self) -> bool {
        self.definition.kind == "gateway_storage"
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
                if self.definition.fields.contains(&"spec") {
                    diags.error(
                        "Resource planning failed",
                        error.to_string(),
                        AttributePath::new("spec"),
                    );
                } else {
                    diags.root_error("Resource planning failed", error.to_string());
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
                        || (k == "digest" && self.computed_digest())
                        || (k == "data_path" && self.observed_data_path()) =>
                {
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
    fn checked(&self, prior: &Row, observed: Row) -> Result<Row, ObservationError> {
        for field in self
            .definition
            .fields
            .iter()
            .copied()
            .chain(["id"])
            .chain(self.computed_digest().then_some("digest"))
            .chain(self.observed_data_path().then_some("data_path"))
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
            diags.root_error("Apply incomplete", error.to_string());
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
            .chain(self.computed_digest().then_some("digest"))
            .chain(self.observed_data_path().then_some("data_path"))
            .map(|name| {
                (
                    name.into(),
                    Attribute {
                        attr_type: AttributeType::String,
                        constraint: if name == "id"
                            || (name == "digest" && self.computed_digest())
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
                diags.root_error("Resource observation", error.to_string());
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
        proposed.insert("id".into(), Value::Unknown);
        if self.computed_digest() {
            proposed.insert("digest".into(), Value::Unknown);
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
        if self.definition.fields.contains(&"image_pull_policy")
            && matches!(config.get("image_pull_policy"), None | Some(Value::Null))
        {
            proposed.insert("image_pull_policy".into(), Value::Value(String::new()));
        }
        self.check_plan(diags, &proposed, &config, Some(&prior))
            .await?;
        let (state, replacements) = plan_update(&self.definition, &prior, proposed);
        Some((
            state,
            private,
            replacements.into_iter().map(AttributePath::new).collect(),
        ))
    }
    async fn plan_destroy<'a>(
        &self,
        _: &mut Diagnostics,
        _: State,
        private: ValueEmpty,
        _: ValueEmpty,
    ) -> Option<ValueEmpty> {
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
        let mutation = nemoclaw_sdk::with_provider_download_progress(
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
        let row = match self.row(&planned, false) {
            Ok(row) => row,
            Err(error) => {
                diags.root_error_short(error.to_string());
                return Some((prior, private));
            }
        };
        let mutation = nemoclaw_sdk::with_provider_download_progress(
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
