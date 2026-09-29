// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use super::*;
use crate::{Error, ObservationError, backend::Row};
pub async fn verify_model(settings: &ProxySettings) -> Result<(), Error> {
    let model = Models::new(&settings.upstream)?
        .read(&settings.model)
        .await?
        .ok_or(Error::Conflict(
            "external Ollama model is absent; installation is not managed",
        ))?;
    if model.digest != settings.digest {
        return Err(Error::Conflict("external Ollama model digest changed"));
    }
    Ok(())
}
fn auxiliary_storage(row: &Row) -> Result<crate::managed::Storage, Error> {
    let get = |field| {
        row.get(field)
            .filter(|value| !value.is_empty())
            .cloned()
            .ok_or(ObservationError::Incomplete)
    };
    let storage = crate::managed::Storage {
        name: format!("{}-auth", get("name")?),
        owner: get("owner")?,
        generation: get("generation")?,
        engine: get("engine")?,
    };
    storage.validate()?;
    Ok(storage)
}
fn model_settings(row: &Row) -> Result<ProxySettings, Error> {
    let get = |field| {
        row.get(field)
            .filter(|value| !value.is_empty())
            .cloned()
            .ok_or(ObservationError::Incomplete)
    };
    let settings = ProxySettings {
        upstream: get("upstream")?,
        model: get("model")?,
        digest: get("digest")?,
        endpoint: String::new(),
    };
    Models::new(&settings.upstream)?;
    let upstream = url::Url::parse(&settings.upstream).map_err(|_| ObservationError::Incomplete)?;
    if upstream.port().is_none()
        || !match upstream.host() {
            Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
            Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
            _ => false,
        }
        || !regex::Regex::new(nemoclaw_sdk::services::installers::ollama::MODEL_PATTERN)
            .unwrap()
            .is_match(&settings.model)
        || !regex::Regex::new("^[a-f0-9]{64}$")
            .unwrap()
            .is_match(&settings.digest)
    {
        return Err(Error::Conflict("invalid external Ollama model observation"));
    }
    Ok(settings)
}
impl ProxyBackend {
    pub(super) async fn proxy_read(
        &self,
        kind: &str,
        row: &Row,
        apply: bool,
        removing: bool,
    ) -> Result<Option<Row>, Error> {
        if !supports(kind) {
            return Err(ObservationError::Query.into());
        }
        let id = row.get("id").map(String::as_str).unwrap_or("");
        let mut result = row.clone();
        if kind == MODEL {
            let storage = auxiliary_storage(row)?;
            let settings = model_settings(row)?;
            if !removing {
                verify_model(&settings).await?;
            }
            let expected = format!(
                "{}/{}/{}",
                storage.owner, storage.generation, settings.digest
            );
            if !id.is_empty() && id != expected {
                return Err(ObservationError::BindingMismatch.into());
            }
            result.insert("id".into(), expected);
            return Ok(Some(result));
        }
        if kind == STORAGE {
            let storage = auxiliary_storage(row)?;
            let observed = if apply {
                Some(crate::managed::ensure_storage(&storage, &self.engine, id).await?)
            } else {
                crate::managed::observe_storage(&storage, &self.engine, id).await?
            };
            return Ok(observed.map(|id| {
                result.insert("id".into(), id);
                result
            }));
        }
        Err(Error::State(
            "proxy lifecycle belongs to the Docker provider",
        ))
    }
    pub(super) async fn proxy_remove(&self, kind: &str, row: &Row) -> Result<(), Error> {
        if kind == STORAGE {
            return Err(Error::Conflict("proxy credential storage is retained"));
        }
        if kind == MODEL {
            self.proxy_read(kind, row, false, true).await?;
            return Ok(());
        }
        if !supports(kind) {
            return Err(ObservationError::Query.into());
        }
        Err(Error::State(
            "proxy lifecycle belongs to the Docker provider",
        ))
    }
}
