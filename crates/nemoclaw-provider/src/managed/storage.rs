// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
#[cfg(all(test, unix))]
#[path = "storage_tests.rs"]
mod tests;
use super::{GENERATION_LABEL, OWNER_LABEL, Storage};
use crate::{
    Error, ObservationError,
    docker::{Engine, remote},
};
use bollard::models::VolumeCreateRequest;
use std::{collections::HashMap, time::Duration};
fn labels(storage: &Storage) -> HashMap<String, String> {
    [
        (OWNER_LABEL.into(), storage.owner.clone()),
        (GENERATION_LABEL.into(), storage.generation.clone()),
    ]
    .into()
}
pub async fn observe_storage(
    storage: &Storage,
    engine: &Engine,
    id: &str,
) -> Result<Option<String>, Error> {
    storage.validate()?;
    if engine.endpoint() != storage.engine {
        return Err(Error::Conflict(
            "storage engine differs from its explicit specification",
        ));
    }
    let work = async {
        let info = engine.info().await?;
        let Some(volume) = engine.volume(&storage.name).await? else {
            return if id.is_empty() {
                Ok(None)
            } else {
                Err(Error::Conflict(
                    "bound persistent storage is absent; recreation forbidden",
                ))
            };
        };
        for (key, value) in labels(storage) {
            if volume.labels.get(&key) != Some(&value) {
                return Err(ObservationError::BindingMismatch.into());
            }
        }
        let created = volume
            .created_at
            .as_ref()
            .filter(|value| !value.is_empty())
            .ok_or(ObservationError::Incomplete)?;
        if volume.name != storage.name || volume.driver != "local" || !volume.options.is_empty() {
            return Err(Error::Conflict("persistent storage configuration drifted"));
        }
        let actual = format!(
            "{}/{}/{}",
            info.id.ok_or(ObservationError::Incomplete)?,
            volume.name,
            created
        );
        if !id.is_empty() && id != actual {
            return Err(ObservationError::BindingMismatch.into());
        }
        Ok(Some(actual))
    };
    tokio::time::timeout(Duration::from_secs(20), work)
        .await
        .map_err(|_| ObservationError::Transport)?
}
pub async fn ensure_storage(storage: &Storage, engine: &Engine, id: &str) -> Result<String, Error> {
    if let Some(actual) = observe_storage(storage, engine, id).await? {
        return Ok(actual);
    }
    // A named create may return an existing volume. Re-observe after the
    // mutation to verify that the volume has our ownership labels.
    engine
        .api
        .create_volume(VolumeCreateRequest {
            name: Some(storage.name.clone()),
            driver: Some("local".into()),
            labels: Some(labels(storage)),
            ..Default::default()
        })
        .await
        .map_err(|error| remote(&error))?;
    observe_storage(storage, engine, id).await?.ok_or(Error::Conflict(
            "cannot observe persistent storage after creation; keep the state directory and run apply again with the same configuration",
        ))
}
