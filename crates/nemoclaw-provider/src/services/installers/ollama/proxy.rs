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
impl ProxyBackend {
    pub(super) async fn proxy_read(
        &self,
        kind: &str,
        row: &Row,
        apply: bool,
    ) -> Result<Option<Row>, Error> {
        if !supports(kind) {
            return Err(ObservationError::Query.into());
        }
        let id = row.get("id").map(String::as_str).unwrap_or("");
        let mut result = row.clone();
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
        Err(ObservationError::Query.into())
    }
    pub(super) async fn proxy_remove(&self, kind: &str) -> Result<(), Error> {
        if kind == STORAGE {
            return Err(Error::Conflict("proxy credential storage is retained"));
        }
        Err(ObservationError::Query.into())
    }
}
