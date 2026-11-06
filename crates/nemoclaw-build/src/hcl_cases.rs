// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! The live HCL E2E cases: each scenario in [`SCENARIOS`] with a case
//! document of the same name in [`DOCUMENTS`], and where each one runs.

use serde_json::Value;
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
/// The variable through which a case reads the NVIDIA API key, which only
/// the hosted and GPU jobs provide.
pub const NVIDIA_KEY: &str = "NVIDIA_INFERENCE_API_KEY";

/// Where a live case runs.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Runner {
    /// `cargo ci live-docker`, which binds the case to its run.
    LiveDocker,
    /// `cargo ci live-kind`, on its kind cluster.
    LiveKind,
    /// A job with the NVIDIA API key.
    Hosted,
    /// Live / HCL on the NVIDIA GPU runner.
    Gpu,
}

impl Runner {
    /// The name the selection and `--hcl-cases` use.
    pub fn name(self) -> &'static str {
        match self {
            Runner::LiveDocker => "live-docker",
            Runner::LiveKind => "live-kind",
            Runner::Hosted => "hosted",
            Runner::Gpu => "gpu",
        }
    }

    pub const ALL: [Runner; 4] = [
        Runner::LiveDocker,
        Runner::LiveKind,
        Runner::Hosted,
        Runner::Gpu,
    ];
}

/// What a case needs from the job that runs it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Needs {
    pub runner: Runner,
    /// Whether the case reads [`NVIDIA_KEY`].
    pub nvidia_key: bool,
}

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

/// Each live case's document.
fn documents(root: &Path) -> Result<BTreeMap<String, String>> {
    live(root)?
        .into_iter()
        .map(|id| {
            let [document, _] = files(&id);
            let document = fs::read_to_string(root.join(&document))
                .map_err(|error| format!("cannot read {document}: {error}"))?;
            Ok((id, document))
        })
        .collect()
}

/// Each live case's model runtime images, as Bake targets, read from its document.
pub fn runtimes(root: &Path) -> Result<BTreeMap<String, BTreeSet<&'static str>>> {
    documents(root)?
        .into_iter()
        .map(|(id, document)| {
            let targets = crate::images::runtime_targets(&document)
                .map_err(|error| format!("the {id} case: {error}"))?;
            Ok((id, targets))
        })
        .collect()
}

/// What a case document needs from the job that runs it. A Kubernetes or
/// OpenShift gateway needs the kind cluster; otherwise a managed model
/// runtime image needs the GPU runner, and reading the NVIDIA API key needs
/// a hosted job. Every other case runs in the Docker live suite.
pub fn needs(document: &str) -> Result<Needs> {
    let parsed: Value =
        serde_saphyr::from_str(document).map_err(|error| format!("invalid document: {error}"))?;
    let spec = &parsed["spec"];
    let nvidia_key = spec["inferenceProviders"]
        .as_object()
        .into_iter()
        .flat_map(|providers| providers.values())
        .any(|provider| provider["credential"]["env"] == NVIDIA_KEY);
    let runner = if matches!(
        spec["gateway"]["runtime"]["provider"].as_str(),
        Some("kubernetes" | "openshift")
    ) {
        Runner::LiveKind
    } else if !crate::images::runtime_targets(document)?.is_empty() {
        Runner::Gpu
    } else if nvidia_key {
        Runner::Hosted
    } else {
        Runner::LiveDocker
    };
    Ok(Needs { runner, nvidia_key })
}

/// What each live case needs from the job that runs it.
pub fn placements(root: &Path) -> Result<BTreeMap<String, Needs>> {
    documents(root)?
        .into_iter()
        .map(|(id, document)| {
            let needed = needs(&document).map_err(|error| format!("the {id} case: {error}"))?;
            Ok((id, needed))
        })
        .collect()
}

/// The live cases that run on `runner`, in order: all of them, or the
/// `requested` ones, each of which must run there.
pub fn on(root: &Path, runner: Runner, requested: Option<&[String]>) -> Result<Vec<String>> {
    let placed: Vec<String> = placements(root)?
        .into_iter()
        .filter(|(_, needed)| needed.runner == runner)
        .map(|(id, _)| id)
        .collect();
    let Some(requested) = requested else {
        return Ok(placed);
    };
    if let Some(id) = requested.iter().find(|id| !placed.contains(id)) {
        return Err(format!(
            "{id} is not a live HCL case that runs in {}; these are: {}",
            runner.name(),
            placed.join(", ")
        ));
    }
    Ok(placed
        .into_iter()
        .filter(|id| requested.contains(id))
        .collect())
}
