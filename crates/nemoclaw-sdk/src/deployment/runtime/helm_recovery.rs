// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::*;
use crate::kubernetes::gateway::ADDRESS;

#[cfg(all(test, unix))]
mod tests;
#[cfg(test)]
mod validation_tests;

const CHECKPOINT: &str = "helm-recovery.json";

// The pinned Helm provider can forget a release on a failed existence lookup.
// Preserve its binding across teardown, as required by Ownership and Recovery
// in docs/design/scope.md. OpenTofu still owns the state format and edits.
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Checkpoint {
    version: u32,
    bundle: String,
    intent: String,
    generations: compile::Generations,
    state: String,
}

impl Checkpoint {
    fn validate(
        &self,
        bundle_version: &str,
        record: &Record,
        current_state: &str,
    ) -> Result<(), Error> {
        if self.version != 1
            || self.bundle != bundle_version
            || self.intent != record.document.digest()
            || self.generations != record.generations
            || !record.destroying()
        {
            return Err(Error::Conflict(
                "Helm recovery requires its original bundle, intent and unfinished destroy",
            ));
        }
        let saved_header = header(&self.state)?;
        let current_header = header(current_state)?;
        if saved_header.lineage != current_header.lineage
            || current_header.serial < saved_header.serial
        {
            return Err(Error::Conflict(
                "Helm recovery state lineage or serial changed; retain state and checkpoint",
            ));
        }
        validate_helm_provider(&self.state, true)?;
        validate_helm_provider(current_state, false)?;
        Ok(())
    }
}

// State mv preserves a resource's provider configuration. Only the original
// unaliased provider may receive this binding; OpenTofu validates its schema.
fn validate_helm_provider(state: &str, required: bool) -> Result<(), Error> {
    let invalid =
        || Error::Conflict("Helm recovery requires the original default Helm provider binding");
    let state: Value = serde_json::from_str(state).map_err(|_| invalid())?;
    let resources = state["resources"].as_array().ok_or_else(invalid)?;
    let mut releases = resources
        .iter()
        .filter(|resource| resource["type"] == "helm_release" && resource["name"] == "gateway");
    let Some(release) = releases.next() else {
        return if required { Err(invalid()) } else { Ok(()) };
    };
    let provider = format!(
        "provider[\"{}\"]",
        crate::kubernetes::gateway::PROVIDER_ADDRESS
    );
    let singleton = release["instances"]
        .as_array()
        .is_some_and(|instances| instances.len() == 1 && instances[0].get("index_key").is_none());
    if releases.next().is_some()
        || release.get("module").is_some()
        || release["mode"] != "managed"
        || release["provider"] != provider
        || !singleton
    {
        return Err(invalid());
    }
    Ok(())
}

#[derive(Deserialize)]
struct StateHeader {
    version: u32,
    lineage: String,
    serial: u64,
}

fn header(state: &str) -> Result<StateHeader, Error> {
    let header: StateHeader = serde_json::from_str(state)
        .map_err(|_| Error::State("Helm recovery requires readable local OpenTofu state"))?;
    if header.version != 4 || header.lineage.is_empty() {
        return Err(Error::State("unsupported OpenTofu state for Helm recovery"));
    }
    Ok(header)
}

fn read_state(store: &Store) -> Result<String, Error> {
    fs::read_to_string(store.directory.join("terraform.tfstate"))
        .map_err(|_| Error::State("Helm recovery requires the current OpenTofu state"))
}

fn same_binding(saved: &StateBinding, current: &StateBinding) -> bool {
    saved.id == current.id
        && saved.spec == current.spec
        && saved.name == current.name
        && saved.namespace == current.namespace
        && saved.chart == current.chart
        && saved.owner == current.owner
        && saved.generation == current.generation
        && saved.workspace == current.workspace
        && saved.deposed == current.deposed
}

fn needs_restore(
    saved: &BTreeMap<String, StateBinding>,
    current: &BTreeMap<String, StateBinding>,
) -> Result<bool, Error> {
    if !current.contains_key(KUBERNETES_STORAGE)
        || current.iter().any(|(address, binding)| {
            saved
                .get(address)
                .is_none_or(|saved| !same_binding(saved, binding))
        })
    {
        return Err(Error::Conflict(
            "Helm recovery found changed resource identity; retain state and checkpoint",
        ));
    }
    if !current.contains_key(KUBERNETES_AUTH) {
        // Successful auth deletion independently verified release and gateway
        // absence. Restoring here would undo a confirmed deletion.
        if current.contains_key(ADDRESS)
            || current.contains_key("nemoclaw_kubernetes_gateway.runtime")
        {
            return Err(Error::Conflict(
                "Helm recovery found incomplete prerequisite state; retain state and checkpoint",
            ));
        }
        return Ok(false);
    }
    Ok(!current.contains_key(ADDRESS))
}

impl Deployment {
    pub(super) async fn checkpoint_helm_binding(
        &self,
        bundle: &Bundle,
        store: &Store,
        record: &Record,
        cancel: &CancellationToken,
    ) -> Result<(), Error> {
        let bindings = store.bindings(&bundle.tofu(), cancel).await?;
        if !bindings.contains_key(ADDRESS) {
            return Ok(());
        }
        if store.directory.join(CHECKPOINT).exists() {
            return Err(Error::Conflict(
                "unfinished Helm recovery; rerun destroy with the same bundle and state directory",
            ));
        }
        let targets = compile::runtime_targets(&record.document, &record.generations)?;
        runtime_bindings(&targets, &bindings)?;
        let state = read_state(store)?;
        header(&state)?;
        validate_helm_provider(&state, true)?;
        save_json(
            &store.directory.join(CHECKPOINT),
            &Checkpoint {
                version: 1,
                bundle: bundle.manifest.version.clone(),
                intent: record.document.digest(),
                generations: record.generations.clone(),
                state,
            },
        )?;
        Ok(())
    }

    /// Restore only a missing release binding, never a complete older state.
    /// This performs local state operations only; the next saved plan must
    /// refresh remote ownership and absence before any further deletion.
    pub(super) async fn recover_helm_binding(
        &self,
        bundle: &Bundle,
        store: &Store,
        record: &Record,
        preview: bool,
        cancel: &CancellationToken,
    ) -> Result<bool, Error> {
        let path = store.directory.join(CHECKPOINT);
        let bytes = match fs::read(&path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
            Err(_) => return Err(Error::State("cannot read Helm recovery checkpoint")),
        };
        let checkpoint: Checkpoint = serde_json::from_slice(&bytes)
            .map_err(|_| Error::State("invalid Helm recovery checkpoint; retain it and state"))?;
        checkpoint.validate(&bundle.manifest.version, record, &read_state(store)?)?;
        let (graph, targets) = compile::compiled_runtime(
            &record.document,
            &record.generations,
            &bundle.manifest.version,
        )?;
        self.initialize(bundle, store, &graph, cancel).await?;
        let temporary = tempfile::Builder::new()
            .prefix(".helm-recovery-")
            .tempdir_in(&store.directory)
            .map_err(|_| Error::State("cannot prepare Helm recovery state"))?;
        let snapshot = Store::open(temporary.path())?;
        atomic_write(
            &snapshot.directory.join("terraform.tfstate"),
            checkpoint.state.as_bytes(),
        )?;
        self.initialize(bundle, &snapshot, &graph, cancel).await?;
        let saved = snapshot.bindings(&bundle.tofu(), cancel).await?;
        if !saved.contains_key(ADDRESS) {
            return Err(Error::State(
                "Helm recovery checkpoint has no release binding",
            ));
        }
        runtime_bindings(&targets, &saved)?;
        let current = store.bindings(&bundle.tofu(), cancel).await?;
        let restore = needs_restore(&saved, &current)?;
        if restore && preview {
            return Err(Error::Conflict(
                "Helm binding recovery is pending; rerun destroy with the same bundle and state directory",
            ));
        }
        if restore {
            let destination = std::path::absolute(store.directory.join("terraform.tfstate"))
                .map_err(|_| Error::State("cannot locate Helm recovery destination"))?;
            crate::process::run(
                &snapshot.directory,
                &bundle.tofu(),
                &[
                    "state",
                    "mv",
                    "-no-color",
                    &format!("-state-out={}", destination.display()),
                    ADDRESS,
                    ADDRESS,
                ],
                &crate::state::schema_environment(&snapshot.directory),
                cancel,
            )
            .await?;
            let restored = store.bindings(&bundle.tofu(), cancel).await?;
            if restored.len() != current.len() + 1
                || !restored
                    .get(ADDRESS)
                    .is_some_and(|binding| same_binding(&saved[ADDRESS], binding))
                || current.iter().any(|(address, binding)| {
                    restored
                        .get(address)
                        .is_none_or(|restored| !same_binding(binding, restored))
                })
            {
                return Err(Error::State(
                    "Helm recovery did not preserve resource bindings; retain checkpoint",
                ));
            }
        }
        if !preview {
            fs::remove_file(path)
                .map_err(|_| Error::State("cannot finish Helm binding recovery; rerun destroy"))?;
            #[cfg(unix)]
            fs::File::open(&store.directory)
                .and_then(|directory| directory.sync_all())
                .map_err(|_| Error::State("cannot sync Helm recovery completion; rerun destroy"))?;
        }
        Ok(restore)
    }
}
