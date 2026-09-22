// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use crate::Error;
use serde::Deserialize;
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

/// Project public OpenTofu show values (state or planned values), not internal state.
pub(crate) fn parse_resources(values: &Value) -> Result<BTreeMap<String, Value>, Error> {
    #[derive(Deserialize, Default)]
    struct Module {
        #[serde(default)]
        resources: Vec<Resource>,
        #[serde(default)]
        child_modules: Vec<Module>,
    }
    #[derive(Deserialize)]
    struct Resource {
        address: String,
        mode: String,
        #[serde(default)]
        deposed_key: Option<String>,
        values: Value,
    }
    let root: Module = serde_json::from_value(values["root_module"].clone())
        .map_err(|_| Error::State("incomplete OpenTofu observed values"))?;
    let mut modules = vec![root];
    let mut seen = BTreeSet::new();
    let mut resources = BTreeMap::new();
    while let Some(module) = modules.pop() {
        modules.extend(module.child_modules);
        for resource in module.resources {
            if resource.address.is_empty()
                || !matches!(resource.mode.as_str(), "managed" | "data")
                || !resource.values.is_object()
                || !seen.insert((resource.address.clone(), resource.deposed_key.clone()))
            {
                return Err(Error::State("duplicate or incomplete OpenTofu observation"));
            }
            if resource.deposed_key.is_none() {
                resources.insert(resource.address, resource.values);
            }
        }
    }
    Ok(resources)
}
