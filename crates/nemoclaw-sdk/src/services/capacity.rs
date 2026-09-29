// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use crate::{Error, backend::Row, managed::Spec};
use std::collections::BTreeMap;
pub(crate) fn observation_name(engine: &str) -> String {
    use sha2::{Digest, Sha256};
    format!(
        "engine_{}",
        Sha256::digest(engine.as_bytes())
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    )
}
pub(crate) fn observation_address(engine: &str) -> String {
    format!(
        "data.nemoclaw_service_capacity.{}",
        observation_name(engine)
    )
}
/// Derive groups solely from declared managed processes, never from live inventory.
pub(crate) fn groups<'a>(
    rows: impl IntoIterator<Item = (&'a str, &'a Row)>,
) -> Result<BTreeMap<String, Vec<String>>, Error> {
    let mut groups: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for (address, row) in rows {
        let kind = address
            .split_once('.')
            .map(|(kind, _)| kind.trim_start_matches("nemoclaw_"))
            .unwrap_or("");
        if !super::resource_behavior(kind).runtime_process {
            continue;
        }
        let encoded = row
            .get("spec")
            .ok_or(Error::State("capacity specification is missing"))?;
        super::validate_resource_spec(kind, encoded)?;
        let spec: Spec = serde_json::from_str(encoded)
            .map_err(|_| Error::State("invalid capacity specification"))?;
        groups
            .entry(spec.engine().into())
            .or_default()
            .push(encoded.clone());
    }
    Ok(groups)
}
