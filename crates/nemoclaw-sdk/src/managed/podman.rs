// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use super::Spec;
#[cfg(unix)]
use crate::ObservationError;
use crate::{Error, docker::Engine};
use bollard::models::ContainerInspectResponse;
#[cfg(any(unix, test))]
use serde_json::Value;

#[cfg(any(unix, test))]
fn no_capabilities(native: &Value, id: &str) -> Result<(), Error> {
    if native.get("Id").and_then(Value::as_str) != Some(id)
        || ["EffectiveCaps", "BoundingCaps"].iter().any(|key| {
            !native
                .get(key)
                .is_some_and(|caps| caps.is_null() || caps.as_array().is_some_and(Vec::is_empty))
        })
    {
        return Err(Error::Conflict(
            "Podman managed container capability protection drifted",
        ));
    }
    Ok(())
}

impl Engine {
    #[cfg(unix)]
    pub(crate) async fn podman_json(&self, path: &str) -> Result<Value, Error> {
        let client = reqwest::Client::builder()
            .no_proxy()
            .unix_socket(
                self.endpoint()
                    .strip_prefix("unix://")
                    .ok_or(ObservationError::Incomplete)?,
            )
            .timeout(std::time::Duration::from_secs(10))
            .build()
            .map_err(|_| ObservationError::Incomplete)?;
        let mut response = client
            .get(format!("http://localhost/v4.0.0/libpod/{path}"))
            .send()
            .await
            .and_then(reqwest::Response::error_for_status)
            .map_err(|_| ObservationError::Incomplete)?;
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| ObservationError::Incomplete)?
        {
            if bytes.len() + chunk.len() > 4 * 1024 * 1024 {
                return Err(ObservationError::Incomplete.into());
            }
            bytes.extend_from_slice(&chunk);
        }
        serde_json::from_slice(&bytes).map_err(|_| ObservationError::Incomplete.into())
    }

    pub(crate) async fn managed_container(
        &self,
        spec: &Spec,
        name: &str,
    ) -> Result<Option<ContainerInspectResponse>, Error> {
        let container = self.container(name).await?;
        if spec.compute_driver != "podman" || container.is_none() {
            return Ok(container);
        }
        #[cfg(unix)]
        {
            let mut container = container;
            let observed = container.as_mut().unwrap();
            let id = observed.id.as_deref().ok_or(ObservationError::Incomplete)?;
            if id.len() != 64 || !id.bytes().all(|c| c.is_ascii_hexdigit()) {
                return Err(ObservationError::Incomplete.into());
            }
            // Podman's compatibility API expands CapDrop=ALL into engine defaults.
            // Check the native effective/bounding sets rather than guessing defaults.
            let native = self.podman_json(&format!("containers/{id}/json")).await?;
            no_capabilities(&native, id)?;
            observed
                .host_config
                .as_mut()
                .ok_or(ObservationError::Incomplete)?
                .cap_drop = Some(vec!["ALL".into()]);
            if let Some(limits) = observed
                .host_config
                .as_mut()
                .and_then(|h| h.ulimits.as_mut())
            {
                for limit in limits {
                    if let Some(name) = limit.name.as_mut() {
                        *name = name
                            .strip_prefix("RLIMIT_")
                            .unwrap_or(name)
                            .to_ascii_lowercase();
                    }
                }
            }
            Ok(container)
        }
        #[cfg(not(unix))]
        Err(Error::Conflict(
            "local Podman requires a Unix socket platform",
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn native_capability_observation_requires_identity_and_both_empty_sets() {
        for empty in [Value::Null, json!([])] {
            let mut value = json!({"Id":"owned", "EffectiveCaps":empty,"BoundingCaps":empty});
            assert!(no_capabilities(&value, "owned").is_ok());
            assert!(no_capabilities(&value, "foreign").is_err());
            value["BoundingCaps"] = json!(["CAP_SYS_ADMIN"]);
            assert!(no_capabilities(&value, "owned").is_err());
            value.as_object_mut().unwrap().remove("BoundingCaps");
            assert!(no_capabilities(&value, "owned").is_err());
        }
    }
}
