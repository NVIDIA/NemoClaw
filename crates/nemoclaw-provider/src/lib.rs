// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! OpenTofu protocol adapter for shared desired-state operations.

use std::collections::BTreeMap;
use tf_provider::value::Value;

/// OpenTofu string attributes, including distinct null and unknown values.
pub type State = BTreeMap<String, Value<String>>;

/// Stable resource schema and the fields permitted to change in place.
#[derive(Clone, Debug)]
pub struct Definition {
    pub kind: &'static str,
    pub fields: Vec<&'static str>,
    pub mutable: Vec<&'static str>,
    pub observed_running: bool,
}

impl Definition {
    pub fn new(kind: &'static str, fields: &[&'static str], mutable: &[&'static str]) -> Self {
        Self {
            kind,
            fields: fields.to_vec(),
            mutable: mutable.to_vec(),
            observed_running: matches!(
                kind,
                "managed_gateway"
                    | "agent_configuration"
                    | nemoclaw_sdk::kubernetes::GATEWAY_KIND
                    | nemoclaw_sdk::kubernetes::STORAGE_KIND
                    | nemoclaw_sdk::kubernetes::AUTH_KIND
            ),
        }
    }
}

/// Preserve established computed identity; mark immutable configuration changes
/// for replacement. The resource adapter protects retained and stateful resources.
pub fn plan_update(
    definition: &Definition,
    prior: &State,
    mut proposed: State,
) -> (State, Vec<&'static str>) {
    if definition.kind == "container_inputs" {
        match prior.get("complete") {
            Some(Value::Value(value)) if value == "false" => {
                proposed.insert("complete".into(), Value::Unknown);
                proposed.insert("id".into(), Value::Unknown);
            }
            Some(value) => {
                proposed.insert("complete".into(), value.clone());
            }
            None => {}
        }
    }
    if matches!(
        proposed.get("id"),
        Some(Value::Unknown | Value::Null) | None
    ) && !(definition.kind == "container_inputs"
        && prior.get("complete") == Some(&Value::Value("false".into())))
        && let Some(id) = prior.get("id")
    {
        proposed.insert("id".into(), id.clone());
    }
    if definition.kind == "gateway_storage" {
        proposed.insert(
            "data_path".into(),
            prior.get("data_path").cloned().unwrap_or(Value::Unknown),
        );
    }
    if definition.observed_running {
        match prior.get("running") {
            Some(Value::Value(value)) if value == "false" => {
                proposed.insert("running".into(), Value::Unknown);
            }
            Some(value) => {
                proposed.insert("running".into(), value.clone());
            }
            None => {}
        }
    }
    if definition.kind == nemoclaw_sdk::kubernetes::AUTH_KIND {
        proposed.insert(
            "release_present".into(),
            prior
                .get("release_present")
                .cloned()
                .unwrap_or(Value::Unknown),
        );
        let prepared = matches!(prior.get("running"), Some(Value::Value(value)) if value == "true");
        proposed.insert(
            "gateway_values".into(),
            prior
                .get("gateway_values")
                .filter(|_| prepared)
                .cloned()
                .unwrap_or(Value::Unknown),
        );
    }
    let authentication_changed = definition.kind == "provider"
        && authentication_mode(prior) != authentication_mode(&proposed);
    let replacements = definition
        .fields
        .iter()
        .copied()
        .filter(|field| {
            (!definition.mutable.contains(field)
                || (*field == "credential_env" && authentication_changed))
                && proposed.get(*field) != prior.get(*field)
        })
        .collect();
    (proposed, replacements)
}

fn authentication_mode(state: &State) -> Option<bool> {
    let mut authenticated = false;
    for field in ["credential_env", "credential_source"] {
        match state.get(field) {
            Some(Value::Unknown) => return None,
            Some(Value::Value(value)) => authenticated |= !value.is_empty(),
            Some(Value::Null) | None => {}
        }
    }
    Some(authenticated)
}

mod resource;
pub use nemoclaw_sdk::backend::{Backend, Mutation, Row};
pub use resource::ResourceAdapter;
mod capacity;
mod discovery;
mod gateway;
pub mod hardware;
mod hardware_data;
mod inference_discovery;
pub mod kubernetes;
mod provider;
mod readiness;
mod runtime_image;
mod sandbox_readiness;
pub use provider::NemoClawProvider;

/// OpenShell resource operations owned by this provider.
pub mod openshell;

pub mod docker;
pub mod hardware_observation;
pub mod managed;
pub mod services;
pub(crate) use nemoclaw_sdk::{
    CancellationToken, Error, ObservationError, Progress, backend, config,
};

mod download;
pub(crate) use nemoclaw_sdk::{ByteProgress, DownloadPhase};

#[cfg(all(test, unix))]
use nemoclaw_sdk::compile;

#[cfg(test)]
mod application_input_contract_tests {
    use super::*;
    #[test]
    fn incomplete_input_delivery_requires_an_explicit_apply_update() {
        let definition = Definition::new("container_inputs", &["spec", "sandbox_id"], &[]);
        let prior: State = [
            ("id".into(), Value::Value("bound".into())),
            ("complete".into(), Value::Value("false".into())),
        ]
        .into();
        let (planned, replacements) = plan_update(&definition, &prior, prior.clone());
        assert_eq!(planned["complete"], Value::Unknown);
        assert_eq!(planned["id"], Value::Unknown);
        assert!(replacements.is_empty());
    }
    #[tokio::test]
    #[cfg(unix)]
    async fn application_inputs_register_an_engine_backend_without_a_gateway_client() {
        let mut document = nemoclaw_sdk::config::Document::parse(
            include_bytes!("../../nemoclaw-sdk/tests/fixtures/config/managed-ollama.yaml")
                .as_slice(),
        )
        .unwrap();
        let mut service = serde_json::json!({
            "kind":"container","image":format!("voice@sha256:{}", "a".repeat(64)),
            "architecture":"arm64","data":{"mountPath":"/var/lib/voiceclaw"},
            "inputSetup":{"image":format!("inputs@sha256:{}", "b".repeat(64))},
            "secrets":{"speech":{"credential":{"env":"SPEECH_KEY"},"targetPath":"/var/lib/voiceclaw/credentials/speech"}}
        });
        document.spec.services.insert(
            "voice".into(),
            serde_json::from_value(service.take()).unwrap(),
        );
        let generations = [
            "workspace",
            "provider",
            "sandbox",
            "ollama_service",
            "managed_gateway",
            "container_service",
        ]
        .map(|kind| (kind.into(), "a".repeat(32)))
        .into();
        let target = nemoclaw_sdk::compile::targets(&document, &generations)
            .unwrap()
            .into_iter()
            .find(|t| t.kind == "container_inputs")
            .unwrap();
        let fixture = docker::fixture::Fixture::start(|_| {
            panic!("backend registration must not query Docker")
        })
        .await;
        let spec: nemoclaw_sdk::services::installers::container::inputs::InputsSpec =
            serde_json::from_str(&target.values["spec"]).unwrap();
        let connections =
            docker::Connections::fixed([fixture.engine_for(spec.process.engine())]).unwrap();
        assert!(
            services::BackendRegistry::new(&connections)
                .resolve(&target.kind, &target.values)
                .unwrap()
                .is_some()
        );
    }
}
