// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! A sandbox's driver configuration: OpenShell's `SandboxTemplate.driver_config`,
//! passed through unchanged.

use nemoclaw_backend::ObservationError;

/// The driver configuration a sandbox requests, or none when the input is
/// empty.
pub(crate) fn request(json: &str) -> Result<Option<prost_types::Struct>, ObservationError> {
    if json.is_empty() {
        return Ok(None);
    }
    let Ok(serde_json::Value::Object(object)) = serde_json::from_str(json) else {
        return Err(ObservationError::Query);
    };
    openshell_core::proto_struct::json_object_to_struct(object)
        .map(Some)
        .map_err(|_| ObservationError::Query)
}

/// The input an observed driver configuration corresponds to: canonical JSON,
/// or empty when there is none.
pub(crate) fn observed(config: Option<&prost_types::Struct>) -> String {
    match config {
        Some(config) if !config.fields.is_empty() => {
            whole(openshell_core::proto_struct::struct_to_json_value(config)).to_string()
        }
        _ => String::new(),
    }
}

/// OpenShell stores every number as a double; write whole ones as integers,
/// as OpenTofu does, so an unchanged input plans no change.
fn whole(value: serde_json::Value) -> serde_json::Value {
    use serde_json::Value;
    match value {
        Value::Number(number) => match number.as_f64() {
            // Exactly representable whole numbers are below 2^53.
            Some(float) if float.fract() == 0.0 && float.abs() < 9_007_199_254_740_992.0 => {
                Value::from(float as i64)
            }
            _ => Value::Number(number),
        },
        Value::Array(values) => Value::Array(values.into_iter().map(whole).collect()),
        Value::Object(object) => Value::Object(
            object
                .into_iter()
                .map(|(key, value)| (key, whole(value)))
                .collect(),
        ),
        value => value,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MOUNT: &str = r#"{"docker":{"mounts":[{"read_only":false,"source":"skills","target":"/sandbox/skills","type":"volume"}],"tmpfs_bytes":1048576}}"#;

    #[test]
    fn a_driver_configuration_round_trips_through_the_gateway() {
        let config = request(MOUNT).unwrap().unwrap();
        // OpenShell stores every number as a double; reading it back keeps
        // whole numbers whole so an unchanged input plans no change.
        assert_eq!(observed(Some(&config)), MOUNT);
    }

    #[test]
    fn no_driver_configuration_is_omitted_both_ways() {
        assert_eq!(request("").unwrap(), None);
        assert_eq!(observed(None), "");
        assert_eq!(observed(Some(&prost_types::Struct::default())), "");
    }

    #[test]
    fn fractions_stay_fractions() {
        let config = request(r#"{"vm":{"ratio":0.5}}"#).unwrap().unwrap();
        assert_eq!(observed(Some(&config)), r#"{"vm":{"ratio":0.5}}"#);
    }

    #[test]
    fn a_driver_configuration_must_be_an_object_openshell_can_hold() {
        for json in [
            "[]",
            "\"docker\"",
            "{",
            r#"{"docker":{"n":18446744073709551615}}"#,
        ] {
            assert!(request(json).is_err(), "{json}");
        }
    }
}
