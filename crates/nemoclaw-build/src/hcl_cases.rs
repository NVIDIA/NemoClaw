// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! The live HCL E2E cases: each scenario in [`SCENARIOS`] with a case
//! document of the same name in [`DOCUMENTS`].

use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::Path,
};

type Result<T> = std::result::Result<T, String>;

/// The case documents, which live HCL scenarios and other tests deploy.
pub const DOCUMENTS: &str = "crates/nemoclaw-e2e/cases";
/// The live HCL scenarios.
pub const SCENARIOS: &str = "crates/nemoclaw-e2e/tests/e2e/hcl/tests";

/// A case's document and scenario.
pub fn files(id: &str) -> [String; 2] {
    [
        format!("{DOCUMENTS}/{id}.yaml"),
        format!("{SCENARIOS}/{id}.tftest.hcl"),
    ]
}

/// The live cases under `root`.
pub fn live(root: &Path) -> Result<BTreeSet<String>> {
    let scenarios = fs::read_dir(root.join(SCENARIOS))
        .map_err(|error| format!("cannot list {SCENARIOS}: {error}"))?;
    let mut ids = BTreeSet::new();
    for entry in scenarios {
        let name = entry.map_err(|error| error.to_string())?.file_name();
        let Some(id) = name
            .to_str()
            .and_then(|name| name.strip_suffix(".tftest.hcl"))
        else {
            continue;
        };
        let [document, _] = files(id);
        if root.join(document).is_file() {
            ids.insert(id.to_owned());
        }
    }
    Ok(ids)
}

/// Each live case's model runtime images, as Bake targets, read from its document.
pub fn runtimes(root: &Path) -> Result<BTreeMap<String, BTreeSet<&'static str>>> {
    live(root)?
        .into_iter()
        .map(|id| {
            let [document, _] = files(&id);
            let document = fs::read_to_string(root.join(&document))
                .map_err(|error| format!("cannot read {document}: {error}"))?;
            let targets = crate::images::runtime_targets(&document)
                .map_err(|error| format!("the {id} case: {error}"))?;
            Ok((id, targets))
        })
        .collect()
}
