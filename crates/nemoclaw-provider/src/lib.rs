// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! The `nemoclaw` OpenTofu provider: platform resources and observations.

pub use nemoclaw_tofu::*;

mod capacity;
mod discovery;
mod gateway;
pub mod hardware;
mod hardware_data;
mod inference_discovery;
pub mod kubernetes;
mod provider;
mod readiness;
mod runtime_contract;
mod runtime_image;
mod sandbox_readiness;
pub use provider::NemoClawProvider;

/// The definition this provider serves for a resource kind.
pub fn resource_definition(kind: &str) -> Option<Definition> {
    provider::definitions()
        .into_iter()
        .find(|definition| definition.kind == kind)
}

/// OpenShell resource operations owned by this provider.
pub mod fabric;
pub use openshell_provider as openshell;

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
    use tf_provider::value::Value;
    #[test]
    fn incomplete_input_delivery_requires_an_explicit_apply_update() {
        let definition = services::inputs::definition();
        assert_eq!(
            definition.attributes().filter(|name| *name == "id").count(),
            1
        );
        let prior: State = [
            ("id".into(), Value::Value("bound".into())),
            ("complete".into(), Value::Value("false".into())),
        ]
        .into();
        let (planned, replacements) = plan_update(&definition, &prior, prior.clone());
        assert_eq!(planned["complete"], Value::Unknown);
        assert_eq!(planned["id"], Value::Unknown);
        assert!(replacements.is_empty());
        let mut complete = prior;
        complete.insert("complete".into(), Value::Value("true".into()));
        let (planned, replacements) = plan_update(&definition, &complete, complete.clone());
        assert_eq!(planned, complete);
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
