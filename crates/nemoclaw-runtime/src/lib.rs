// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
pub mod config;
mod error;
pub use error::Error;
pub mod files;
pub mod hardware;
pub mod ollama;
pub mod schema;
pub mod snapshot;
pub mod vllm;
pub use tokio_util::sync::CancellationToken;
#[cfg(all(feature = "execution", target_os = "linux"))]
mod execution;
#[cfg(all(feature = "execution", target_os = "linux"))]
pub use execution::run;
#[derive(
    Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize, schemars::JsonSchema,
)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum RuntimeSpec {
    Vllm(Box<vllm::Service>),
    Ollama(Box<ollama::ManagedOllama>),
}
impl RuntimeSpec {
    pub fn decode(text: &str) -> Result<Self, Error> {
        let spec: Self = serde_json::from_str(text)
            .map_err(|_| Error::State("invalid pinned runtime specification"))?;
        match &spec {
            Self::Vllm(s) => s.validate()?,
            Self::Ollama(s) => s.validate()?,
        };
        Ok(spec)
    }
}
fn require(condition: bool, message: &'static str) -> Result<(), config::ConfigError> {
    if condition {
        Ok(())
    } else {
        Err(config::ConfigError::new(message))
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
pub enum ObservationError {
    #[error("observation authentication failed")]
    Authentication,
    #[error("observation permission denied")]
    Permission,
    #[error("observation query failed")]
    Query,
    #[error("observation is incomplete")]
    Incomplete,
    #[error("observation transport failed")]
    Transport,
}
#[cfg(all(test, feature = "execution", target_os = "linux"))]
fn fixture() -> vllm::Service {
    let mut value: serde_json::Value =
        serde_saphyr::from_str(include_str!("../tests/fixtures/vllm.yaml")).unwrap();
    value.as_object_mut().unwrap().remove("kind");
    let mut service: vllm::Service = serde_json::from_value(value).unwrap();
    service.defaults();
    service.validate().unwrap();
    service
}
