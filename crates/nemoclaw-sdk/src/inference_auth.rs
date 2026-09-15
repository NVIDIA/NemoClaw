// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use crate::{Error, ObservationError, docker::Engine, ollama::ServiceSpec};
use serde::{Deserialize, Serialize};
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub(crate) enum Source {
    OllamaProxy { engine: String, spec: ServiceSpec },
}
impl Source {
    pub fn parse(value: &str, owner: &str, endpoint: &str) -> Result<Self, ObservationError> {
        let source: Self = serde_json::from_str(value).map_err(|_| ObservationError::Incomplete)?;
        match &source {
            Self::OllamaProxy { engine, spec }
                if engine.starts_with("unix:///")
                    && Engine::validate_endpoint(engine).is_ok()
                    && spec.validate().is_ok()
                    && spec.owner == owner
                    && spec.proxy.as_ref().is_some_and(|p| p.endpoint == endpoint) => {}
            _ => return Err(ObservationError::BindingMismatch),
        }
        Ok(source)
    }
    pub async fn resolve(&self) -> Result<String, ObservationError> {
        let work = async {
            match self {
                Self::OllamaProxy { engine, spec } => {
                    let engine = Engine::connect(engine)?;
                    let observed = engine
                        .observe_ollama(spec, "")
                        .await?
                        .ok_or(Error::Conflict("credential source is absent"))?;
                    let id = observed
                        .id
                        .split('/')
                        .nth(1)
                        .ok_or(Error::State("invalid credential source identity"))?;
                    read_key(&engine, id).await
                }
            }
        };
        work.await.map_err(|_| ObservationError::Authentication)
    }
}
pub(crate) async fn read_key(engine: &Engine, id: &str) -> Result<String, Error> {
    let path = "/data/inference-key";
    let stat = engine
        .stat_file(id, path)
        .await?
        .ok_or(Error::State("managed inference credential is missing"))?;
    if stat.size != 64
        || stat.file_mode & 0o777 != 0o600
        || stat.file_mode & !0o777 != 0
        || !stat.link_target.is_empty()
    {
        return Err(Error::State(
            "managed inference credential metadata is invalid",
        ));
    }
    let bytes = engine
        .read_file(id, path, 64)
        .await?
        .ok_or(Error::State("managed inference credential is missing"))?;
    if bytes.len() != 64
        || !bytes
            .iter()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(b))
    {
        return Err(Error::State("managed inference credential is invalid"));
    }
    String::from_utf8(bytes).map_err(|_| Error::State("managed inference credential is invalid"))
}
