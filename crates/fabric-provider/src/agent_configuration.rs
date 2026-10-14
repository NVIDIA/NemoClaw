// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! The agent configuration resource and its backend.

use crate::configuration;
use nemoclaw_backend::{Backend, Error, Mutation, ObservationError, Row};
use openshell_provider::OpenShell;

/// Reconciles agent configurations through the Fabric bridge of their sandbox.
#[derive(Clone)]
pub struct AgentConfigurationBackend(pub OpenShell);

#[async_trait::async_trait]
impl Backend for AgentConfigurationBackend {
    async fn plan(&self, _: &str, desired: &Row, _: Option<&Row>) -> Result<(), Error> {
        configuration::plan(&self.0, &nemoclaw_openshell::without_gateway(desired)).await
    }
    async fn read(
        &self,
        _: &str,
        prior: &Row,
        removing: bool,
    ) -> Result<Option<Row>, ObservationError> {
        configuration::read(
            &self.0,
            &nemoclaw_openshell::without_gateway(prior),
            removing,
        )
        .await
    }
    async fn ensure(&self, _: &str, desired: &Row) -> Mutation {
        configuration::ensure(&self.0, &nemoclaw_openshell::without_gateway(desired)).await
    }
    async fn remove(&self, _: &str, prior: &Row, destroying: bool) -> Result<(), ObservationError> {
        configuration::remove(
            &self.0,
            &nemoclaw_openshell::without_gateway(prior),
            destroying,
        )
        .await
    }
}

/// The Fabric agent configuration resource and its planning rules.
pub fn definitions() -> [nemoclaw_tofu::Definition; 1] {
    use nemoclaw_tofu::{Definition, rerun_when_stopped};
    [Definition::new(
        "agent_configuration",
        &[
            "workspace",
            "name",
            "owner",
            "generation",
            "sandbox_id",
            "config_json",
            "running",
        ],
        &["config_json", "running"],
    )
    .computed("running", rerun_when_stopped)
    .validate_attribute(|attribute, value| match attribute {
        "config_json" => crate::configuration::check(value).map_err(Into::into),
        _ => Ok(()),
    })]
    .map(|mut definition| {
        // The configuration reaches its sandbox through the gateway its ref names.
        let gateway = nemoclaw_openshell::GATEWAY_FIELDS.map(|(_, field)| field);
        definition.fields.extend(gateway);
        // Another endpoint is another gateway; credentials rotate in place.
        definition.mutable.extend(&gateway[1..]);
        definition.optional.extend(&gateway[1..]);
        definition.carried.extend(gateway);
        definition.references = nemoclaw_openshell::references(definition.kind);
        // Version 1 takes a gateway ref; earlier state is rejected.
        definition.schema_version(1)
    })
}
