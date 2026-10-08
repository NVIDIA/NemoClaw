// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Retained volumes: their identity, ownership labels, and observation.
#[cfg(all(test, unix, feature = "client"))]
#[path = "storage_tests.rs"]
mod tests;

/// Label carrying the owner of a NemoClaw-managed engine object.
pub const OWNER_LABEL: &str = "nemoclaw.nvidia.com/uid";
/// Label carrying the generation of a NemoClaw-managed engine object.
pub const GENERATION_LABEL: &str = "nemoclaw.nvidia.com/generation";

use nemoclaw_backend::{Error, ObservationError, Row};
use serde::{Deserialize, Serialize};
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase", deny_unknown_fields)]
pub struct Storage {
    pub name: String,
    pub owner: String,
    pub generation: String,
    pub engine: String,
}
impl Storage {
    /// Attributes of a storage resource, in schema order.
    pub const ATTRIBUTES: [&str; 4] = ["name", "owner", "generation", "engine"];

    /// Check one storage attribute, explaining a rejected value without echoing it.
    pub fn check(attribute: &str, value: &str) -> Result<(), &'static str> {
        let (pattern, requirement) = match attribute {
            "name" => (
                r"^[A-Za-z0-9][A-Za-z0-9_.-]{1,254}$",
                "must be 2 to 255 letters, digits, underscores, periods, or hyphens, starting with a letter or digit",
            ),
            "owner" => (r"^[a-f0-9-]{36}$", "must be a lowercase UUID"),
            "generation" => (
                r"^[a-f0-9]{32}$",
                "must be 32 lowercase hexadecimal characters",
            ),
            "engine" => {
                return crate::validate_engine_endpoint(value)
                    .map_err(|_| "must be a supported Docker or Podman engine endpoint");
            }
            _ => return Err("is not a storage attribute"),
        };
        if regex::Regex::new(pattern).unwrap().is_match(value) {
            Ok(())
        } else {
            Err(requirement)
        }
    }
    pub fn validate(&self) -> Result<(), Error> {
        if Self::ATTRIBUTES
            .into_iter()
            .zip([&self.name, &self.owner, &self.generation, &self.engine])
            .any(|(attribute, value)| Self::check(attribute, value).is_err())
        {
            return Err(Error::Conflict(
                "storage lacks explicit ownership, generation, or engine",
            ));
        }
        Ok(())
    }
    /// A random version 4 UUID for an omitted owner.
    pub fn generate_owner() -> Result<String, Error> {
        let mut bytes = random()?;
        bytes[6] = (bytes[6] & 0x0f) | 0x40;
        bytes[8] = (bytes[8] & 0x3f) | 0x80;
        let hex = hex(&bytes);
        Ok(format!(
            "{}-{}-{}-{}-{}",
            &hex[..8],
            &hex[8..12],
            &hex[12..16],
            &hex[16..20],
            &hex[20..]
        ))
    }
    /// A random generation for omitted storage identity.
    pub fn generate_generation() -> Result<String, Error> {
        Ok(hex(&random()?))
    }
    /// Resource attributes for this storage.
    pub fn row(&self) -> Result<Row, Error> {
        self.validate()?;
        Ok(Self::ATTRIBUTES
            .into_iter()
            .map(String::from)
            .zip([&self.name, &self.owner, &self.generation, &self.engine].map(String::clone))
            .collect())
    }
    /// Storage named by resource attributes.
    pub fn from_row(row: &Row) -> Result<Self, Error> {
        let get = |attribute| {
            row.get(attribute)
                .cloned()
                .ok_or(ObservationError::Incomplete)
        };
        let storage = Self {
            name: get("name")?,
            owner: get("owner")?,
            generation: get("generation")?,
            engine: get("engine")?,
        };
        storage.validate()?;
        Ok(storage)
    }
    pub fn json(&self) -> Result<String, Error> {
        self.validate()?;
        serde_json::to_string(self)
            .map_err(|_| Error::State("cannot serialize storage specification"))
    }
}

fn random() -> Result<[u8; 16], Error> {
    let mut bytes = [0_u8; 16];
    getrandom::fill(&mut bytes).map_err(|_| Error::State("cannot generate storage identity"))?;
    Ok(bytes)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[cfg(feature = "client")]
mod operations {
    use super::{GENERATION_LABEL, OWNER_LABEL, Storage};
    use bollard::models::VolumeCreateRequest;
    use nemoclaw_backend::{Error, ObservationError};
    use std::{collections::HashMap, time::Duration};
    pub(super) fn labels(storage: &Storage) -> HashMap<String, String> {
        [
            (OWNER_LABEL.into(), storage.owner.clone()),
            (GENERATION_LABEL.into(), storage.generation.clone()),
        ]
        .into()
    }
    pub async fn observe_storage(
        storage: &Storage,
        engine: &crate::Engine,
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
            if volume.name != storage.name || volume.driver != "local" || !volume.options.is_empty()
            {
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
    pub async fn ensure_storage(
        storage: &Storage,
        engine: &crate::Engine,
        id: &str,
    ) -> Result<String, Error> {
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
            .map_err(|error| crate::remote(&error))?;
        observe_storage(storage, engine, id).await?.ok_or(Error::Conflict(
                "cannot observe persistent storage after creation; keep the state directory and run apply again with the same configuration",
            ))
    }
}
#[cfg(all(test, feature = "client"))]
use operations::labels;
#[cfg(feature = "client")]
pub use operations::{ensure_storage, observe_storage};
