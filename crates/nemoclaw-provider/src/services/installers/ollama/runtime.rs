// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Computes the Ollama proxy's `NEMOCLAW_OLLAMA_PROXY` contract from typed settings.

use async_trait::async_trait;
use nemoclaw_sdk::services::installers::ollama::ProxySettings;
use serde::{Deserialize, Serialize};
use tf_provider::{
    DataSource, Diagnostics,
    schema::{Attribute, AttributeConstraint, AttributeType, Block, Description, Schema},
    value::{Value, ValueEmpty},
};

pub struct ProxyRuntimeDataSource;

#[derive(Default, Serialize, Deserialize)]
pub struct ProxyRuntimeState {
    bind_address: Value<String>,
    upstream: Value<String>,
    model: Value<String>,
    digest: Value<String>,
    spec: Value<String>,
}

impl ProxyRuntimeState {
    /// The settings, or `None` while any input is unknown.
    fn settings(&self) -> Option<Result<ProxySettings, nemoclaw_sdk::Error>> {
        let known = |value: &Value<String>| match value {
            Value::Value(value) => Some(value.clone()),
            Value::Null => Some(String::new()),
            Value::Unknown => None,
        };
        let (bind, upstream, model, digest) = (
            known(&self.bind_address)?,
            known(&self.upstream)?,
            known(&self.model)?,
            known(&self.digest)?,
        );
        Some(ProxySettings::new(&bind, &upstream, &model, &digest))
    }
}

#[async_trait]
impl DataSource for ProxyRuntimeDataSource {
    type State<'a> = ProxyRuntimeState;
    type ProviderMetaState<'a> = ValueEmpty;

    fn schema(&self, _: &mut Diagnostics) -> Option<Schema> {
        let attribute = |constraint, description: &str| Attribute {
            attr_type: AttributeType::String,
            constraint,
            description: Description::plain(description.to_owned()),
            ..Default::default()
        };
        use AttributeConstraint::{Computed, Required};
        Some(Schema {
            version: 0,
            block: Block {
                attributes: [
                    ("bind_address", attribute(Required, "Loopback or private address and port the proxy serves.")),
                    ("upstream", attribute(Required, "Loopback HTTP Ollama endpoint, ending in /v1.")),
                    ("model", attribute(Required, "Ollama model name and tag.")),
                    ("digest", attribute(Required, "The model's 64-character SHA-256 digest.")),
                    ("spec", attribute(Computed, "Validated value for the container's NEMOCLAW_OLLAMA_PROXY environment variable.")),
                ]
                .into_iter()
                .map(|(name, attribute)| (name.into(), attribute))
                .collect(),
                description: Description::plain(
                    "Computes the Ollama proxy contract from typed settings without contacting any host.",
                ),
                ..Default::default()
            },
        })
    }

    async fn validate<'a>(&self, diags: &mut Diagnostics, config: ProxyRuntimeState) -> Option<()> {
        if let Some(Err(error)) = config.settings() {
            diags.root_error("Invalid Ollama proxy settings", error.to_string());
            return None;
        }
        Some(())
    }

    async fn read<'a>(
        &self,
        diags: &mut Diagnostics,
        mut config: ProxyRuntimeState,
        _: ValueEmpty,
    ) -> Option<ProxyRuntimeState> {
        match config.settings() {
            Some(Ok(settings)) => {
                config.spec = Value::Value(serde_json::to_string(&settings).ok()?);
                Some(config)
            }
            Some(Err(error)) => {
                diags.root_error("Invalid Ollama proxy settings", error.to_string());
                None
            }
            None => {
                diags.root_error_short("Ollama proxy settings are not yet known");
                None
            }
        }
    }
}
