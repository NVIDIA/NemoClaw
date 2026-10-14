// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! An Ollama model that a local Ollama server already has, checked by digest.

use crate::services::installers::ollama::proxy::verify_model;
use async_trait::async_trait;
use nemoclaw_runtime::ollama::Models;
use nemoclaw_sdk::services::installers::ollama::{MODEL_PATTERN, ProxySettings};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use tf_provider::{
    AttributePath, DataSource, Diagnostics,
    schema::{Attribute, AttributeConstraint, AttributeType, Block, Schema},
    value::{Value, ValueEmpty},
};

/// The type an `ollama_model` ref names.
pub const MODEL_TYPE: &str = "ollama_model";

/// The inputs an `ollama_model` ref carries.
const FIELDS: [&str; 3] = ["upstream", "name", "digest"];

/// Data source for a model on a local Ollama server. Reading it only lists the
/// server's models; it never installs or changes one.
pub struct OllamaModelDataSource;

#[derive(Default, Serialize, Deserialize)]
pub struct OllamaModelState {
    upstream: Value<String>,
    name: Value<String>,
    digest: Value<String>,
    /// The checked model, which consumers take as `model`.
    #[serde(rename = "ref")]
    reference: Value<BTreeMap<String, Value<String>>>,
}

impl OllamaModelState {
    fn inputs(&self) -> [&Value<String>; 3] {
        [&self.upstream, &self.name, &self.digest]
    }

    /// The inputs once all are known.
    fn known(&self) -> Option<[&str; 3]> {
        let [upstream, name, digest] = self.inputs();
        match (upstream, name, digest) {
            (Value::Value(upstream), Value::Value(name), Value::Value(digest)) => {
                Some([upstream, name, digest])
            }
            _ => None,
        }
    }

    /// The `ref` naming this model; unknown inputs leave it unknown.
    fn reference(&self) -> Value<BTreeMap<String, Value<String>>> {
        let Some(values) = self.known() else {
            return Value::Unknown;
        };
        Value::Value(
            std::iter::once((nemoclaw_tofu::REF_TYPE, MODEL_TYPE))
                .chain(FIELDS.into_iter().zip(values))
                .map(|(attribute, value)| (attribute.to_owned(), Value::Value(value.to_owned())))
                .collect(),
        )
    }
}

/// The model to check, or the attribute that makes it invalid and why.
fn settings(
    upstream: &str,
    name: &str,
    digest: &str,
) -> Result<ProxySettings, (&'static str, &'static str)> {
    const UPSTREAM: &str = "upstream must be an http URL with a loopback IP address, an explicit port, and path /v1, without credentials, query, or fragment";
    Models::new(upstream).map_err(|_| ("upstream", UPSTREAM))?;
    let url = url::Url::parse(upstream).map_err(|_| ("upstream", UPSTREAM))?;
    let loopback = match url.host() {
        Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
        Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
        _ => false,
    };
    if url.port().is_none() || !loopback {
        return Err(("upstream", UPSTREAM));
    }
    if !regex::Regex::new(MODEL_PATTERN).unwrap().is_match(name) {
        return Err(("name", "name must be an Ollama model name"));
    }
    if !regex::Regex::new("^[a-f0-9]{64}$")
        .unwrap()
        .is_match(digest)
    {
        return Err((
            "digest",
            "digest must be 64 lowercase hexadecimal characters",
        ));
    }
    Ok(ProxySettings {
        upstream: upstream.to_owned(),
        model: name.to_owned(),
        digest: digest.to_owned(),
        endpoint: String::new(),
    })
}

fn check(diags: &mut Diagnostics, config: &OllamaModelState) -> Option<Option<ProxySettings>> {
    let Some([upstream, name, digest]) = config.known() else {
        return Some(None);
    };
    match settings(upstream, name, digest) {
        Ok(settings) => Some(Some(settings)),
        Err((attribute, error)) => {
            diags.error_short(error, AttributePath::new(attribute));
            None
        }
    }
}

#[async_trait]
impl DataSource for OllamaModelDataSource {
    type State<'a> = OllamaModelState;
    type ProviderMetaState<'a> = ValueEmpty;

    fn schema(&self, _: &mut Diagnostics) -> Option<Schema> {
        let mut attributes: std::collections::HashMap<String, Attribute> = FIELDS
            .into_iter()
            .map(|name| {
                (
                    name.to_owned(),
                    Attribute {
                        attr_type: AttributeType::String,
                        constraint: AttributeConstraint::Required,
                        ..Default::default()
                    },
                )
            })
            .collect();
        attributes.insert(
            "ref".into(),
            Attribute {
                attr_type: AttributeType::Object(
                    std::iter::once(nemoclaw_tofu::REF_TYPE)
                        .chain(FIELDS)
                        .map(|name| (name.to_owned(), AttributeType::String))
                        .collect(),
                ),
                constraint: AttributeConstraint::Computed,
                ..Default::default()
            },
        );
        Some(Schema {
            version: 0,
            block: Block {
                attributes,
                ..Default::default()
            },
        })
    }

    async fn validate<'a>(&self, diags: &mut Diagnostics, config: OllamaModelState) -> Option<()> {
        check(diags, &config).map(|_| ())
    }

    async fn read<'a>(
        &self,
        diags: &mut Diagnostics,
        mut config: OllamaModelState,
        _: ValueEmpty,
    ) -> Option<OllamaModelState> {
        let Some(settings) = check(diags, &config)? else {
            diags.root_error_short("Ollama model inputs are not yet known");
            return None;
        };
        if let Err(error) = verify_model(&settings).await {
            diags.root_error(
                "Ollama model check failed",
                format!(
                    "Ollama model {} at {}: {error}",
                    settings.model, settings.upstream
                ),
            );
            return None;
        }
        config.reference = config.reference();
        Some(config)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state(upstream: &str, name: &str, digest: &str) -> OllamaModelState {
        OllamaModelState {
            upstream: Value::Value(upstream.into()),
            name: Value::Value(name.into()),
            digest: Value::Value(digest.into()),
            reference: Value::Unknown,
        }
    }

    #[test]
    fn invalid_inputs_name_their_attribute() {
        let digest = "a".repeat(64);
        for (upstream, name, digest, attribute) in [
            (
                "http://192.0.2.1:11434/v1",
                "qwen3:0.6b",
                digest.as_str(),
                "upstream",
            ),
            (
                "http://127.0.0.1/v1",
                "qwen3:0.6b",
                digest.as_str(),
                "upstream",
            ),
            (
                "http://user@127.0.0.1:11434/v1",
                "qwen3:0.6b",
                digest.as_str(),
                "upstream",
            ),
            ("http://127.0.0.1:11434/v1", "-bad", digest.as_str(), "name"),
            (
                "http://127.0.0.1:11434/v1",
                "qwen3:0.6b",
                "sha256:abc",
                "digest",
            ),
        ] {
            assert_eq!(
                settings(upstream, name, digest).unwrap_err().0,
                attribute,
                "{upstream} {name} {digest}"
            );
        }
        assert!(settings("http://[::1]:11434/v1", "qwen3:0.6b", &digest).is_ok());
    }

    #[test]
    fn the_ref_waits_for_every_input() {
        let digest = "a".repeat(64);
        let mut model = state("http://127.0.0.1:11434/v1", "qwen3:0.6b", &digest);
        let Value::Value(reference) = model.reference() else {
            panic!("known inputs give a ref");
        };
        assert_eq!(reference["type"], Value::Value(MODEL_TYPE.to_owned()));
        assert_eq!(reference["digest"], Value::Value(digest.clone()));
        model.digest = Value::Unknown;
        assert!(matches!(model.reference(), Value::Unknown));
    }
}
