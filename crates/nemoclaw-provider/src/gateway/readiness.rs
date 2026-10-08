// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Waits for a managed Docker gateway process to serve its API.

use super::process::ManagedGateway;
use crate::provider::ConfiguredBackend;
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::{sync::Arc, time::Duration};
use tf_provider::{
    AttributePath, DataSource, Diagnostics,
    schema::{Attribute, AttributeConstraint, AttributeType, Block, Description, Schema},
    value::{Value, ValueEmpty},
};

pub(crate) struct GatewayReadinessDataSource(pub Arc<ConfiguredBackend>);

#[derive(Default, Serialize, Deserialize)]
pub(crate) struct GatewayReadinessState {
    engine: Value<String>,
    container_id: Value<String>,
    name: Value<String>,
    owner: Value<String>,
    endpoint: Value<String>,
    wait_timeout_seconds: Value<u64>,
    // An unknown scheduling input makes OpenTofu defer this read until apply.
    read_trigger: Value<bool>,
    ready: Value<bool>,
}

/// Why a known input is invalid, without echoing it.
fn check(attribute: &str, value: &str) -> Result<(), &'static str> {
    let matches = |pattern: &str| regex::Regex::new(pattern).unwrap().is_match(value);
    match attribute {
        "engine" => nemoclaw_sdk::config::validate_engine_endpoint(value)
            .map_err(|_| "must be a supported Docker engine endpoint"),
        "container_id" if value.is_empty() => Err("must name the gateway container"),
        "name" if !matches(r"^[A-Za-z0-9][A-Za-z0-9_.-]+$") => {
            Err("must be a Docker container name")
        }
        "owner" if !matches(r"^[a-f0-9-]{36}$") => Err("must be a lowercase UUID"),
        "endpoint" => nemoclaw_sdk::config::validate_endpoint(value, true)
            .map_err(|_| "must be the gateway's HTTP or HTTPS origin, without a path"),
        _ => Ok(()),
    }
}

fn validate(diags: &mut Diagnostics, config: &GatewayReadinessState) -> Option<()> {
    let mut valid = true;
    for (attribute, value) in [
        ("engine", &config.engine),
        ("container_id", &config.container_id),
        ("name", &config.name),
        ("owner", &config.owner),
        ("endpoint", &config.endpoint),
    ] {
        if let Value::Value(value) = value
            && let Err(requirement) = check(attribute, value)
        {
            diags.error(
                format!("Invalid {attribute}"),
                format!("{attribute} {requirement}"),
                AttributePath::new(attribute),
            );
            valid = false;
        }
    }
    if matches!(config.wait_timeout_seconds, Value::Value(seconds) if seconds > 300) {
        diags.error(
            "Invalid gateway wait",
            "Use a timeout from 0 to 300 seconds.",
            AttributePath::new("wait_timeout_seconds"),
        );
        valid = false;
    }
    valid.then_some(())
}

fn known(value: &Value<String>) -> Option<&str> {
    match value {
        Value::Value(value) => Some(value),
        _ => None,
    }
}

#[async_trait]
impl DataSource for GatewayReadinessDataSource {
    type State<'a> = GatewayReadinessState;
    type ProviderMetaState<'a> = ValueEmpty;

    fn schema(&self, _: &mut Diagnostics) -> Option<Schema> {
        let attribute = |attr_type, constraint, description: &str| Attribute {
            attr_type,
            constraint,
            description: Description::plain(description.to_owned()),
            ..Default::default()
        };
        use AttributeConstraint::{Computed, Optional, Required};
        Some(Schema {
            version: 0,
            block: Block {
                attributes: [
                    (
                        "engine",
                        attribute(
                            AttributeType::String,
                            Required,
                            "Docker engine endpoint that runs the gateway container.",
                        ),
                    ),
                    (
                        "container_id",
                        attribute(
                            AttributeType::String,
                            Required,
                            "ID of the gateway container.",
                        ),
                    ),
                    (
                        "name",
                        attribute(
                            AttributeType::String,
                            Required,
                            "Expected name of the gateway container.",
                        ),
                    ),
                    (
                        "owner",
                        attribute(
                            AttributeType::String,
                            Required,
                            "Expected value of the container's nemoclaw.nvidia.com/uid label.",
                        ),
                    ),
                    (
                        "endpoint",
                        attribute(
                            AttributeType::String,
                            Required,
                            "Gateway API origin, called without credentials.",
                        ),
                    ),
                    (
                        "wait_timeout_seconds",
                        attribute(
                            AttributeType::Number,
                            Optional,
                            "Seconds to wait, from 0 to 300; omission checks once.",
                        ),
                    ),
                    (
                        "read_trigger",
                        attribute(
                            AttributeType::Bool,
                            Optional,
                            "Defers the read until apply while unknown.",
                        ),
                    ),
                    (
                        "ready",
                        attribute(
                            AttributeType::Bool,
                            Computed,
                            "True once the running gateway answers its health call.",
                        ),
                    ),
                ]
                .into_iter()
                .map(|(name, attribute)| (name.into(), attribute))
                .collect(),
                description: Description::plain(
                    "Waits for a managed Docker gateway container to run and answer its health call.",
                ),
                ..Default::default()
            },
        })
    }

    async fn validate<'a>(
        &self,
        diags: &mut Diagnostics,
        config: GatewayReadinessState,
    ) -> Option<()> {
        validate(diags, &config)
    }

    async fn read<'a>(
        &self,
        diags: &mut Diagnostics,
        mut config: GatewayReadinessState,
        _: ValueEmpty,
    ) -> Option<GatewayReadinessState> {
        validate(diags, &config)?;
        let (
            Some(engine),
            Some(id),
            Some(name),
            Some(owner),
            Some(endpoint),
            Value::Value(_) | Value::Null,
            Value::Value(_) | Value::Null,
        ) = (
            known(&config.engine),
            known(&config.container_id),
            known(&config.name),
            known(&config.owner),
            known(&config.endpoint),
            &config.wait_timeout_seconds,
            &config.read_trigger,
        )
        else {
            diags.root_error_short("Gateway readiness inputs are not yet known");
            return None;
        };
        let timeout = match config.wait_timeout_seconds {
            Value::Value(seconds) => Duration::from_secs(seconds),
            _ => Duration::ZERO,
        };
        let managed = match ManagedGateway::new(engine, id, name, owner, self.0.connections()) {
            Ok(managed) => managed,
            Err(error) => {
                diags.root_error("Gateway readiness failed", error.to_string());
                return None;
            }
        };
        // Generated managed gateways permit unauthenticated calls.
        let connection = nemoclaw_openshell::Connection {
            endpoint: endpoint.into(),
            ..Default::default()
        };
        let result =
            match nemoclaw_openshell::client(&connection, &crate::openshell::EnvironmentSecrets) {
                Ok(client) => {
                    managed
                        .observe(timeout, || nemoclaw_openshell::health(&client))
                        .await
                }
                Err(error) => Err(error.into()),
            };
        match result {
            Ok(()) => {
                config.ready = Value::Value(true);
                Some(config)
            }
            Err(failure) => {
                diags.root_error("Gateway readiness failed", failure.message(managed.name()));
                None
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn invalid_inputs_are_reported_at_their_attributes_without_echoing_them() {
        let source = GatewayReadinessDataSource(Arc::new(ConfiguredBackend::default()));
        let valid = || GatewayReadinessState {
            engine: Value::Value("unix:///var/run/docker.sock".into()),
            container_id: Value::Value("bound".into()),
            name: Value::Value("nc-0123456789abcdef-gateway".into()),
            owner: Value::Value("302ff5e1-088d-42ce-959f-4ff4c3570c13".into()),
            endpoint: Value::Value("http://127.0.0.1:17681".into()),
            ..Default::default()
        };
        let mut diags = Diagnostics::default();
        assert!(source.validate(&mut diags, valid()).await.is_some());
        let mut unknown = valid();
        unknown.container_id = Value::Unknown;
        unknown.wait_timeout_seconds = Value::Unknown;
        assert!(source.validate(&mut diags, unknown).await.is_some());
        for attribute in ["engine", "container_id", "name", "owner", "endpoint"] {
            let mut config = valid();
            let invalid = if attribute == "container_id" {
                String::new()
            } else {
                "PRIVATE SENTINEL/".into()
            };
            match attribute {
                "engine" => config.engine = Value::Value(invalid),
                "container_id" => config.container_id = Value::Value(invalid),
                "name" => config.name = Value::Value(invalid),
                "owner" => config.owner = Value::Value(invalid),
                _ => config.endpoint = Value::Value(invalid),
            }
            let mut diags = Diagnostics::default();
            assert!(
                source.validate(&mut diags, config).await.is_none(),
                "{attribute}"
            );
            let reported = format!("{diags:?}");
            assert!(
                reported.contains(&format!("Invalid {attribute}")),
                "{reported}"
            );
            assert!(!reported.contains("SENTINEL"), "{reported}");
        }
        let mut config = valid();
        config.wait_timeout_seconds = Value::Value(301);
        assert!(source.validate(&mut diags, config).await.is_none());
    }
}
