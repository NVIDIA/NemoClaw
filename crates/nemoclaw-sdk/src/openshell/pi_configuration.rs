// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::*;
use crate::{Error, backend::Mutation, config::Overrides};
use serde_json::{Value, json};

fn value<'a>(row: &'a Row, key: &str) -> &'a str {
    row.get(key).map(String::as_str).unwrap_or("")
}
fn observation(error: Error) -> ObservationError {
    match error {
        Error::Observation(error) => error,
        _ => ObservationError::Query,
    }
}
fn model(encoded: &str) -> Result<String, ObservationError> {
    let raw: Value = serde_json::from_str(encoded).map_err(|_| ObservationError::Query)?;
    if raw
        .as_object()
        .is_none_or(|fields| fields.keys().any(|key| key != "model" && key != "piModel"))
    {
        return Err(ObservationError::Query);
    }
    if raw
        .get("piModel")
        .is_some_and(|metadata| !metadata.is_object())
    {
        return Err(ObservationError::Query);
    }
    let parsed: Overrides =
        serde_json::from_value(raw.clone()).map_err(|_| ObservationError::Query)?;
    if !crate::config::validation::valid_model(&parsed.model) {
        return Err(ObservationError::Query);
    }
    Ok(raw.to_string())
}

impl OpenShell {
    async fn pi_parent(&self, want: &Row, removing: bool) -> Result<Option<Row>, ObservationError> {
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
        if value(&parent, "agent_runtime") != "fabric-pi" || value(want, "sandbox_id").is_empty() {
            return Err(ObservationError::BindingMismatch);
        }
        Ok(Some(parent))
    }
    pub(super) async fn plan_pi(&self, want: &Row) -> Result<(), Error> {
        model(value(want, "model_json"))?;
        self.pi_parent(want, false).await?;
        Ok(())
    }
    pub(super) async fn read_pi(
        &self,
        prior: &Row,
        removing: bool,
    ) -> Result<Option<Row>, ObservationError> {
        let Some(parent) = self.pi_parent(prior, removing).await? else {
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
                    include_str!("pi_status.py").into(),
                ],
                Row::new(),
                20,
            )
            .await
            .map_err(observation)?;
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
        if config["metadata"]["name"] != value(&parent, "agent_name")
            || config["harness"]["adapter_id"] != "nvidia.fabric.pi"
        {
            return Err(ObservationError::BindingMismatch);
        }
        if ready && status["runtime_id"].as_str().is_none_or(str::is_empty) {
            return Err(ObservationError::Incomplete);
        }
        let selected = &config["models"]["default"];
        let mut selected_model = json!({"model":selected["model"]});
        if let Some(metadata) = selected
            .get("settings")
            .and_then(|s| s.get("model_metadata"))
        {
            selected_model["piModel"] = metadata.clone();
        }
        let observed = model(&selected_model.to_string())?;
        if model(value(prior, "model_json"))? != observed {
            row.insert("model_json".into(), observed.clone());
        }
        if ready {
            let mut binding = parent;
            binding.insert("pi_model_config".into(), observed);
            self.configuration(&binding).await.map_err(observation)?;
        }
        Ok(Some(row))
    }
    pub(super) async fn ensure_pi(&self, desired: &Row) -> Mutation {
        let result = async {
            let encoded = model(value(desired, "model_json"))?;
            let mut parent = self
                .pi_parent(desired, false)
                .await?
                .ok_or(ObservationError::BindingMismatch)?;
            if !value(desired, "id").is_empty() && value(desired, "id") != parent["id"] {
                return Err(ObservationError::BindingMismatch);
            }
            parent.insert("pi_model_config".into(), encoded);
            self.configure_pi(&parent, false)
                .await
                .map_err(observation)?;
            let mut row = desired.clone();
            row.insert("id".into(), parent["id"].clone());
            row.insert("running".into(), "true".into());
            let observed = self
                .read_pi(&row, false)
                .await?
                .ok_or(ObservationError::Incomplete)?;
            if model(&observed["model_json"])? != model(value(desired, "model_json"))?
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
    pub(super) async fn remove_pi(
        &self,
        prior: &Row,
        destroying: bool,
    ) -> Result<(), ObservationError> {
        if !destroying {
            return Err(ObservationError::Query);
        }
        self.read_pi(prior, true).await?;
        // The sandbox owns this runtime. Forgetting its configuration binding
        // must not mutate or delete a runtime independently of that sandbox.
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn model_contract_rejects_invalid_metadata_without_hiding_nested_nulls() {
        for invalid in [
            r#"{"model":"valid","piModel":null}"#,
            r#"{"model":"valid","piModel":[]}"#,
            r#"{"model":""}"#,
            r#"{"model":"valid","unknown":true}"#,
        ] {
            assert!(model(invalid).is_err(), "{invalid}");
        }
        assert_eq!(
            model(r#"{ "piModel": {"nested": [null]}, "model": "custom" }"#).unwrap(),
            r#"{"model":"custom","piModel":{"nested":[null]}}"#
        );
    }
}
