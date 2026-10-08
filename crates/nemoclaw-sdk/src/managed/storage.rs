// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use crate::Error;
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
                r"^nc-[a-f0-9]{16}-[a-z][a-z0-9-]{0,72}-(data|auth)$",
                "must be nc-, 16 lowercase hexadecimal characters, a service name, and -data or -auth",
            ),
            "owner" => (r"^[a-f0-9-]{36}$", "must be a lowercase UUID"),
            "generation" => (
                r"^[a-f0-9]{32}$",
                "must be 32 lowercase hexadecimal characters",
            ),
            "engine" => {
                return crate::config::validate_engine_endpoint(value)
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
    /// Resource attributes for this storage.
    pub fn row(&self) -> Result<crate::backend::Row, Error> {
        self.validate()?;
        Ok(Self::ATTRIBUTES
            .into_iter()
            .map(String::from)
            .zip([&self.name, &self.owner, &self.generation, &self.engine].map(String::clone))
            .collect())
    }
    /// Storage named by resource attributes.
    pub fn from_row(row: &crate::backend::Row) -> Result<Self, Error> {
        let get = |attribute| {
            row.get(attribute)
                .cloned()
                .ok_or(crate::ObservationError::Incomplete)
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
