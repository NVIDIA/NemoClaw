// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! The Fabric agent resource and its backend.

use crate::configuration;
use nemoclaw_backend::{Backend, Error, Mutation, ObservationError, Row};
use nemoclaw_fabric::agent::{
    self, ADAPTER_ID, CONFIG_SHA256, DESCRIPTION, HARNESS_CATALOG, HARNESS_IMAGE, NAME, SANDBOX,
    SECTIONS, SETTINGS,
};
use openshell_provider::OpenShell;
use std::borrow::Cow;

/// Starts and stops agents through Fabric's `fabric-agent-ctl` in their sandbox.
#[derive(Clone)]
pub struct AgentBackend(pub OpenShell);

/// What the sandbox's Fabric bridge reconciles for an agent: its sandbox by
/// name, and the document the agent's inputs compose.
fn configuration_row(row: &Row) -> Result<Row, ObservationError> {
    let config = agent::compose(row).map_err(|_| ObservationError::Query)?;
    let mut configured = nemoclaw_openshell::without_gateway(row);
    configured.insert("name".into(), row.get(SANDBOX).cloned().unwrap_or_default());
    configured.insert("config_json".into(), config.to_string());
    Ok(configured)
}

/// The agent's row after an observation. Its inputs change only when the
/// observed document differs from the one they compose.
fn agent_row(agent: &Row, configured: &Row, observed: &Row) -> Row {
    let mut row = agent.clone();
    for field in ["id", "runtime_id"] {
        if let Some(value) = observed.get(field) {
            row.insert(field.into(), value.clone());
        }
    }
    if observed.get("config_json") != configured.get("config_json")
        && let Some(config) = observed
            .get("config_json")
            .and_then(|encoded| serde_json::from_str(encoded).ok())
    {
        row.extend(agent::decompose(&config));
    }
    row
}

#[async_trait::async_trait]
impl Backend for AgentBackend {
    async fn plan(&self, _: &str, desired: &Row, _: Option<&Row>) -> Result<(), Error> {
        configuration::plan(&self.0, &configuration_row(desired)?).await
    }
    async fn read(
        &self,
        _: &str,
        prior: &Row,
        removing: bool,
    ) -> Result<Option<Row>, ObservationError> {
        let configured = configuration_row(prior)?;
        Ok(configuration::read(&self.0, &configured, removing)
            .await?
            .map(|observed| agent_row(prior, &configured, &observed)))
    }
    async fn ensure(&self, _: &str, desired: &Row) -> Mutation {
        let configured = match configuration_row(desired) {
            Ok(configured) => configured,
            Err(error) => return Mutation::failed(error),
        };
        match configuration::ensure(&self.0, &configured)
            .await
            .into_parts()
        {
            (Some(observed), None) => {
                Mutation::complete(agent_row(desired, &configured, &observed))
            }
            (Some(observed), Some(error)) => {
                Mutation::partial(agent_row(desired, &configured, &observed), error)
            }
            (None, error) => Mutation::failed(error.unwrap_or(ObservationError::Incomplete)),
        }
    }
    async fn remove(&self, _: &str, prior: &Row, destroying: bool) -> Result<(), ObservationError> {
        configuration::remove(&self.0, &configuration_row(prior)?, destroying).await
    }
}

/// The agent's document is valid Fabric configuration that its harness accepts.
fn validate(known: &Row, unknown: &[&str]) -> Result<(), Cow<'static, str>> {
    let document = [NAME, DESCRIPTION, ADAPTER_ID, HARNESS_CATALOG, SETTINGS.1]
        .into_iter()
        .chain(SECTIONS.map(|(_, field)| field));
    if document.into_iter().any(|field| unknown.contains(&field)) {
        return Ok(());
    }
    let config = agent::compose(known)?;
    // Whether the harness accepts the configuration is Fabric's to decide,
    // inside the sandbox when the agent is configured.
    configuration::check(&config.to_string())
        .map_err(|requirement| format!("The agent configuration {requirement}"))?;
    Ok(())
}

/// An agent changes only with its sandbox: its replacement plans while the
/// sandbox is replaced too, which makes the sandbox's ID unknown.
fn sandbox_kept(
    prior: &nemoclaw_tofu::State,
    planned: &nemoclaw_tofu::State,
) -> Option<&'static str> {
    use tf_provider::value::Value;
    match (prior.get("sandbox_id"), planned.get("sandbox_id")) {
        (Some(Value::Value(prior)), Some(Value::Value(planned))) if prior == planned => Some(
            "A changed agent needs a new sandbox. Replace the sandbox with the agent: give it lifecycle { replace_triggered_by = [terraform_data.<agent>] }, where that terraform_data's input is the agent's configuration",
        ),
        _ => None,
    }
}

/// The Fabric agent resource and its planning rules.
pub fn definitions() -> [nemoclaw_tofu::Definition; 1] {
    use nemoclaw_tofu::{Definition, carry_prior};
    let references = agent::references();
    let inputs = agent::structured_inputs();
    let carried: Vec<&'static str> = references
        .iter()
        .flat_map(|reference| reference.fields.iter().map(|(_, field)| *field))
        .collect();
    let sections: Vec<&'static str> = inputs.iter().map(|input| input.field).collect();
    let fields: Vec<&'static str> = [NAME, DESCRIPTION, "runtime_id"]
        .into_iter()
        .chain(carried.iter().copied())
        .chain(sections.iter().copied())
        .collect();
    let gateway = nemoclaw_openshell::GATEWAY_FIELDS.map(|(_, field)| field);
    // A changed agent is a new agent in a new sandbox. Another endpoint is
    // another gateway; credentials rotate in place. A newer image catalog for
    // the same harness changes no agent.
    let mutable: Vec<&'static str> = [HARNESS_CATALOG, "runtime_id"]
        .into_iter()
        .chain(gateway[1..].iter().copied())
        .collect();
    let optional: Vec<&'static str> = [DESCRIPTION]
        .into_iter()
        .chain(sections.iter().copied())
        .chain(gateway[1..].iter().copied())
        .collect();
    let mut definition = Definition::new("agent", &fields, &mutable)
        .optional(&optional)
        // The ID Fabric gives the sandbox's one runtime, for invocations.
        .computed("runtime_id", carry_prior)
        .validate_inputs(validate)
        .refuse_replacement_when(sandbox_kept)
        // Readiness compares the applied document with this digest.
        .derived(CONFIG_SHA256, agent::config_digest)
        .exports(
            agent::RESOURCE_TYPE,
            &[
                "workspace",
                SANDBOX,
                "sandbox_id",
                "owner",
                "generation",
                NAME,
                CONFIG_SHA256,
            ],
        )
        // The backend reaches the sandbox through these and observes only
        // the configuration document.
        .carried(&gateway)
        .carried(&[HARNESS_IMAGE, HARNESS_CATALOG]);
    definition.references = references;
    definition.structured = inputs;
    [definition]
}
