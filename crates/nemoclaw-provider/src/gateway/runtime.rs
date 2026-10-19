// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Computes a Docker gateway container's launch from typed settings.

use async_trait::async_trait;
use nemoclaw_sdk::managed::{GatewayLaunch, docker_gateway_config, docker_gateway_launch};
use serde::{Deserialize, Serialize};
use tf_provider::{
    DataSource, Diagnostics,
    schema::{Attribute, AttributeConstraint, AttributeType, Block, Description, Schema},
    value::{Value, ValueEmpty},
};

pub(crate) struct GatewayRuntimeDataSource;

#[derive(Default, Serialize, Deserialize)]
pub(crate) struct GatewayRuntimeState {
    name: Value<String>,
    endpoint: Value<String>,
    data_path: Value<String>,
    config: Value<String>,
    entrypoint: Value<Vec<Value<String>>>,
    command: Value<Vec<Value<String>>>,
    env: Value<Vec<Value<String>>>,
    config_file: Value<String>,
}

impl GatewayRuntimeState {
    /// The launch, or `None` while any input is unknown.
    fn launch(&self) -> Option<Result<GatewayLaunch, nemoclaw_sdk::Error>> {
        let known = |value: &Value<String>| match value {
            Value::Value(value) => Some(value.clone()),
            Value::Null => Some(String::new()),
            Value::Unknown => None,
        };
        let (name, endpoint, data_path) = (
            known(&self.name)?,
            known(&self.endpoint)?,
            known(&self.data_path)?,
        );
        Some(docker_gateway_launch(&name, &endpoint, &data_path))
    }

    /// The configuration file, or `None` while any input is unknown.
    fn config_file(&self) -> Option<Result<String, nemoclaw_sdk::Error>> {
        let known = |value: &Value<String>| match value {
            Value::Value(value) => Some(value.clone()),
            Value::Null => Some(String::new()),
            Value::Unknown => None,
        };
        let (name, data_path, config) = (
            known(&self.name)?,
            known(&self.data_path)?,
            known(&self.config)?,
        );
        Some(docker_gateway_config(&name, &data_path, &config))
    }
}

fn list(values: Vec<String>) -> Value<Vec<Value<String>>> {
    Value::Value(values.into_iter().map(Value::Value).collect())
}

#[async_trait]
impl DataSource for GatewayRuntimeDataSource {
    type State<'a> = GatewayRuntimeState;
    type ProviderMetaState<'a> = ValueEmpty;

    fn schema(&self, _: &mut Diagnostics) -> Option<Schema> {
        use AttributeConstraint::{Computed, Optional, Required};
        let attribute = |attr_type, constraint, description: &str| Attribute {
            attr_type,
            constraint,
            description: Description::plain(description.to_owned()),
            ..Default::default()
        };
        let string =
            |constraint, description| attribute(AttributeType::String, constraint, description);
        let strings = |description| {
            attribute(
                AttributeType::List(Box::new(AttributeType::String)),
                Computed,
                description,
            )
        };
        Some(Schema {
            version: 0,
            block: Block {
                attributes: [
                    ("name", string(Required, "Gateway name: nc-, 16 lowercase hexadecimal characters, a hyphen, and a lowercase name.")),
                    ("endpoint", string(Required, "Gateway HTTP origin with a loopback address and an unprivileged port.")),
                    ("data_path", string(Required, "Absolute data path returned by the gateway's storage.")),
                    ("entrypoint", strings("The container's entrypoint.")),
                    ("command", strings("The container's command.")),
                    ("env", strings("The container's environment.")),
                    ("config", string(Optional, "Authored OpenShell gateway tables as JSON, in the chart's gatewayConfig format.")),
                    ("config_file", string(Computed, "The gateway's OpenShell configuration file.")),
                ]
                .into_iter()
                .map(|(name, attribute)| (name.into(), attribute))
                .collect(),
                description: Description::plain(
                    "Computes a Docker gateway container's launch from typed settings without contacting any host.",
                ),
                ..Default::default()
            },
        })
    }

    async fn validate<'a>(
        &self,
        diags: &mut Diagnostics,
        config: GatewayRuntimeState,
    ) -> Option<()> {
        if let Some(Err(error)) = config.launch() {
            diags.root_error("Invalid Docker gateway settings", error.to_string());
            return None;
        }
        if let Some(Err(error)) = config.config_file() {
            diags.root_error("Invalid Docker gateway configuration", error.to_string());
            return None;
        }
        Some(())
    }

    async fn read<'a>(
        &self,
        diags: &mut Diagnostics,
        mut config: GatewayRuntimeState,
        _: ValueEmpty,
    ) -> Option<GatewayRuntimeState> {
        match (config.launch(), config.config_file()) {
            (Some(Ok(launch)), Some(Ok(file))) => {
                config.entrypoint = list(launch.entrypoint);
                config.command = list(launch.command);
                config.env = list(launch.env);
                config.config_file = Value::Value(file);
                Some(config)
            }
            (Some(Err(error)), _) | (_, Some(Err(error))) => {
                diags.root_error("Invalid Docker gateway settings", error.to_string());
                None
            }
            _ => {
                diags.root_error_short("Docker gateway settings are not yet known");
                None
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state(config: Value<String>) -> GatewayRuntimeState {
        GatewayRuntimeState {
            name: Value::Value("nc-0123456789abcdef-gateway".into()),
            endpoint: Value::Value("http://127.0.0.1:17671".into()),
            data_path: Value::Value("/var/lib/docker/volumes/data/_data".into()),
            config,
            ..Default::default()
        }
    }

    #[test]
    fn the_configuration_file_holds_owned_keys_and_authored_tables() {
        let file = state(Value::Value(
            r#"{"openshell.gateway":{"log_level":"debug"}}"#.into(),
        ))
        .config_file()
        .unwrap()
        .unwrap();
        for line in [
            "log_level = \"debug\"",
            "sandbox_label = \"nc-0123456789abcdef-gateway\"",
            "kid_path = \"/var/lib/docker/volumes/data/_data/tls/jwt/kid\"",
        ] {
            assert!(file.contains(line), "{line}: {file}");
        }
        let owned = state(Value::Null).config_file().unwrap().unwrap();
        assert!(!owned.contains("log_level"), "{owned}");
    }

    #[test]
    fn an_authored_table_that_replaces_an_owned_key_is_rejected() {
        let result = state(Value::Value(
            r#"{"openshell.gateway":{"disable_tls":false}}"#.into(),
        ))
        .config_file()
        .unwrap();
        assert!(result.is_err());
    }

    #[test]
    fn the_file_waits_for_unknown_inputs() {
        assert!(state(Value::Unknown).config_file().is_none());
    }
}
