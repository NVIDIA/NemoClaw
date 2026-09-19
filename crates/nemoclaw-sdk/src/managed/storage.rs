// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
#[cfg(all(test, unix))]
#[path = "storage_tests.rs"]
mod tests;

use super::{GENERATION_LABEL, OWNER_LABEL};
use crate::{
    Error, ObservationError,
    docker::{Engine, remote},
};
use bollard::models::VolumeCreateRequest;
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, time::Duration};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase", deny_unknown_fields)]
pub struct Storage {
    pub name: String,
    pub owner: String,
    pub generation: String,
    pub engine: String,
}
impl Storage {
    pub fn validate(&self) -> Result<(), Error> {
        if !regex::Regex::new(r"^nc-[a-f0-9]{16}-[a-z][a-z0-9-]{0,72}-(data|auth)$")
            .unwrap()
            .is_match(&self.name)
            || !regex::Regex::new(r"^[a-f0-9-]{36}$")
                .unwrap()
                .is_match(&self.owner)
            || !regex::Regex::new(r"^[a-f0-9]{32}$")
                .unwrap()
                .is_match(&self.generation)
            || crate::docker::Engine::validate_endpoint(&self.engine).is_err()
        {
            return Err(Error::Conflict(
                "storage lacks explicit ownership, generation, or engine",
            ));
        }
        Ok(())
    }
    pub fn json(&self) -> Result<String, Error> {
        self.validate()?;
        serde_json::to_string(self)
            .map_err(|_| Error::State("cannot serialize storage specification"))
    }
    fn labels(&self) -> HashMap<String, String> {
        [
            (OWNER_LABEL.into(), self.owner.clone()),
            (GENERATION_LABEL.into(), self.generation.clone()),
        ]
        .into()
    }
    pub async fn observe(&self, engine: &Engine, id: &str) -> Result<Option<String>, Error> {
        self.validate()?;
        if engine.endpoint() != self.engine {
            return Err(Error::Conflict(
                "storage engine differs from its explicit specification",
            ));
        }
        let work = async {
            let info = engine.info().await?;
            let Some(volume) = engine.volume(&self.name).await? else {
                return if id.is_empty() {
                    Ok(None)
                } else {
                    Err(Error::Conflict(
                        "bound model storage is absent; recreation forbidden",
                    ))
                };
            };
            for (key, value) in self.labels() {
                if volume.labels.get(&key) != Some(&value) {
                    return Err(ObservationError::BindingMismatch.into());
                }
            }
            let created = volume
                .created_at
                .as_ref()
                .filter(|value| !value.is_empty())
                .ok_or(ObservationError::Incomplete)?;
            if volume.name != self.name || volume.driver != "local" || !volume.options.is_empty() {
                return Err(Error::Conflict("model storage configuration drifted"));
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
    pub async fn ensure(&self, engine: &Engine, id: &str) -> Result<String, Error> {
        if let Some(actual) = self.observe(engine, id).await? {
            return Ok(actual);
        }
        // A named create may return an existing volume. Re-observe after the
        // mutation to verify that the volume has our ownership labels.
        engine
            .api
            .create_volume(VolumeCreateRequest {
                name: Some(self.name.clone()),
                driver: Some("local".into()),
                labels: Some(self.labels()),
                ..Default::default()
            })
            .await
            .map_err(|error| remote(&error))?;
        self.observe(engine, id).await?.ok_or(Error::Conflict(
            "cannot observe model storage after creation; keep the state directory and run apply again with the same configuration",
        ))
    }
}
