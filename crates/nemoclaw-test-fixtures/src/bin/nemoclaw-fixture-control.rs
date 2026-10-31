// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! The `fixture` provider through which `tofu test` cases configure and
//! observe the fixtures of `nemoclaw-e2e`'s integration runner. Its one data
//! source, `fixture_state`, sends its optional `declare` JSON to the
//! runner's control endpoint, `NEMOCLAW_FIXTURE_CONTROL`, and returns what
//! the fixtures recorded as `observations` JSON. Cases decide pass or fail.

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use tf_provider::{
    DataSource, Diagnostics, DynamicDataSource, DynamicResource, Provider,
    schema::{Attribute, AttributeConstraint, AttributeType, Block, Schema},
    value::{Value, ValueEmpty},
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

/// POST `body` to the control endpoint and return the reply's body.
async fn control(body: &str) -> Result<String, String> {
    let endpoint = std::env::var("NEMOCLAW_FIXTURE_CONTROL").map_err(|error| error.to_string())?;
    let address = endpoint.trim_start_matches("http://");
    let mut stream = tokio::net::TcpStream::connect(address)
        .await
        .map_err(|error| error.to_string())?;
    let request = format!(
        "POST / HTTP/1.1\r\nHost: fixture\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    stream
        .write_all(request.as_bytes())
        .await
        .map_err(|error| error.to_string())?;
    let mut reply = String::new();
    stream
        .read_to_string(&mut reply)
        .await
        .map_err(|error| error.to_string())?;
    match reply.split_once("\r\n\r\n") {
        Some((head, body)) if head.starts_with("HTTP/1.1 200 ") => Ok(body.to_owned()),
        _ => Err(reply),
    }
}

#[derive(Default, Serialize, Deserialize)]
struct State {
    declare: Value<String>,
    observations: Value<String>,
}

struct Fixture;
#[async_trait]
impl DataSource for Fixture {
    type State<'a> = State;
    type ProviderMetaState<'a> = ValueEmpty;
    fn schema(&self, _: &mut Diagnostics) -> Option<Schema> {
        let attribute = |constraint| Attribute {
            attr_type: AttributeType::String,
            constraint,
            ..Default::default()
        };
        Some(Schema {
            version: 0,
            block: Block {
                attributes: [
                    ("declare".into(), attribute(AttributeConstraint::Optional)),
                    (
                        "observations".into(),
                        attribute(AttributeConstraint::Computed),
                    ),
                ]
                .into(),
                ..Default::default()
            },
        })
    }
    async fn read<'a>(
        &self,
        diags: &mut Diagnostics,
        mut state: State,
        _: ValueEmpty,
    ) -> Option<State> {
        let body = match &state.declare {
            Value::Value(declare) => declare.clone(),
            _ => "null".into(),
        };
        match control(&body).await {
            Ok(observations) => {
                state.observations = Value::Value(observations);
                Some(state)
            }
            Err(error) => {
                diags.root_error("Fixture control failed", error);
                None
            }
        }
    }
}

struct FixtureProvider;
#[async_trait]
impl Provider for FixtureProvider {
    type Config<'a> = ValueEmpty;
    type MetaState<'a> = ValueEmpty;
    fn schema(&self, _: &mut Diagnostics) -> Option<Schema> {
        Some(Schema {
            version: 0,
            block: Block::default(),
        })
    }
    fn get_resources(
        &self,
        _: &mut Diagnostics,
    ) -> Option<HashMap<String, Box<dyn DynamicResource>>> {
        Some(HashMap::new())
    }
    fn get_data_sources(
        &self,
        _: &mut Diagnostics,
    ) -> Option<HashMap<String, Box<dyn DynamicDataSource>>> {
        Some(HashMap::from([(
            "state".to_owned(),
            Box::new(Fixture) as Box<dyn DynamicDataSource>,
        )]))
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let _ = rustls::crypto::ring::default_provider().install_default();
    tf_provider::serve("fixture", FixtureProvider).await?;
    Ok(())
}
