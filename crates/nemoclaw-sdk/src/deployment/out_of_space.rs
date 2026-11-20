// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! OpenTofu failures that ran out of space, named by the storage they ran out
//! of.

use crate::Error;
use nemoclaw_backend::{Kept, OutOfSpace, StorageTarget, Writer};
use serde_json::Value;
use std::path::Path;

/// What OpenTofu reports when it can't write one of its own files in its
/// working directory, the deployment's state directory.
const OWN_WRITES: [&str; 5] = [
    "Failed to save state",
    "Failed to create local state file",
    "Failed to persist state to backend",
    "Failed to write plan file",
    "Failed to install provider",
];

/// The error for an OpenTofu command in the state `directory` that failed
/// because a write ran out of space: OpenTofu's own write in that directory,
/// or a resource's where the graph in `main.tf.json` places it. Any other
/// failure, and one in storage that neither names, keeps its error.
pub(super) fn classify(error: Error, directory: &Path) -> Error {
    let Error::Execution {
        operation,
        diagnostic,
        out_of_space,
        ..
    } = &error
    else {
        return error;
    };
    if out_of_space.is_empty() {
        return error;
    }
    let (resource, target, kept) = if out_of_space.contains(&None)
        && OWN_WRITES.iter().any(|write| diagnostic.contains(write))
    {
        (
            None,
            StorageTarget::DeploymentState {
                directory: directory.into(),
            },
            state_kept(directory, diagnostic),
        )
    } else {
        let Some(graph) = std::fs::read(directory.join("main.tf.json"))
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        else {
            return error;
        };
        let Some((resource, target)) = out_of_space
            .iter()
            .flatten()
            .find_map(|address| Some((address.clone(), place(&graph, address)?)))
        else {
            return error;
        };
        (Some(resource), target, Kept::Resources)
    };
    let available = match &target {
        StorageTarget::DeploymentState { directory } => crate::state::available_space(directory),
        _ => None,
    };
    Error::OutOfSpace(Box::new(OutOfSpace {
        writer: Writer::OpenTofu {
            operation: operation.clone(),
            resource,
        },
        target,
        available,
        kept,
        diagnostic: diagnostic.clone(),
    }))
}

/// What OpenTofu's own write kept of the state. An apply that can't save the
/// state writes it to `errored.tfstate` instead, unless it can't write that
/// either; OpenTofu reports both.
fn state_kept(directory: &Path, diagnostic: &str) -> Kept {
    if !diagnostic.contains("Failed to save state") {
        Kept::State
    } else if !diagnostic.contains("Failed to create local state file")
        && directory.join("errored.tfstate").is_file()
    {
        Kept::ErroredState
    } else {
        Kept::UnsavedState
    }
}

/// Where the resource or data source at `address` writes: an image or a
/// container in its engine's Docker root, and a volume, or a read of a
/// container's runtime, in that container's volume.
fn place(graph: &Value, address: &str) -> Option<StorageTarget> {
    let (section, address) = match address.strip_prefix("data.") {
        Some(address) => ("data", address),
        None => ("resource", address),
    };
    let (kind, name) = address.split_once('.')?;
    let attributes = graph[section][kind].get(name)?;
    match (section, kind) {
        ("resource", "docker_image" | "docker_container") => Some(StorageTarget::DockerRoot {
            engine: engine(graph, attributes)?,
        }),
        ("resource", "docker_volume") => Some(StorageTarget::Volume {
            engine: engine(graph, attributes)?,
            volume: attributes["name"].as_str()?.into(),
        }),
        _ => {
            let container = attributes["container_id"]
                .as_str()?
                .strip_prefix("${docker_container.")?
                .strip_suffix(".id}")?;
            let container = graph["resource"]["docker_container"].get(container)?;
            let engine = engine(graph, container)?;
            Some(match volume(graph, &container["mounts"][0]) {
                Some(volume) => StorageTarget::Volume { engine, volume },
                None => StorageTarget::DockerRoot { engine },
            })
        }
    }
}

/// The host of the Docker provider that manages `attributes`.
fn engine(graph: &Value, attributes: &Value) -> Option<String> {
    let alias = attributes["provider"].as_str()?.strip_prefix("docker.")?;
    graph["provider"]["docker"]
        .as_array()?
        .iter()
        .find(|provider| provider["alias"] == alias)?["host"]
        .as_str()
        .map(str::to_owned)
}

/// The name of the volume that `mount` mounts: a volume resource's, or one
/// that another resource creates by name.
fn volume(graph: &Value, mount: &Value) -> Option<String> {
    if mount["type"] != "volume" {
        return None;
    }
    let source = mount["source"].as_str()?;
    match source
        .strip_prefix("${docker_volume.")
        .and_then(|source| source.strip_suffix(".name}"))
    {
        Some(volume) => graph["resource"]["docker_volume"][volume]["name"]
            .as_str()
            .map(str::to_owned),
        None => (!source.contains("${")).then(|| source.to_owned()),
    }
}
