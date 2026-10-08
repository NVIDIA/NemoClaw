// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Computes a Docker gateway container's launch from typed settings.

use async_trait::async_trait;
use nemoclaw_sdk::managed::{GatewayLaunch, docker_gateway_launch};
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
    entrypoint: Value<Vec<Value<String>>>,
    command: Value<Vec<Value<String>>>,
    env: Value<Vec<Value<String>>>,
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
}

fn list(values: Vec<String>) -> Value<Vec<Value<String>>> {
    Value::Value(values.into_iter().map(Value::Value).collect())
}

#[async_trait]
impl DataSource for GatewayRuntimeDataSource {
    type State<'a> = GatewayRuntimeState;
    type ProviderMetaState<'a> = ValueEmpty;

    fn schema(&self, _: &mut Diagnostics) -> Option<Schema> {
        use AttributeConstraint::{Computed, Required};
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
        Some(())
    }

    async fn read<'a>(
        &self,
        diags: &mut Diagnostics,
        mut config: GatewayRuntimeState,
        _: ValueEmpty,
    ) -> Option<GatewayRuntimeState> {
        match config.launch() {
            Some(Ok(launch)) => {
                config.entrypoint = list(launch.entrypoint);
                config.command = list(launch.command);
                config.env = list(launch.env);
                Some(config)
            }
            Some(Err(error)) => {
                diags.root_error("Invalid Docker gateway settings", error.to_string());
                None
            }
            None => {
                diags.root_error_short("Docker gateway settings are not yet known");
                None
            }
        }
    }
}
