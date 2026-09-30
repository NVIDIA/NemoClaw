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
            || crate::config::validate_engine_endpoint(&self.engine).is_err()
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
}
