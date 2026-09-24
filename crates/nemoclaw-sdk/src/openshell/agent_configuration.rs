// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::*;
use crate::{Error, backend::Mutation};
use serde_json::Value;

fn value<'a>(row: &'a Row, key: &str) -> &'a str {
    row.get(key).map(String::as_str).unwrap_or("")
}
fn configuration(encoded: &str) -> Result<String, ObservationError> {
    let parsed: nemo_fabric_core::FabricConfig =
        serde_json::from_str(encoded).map_err(|_| ObservationError::Query)?;
    serde_json::to_string(&parsed).map_err(|_| ObservationError::Query)
}

impl OpenShell {
    async fn configuration_parent(
        &self,
        want: &Row,
        removing: bool,
    ) -> Result<Option<Row>, ObservationError> {
        let Some(parent) = self
            .observe(
                "sandbox",
                value(want, "workspace"),
                value(want, "name"),
                removing,
            )
            .await?
        else {
            return if removing {
                Ok(None)
            } else {
                Err(ObservationError::BindingMismatch)
            };
        };
        let mut expected = want.clone();
        expected.insert("id".into(), value(want, "sandbox_id").into());
        verify_identity(&expected, &parent)?;
        if value(&parent, "agent_runtime") != "fabric" || value(want, "sandbox_id").is_empty() {
            return Err(ObservationError::BindingMismatch);
        }
        Ok(Some(parent))
    }
    pub(super) async fn plan_configuration(&self, want: &Row) -> Result<(), Error> {
        configuration(value(want, "config_json"))?;
        self.configuration_parent(want, false).await?;
        Ok(())
    }
    pub(super) async fn read_configuration(
        &self,
        prior: &Row,
        removing: bool,
    ) -> Result<Option<Row>, ObservationError> {
        let Some(parent) = self.configuration_parent(prior, removing).await? else {
            return Ok(None);
        };
        if value(prior, "id") != value(&parent, "id") {
            return Err(ObservationError::BindingMismatch);
        }
        if removing {
            return Ok(Some(prior.clone()));
        }
        let (exit, output) = self
            .exec_bound(
                &parent,
                vec![
                    "/opt/fabric/bin/python".into(),
                    "-c".into(),
                    include_str!("agent_status.py").into(),
                ],
                Row::new(),
                20,
            )
            .await
            .map_err(Error::into_observation)?;
        if exit != 0 {
            return Err(ObservationError::Query);
        }
        let status: Value =
            serde_json::from_slice(&output).map_err(|_| ObservationError::Incomplete)?;
        let ready = status["ready"]
            .as_bool()
            .ok_or(ObservationError::Incomplete)?;
        let config = status.get("config").ok_or(ObservationError::Incomplete)?;
        if status.get("runtime_id").is_none() {
            return Err(ObservationError::Incomplete);
        }
        let mut row = prior.clone();
        row.insert("running".into(), ready.to_string());
        if config.is_null() && !ready {
            return Ok(Some(row));
        }
        if config["metadata"]["name"] != value(&parent, "agent_name") {
            return Err(ObservationError::BindingMismatch);
        }
        if ready && status["runtime_id"].as_str().is_none_or(str::is_empty) {
            return Err(ObservationError::Incomplete);
        }
        let observed = config.to_string();
        if configuration(value(prior, "config_json"))? != configuration(&observed)? {
            row.insert("config_json".into(), observed.clone());
        }
        if ready {
            let mut binding = parent;
            binding.insert("config_json".into(), observed);
            self.configuration(&binding)
                .await
                .map_err(Error::into_observation)?;
        }
        Ok(Some(row))
    }
    pub(super) async fn ensure_configuration(&self, desired: &Row) -> Mutation {
        let result = async {
            configuration(value(desired, "config_json"))?;
            let encoded = value(desired, "config_json").to_owned();
            let mut parent = self
                .configuration_parent(desired, false)
                .await?
                .ok_or(ObservationError::BindingMismatch)?;
            if !value(desired, "id").is_empty() && value(desired, "id") != parent["id"] {
                return Err(ObservationError::BindingMismatch);
            }
            parent.insert("config_json".into(), encoded);
            self.configure_agent(&parent, false)
                .await
                .map_err(Error::into_observation)?;
            let mut row = desired.clone();
            row.insert("id".into(), parent["id"].clone());
            row.insert("running".into(), "true".into());
            let observed = self
                .read_configuration(&row, false)
                .await?
                .ok_or(ObservationError::Incomplete)?;
            if configuration(&observed["config_json"])?
                != configuration(value(desired, "config_json"))?
                || observed["running"] != "true"
            {
                return Err(ObservationError::Incomplete);
            }
            // Preserve the configured JSON spelling after semantic readback.
            Ok(row)
        }
        .await;
        match result {
            Ok(row) => Mutation::complete(row),
            Err(error) => Mutation::failed(error),
        }
    }
    pub(super) async fn remove_configuration(
        &self,
        prior: &Row,
        _destroying: bool,
    ) -> Result<(), ObservationError> {
        self.read_configuration(prior, true).await?;
        // The sandbox owns this runtime. Forgetting its configuration binding
        // must not mutate or delete a runtime independently of that sandbox.
        Ok(())
    }
}
