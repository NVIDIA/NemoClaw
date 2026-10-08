// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

mod observations;
#[cfg(test)]
mod tests;
pub(crate) use observations::parse_resources;

use crate::{Error, compile::Generations, config::Document};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs::{self, File, OpenOptions},
    io::ErrorKind,
    path::{Path, PathBuf},
};

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub(crate) struct Record {
    pub version: u32,
    pub document: Document,
    pub generations: Generations,
    pending: bool,
    #[serde(skip_serializing_if = "is_false")]
    runtime_pending: bool,
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pending_creations: BTreeMap<String, crate::backend::Row>,
    succeeded: bool,
    pub digest: String,
    #[serde(skip_serializing_if = "is_false")]
    destroying: bool,
    #[serde(skip_serializing_if = "is_false")]
    destroyed: bool,
    #[serde(skip_serializing_if = "is_false")]
    destroy_runtime: bool,
}
fn is_false(value: &bool) -> bool {
    !*value
}
fn required_generation_kinds(document: &Document) -> Result<Vec<&'static str>, Error> {
    let mut kinds = vec!["workspace", "provider", "sandbox", "managed_gateway"];
    if document.spec.gateway.as_kubernetes().is_some() {
        kinds.push(crate::kubernetes::GATEWAY_KIND);
        kinds.push(crate::kubernetes::STORAGE_KIND);
    }
    kinds.extend(crate::services::generation_kinds(document)?);
    kinds.sort_unstable();
    kinds.dedup();
    Ok(kinds)
}
fn valid_generation(value: &str) -> bool {
    value.len() == 32
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
}
fn supported_generation_kind(kind: &str) -> bool {
    matches!(
        kind,
        "workspace" | "provider" | "sandbox" | "managed_gateway"
    ) || kind == crate::kubernetes::GATEWAY_KIND
        || kind == crate::kubernetes::STORAGE_KIND
        || crate::services::supported_generation_kind(kind)
}
fn allocate_missing_generation_values(
    generations: &mut Generations,
    document: &Document,
) -> Result<(), Error> {
    document.validate()?;
    if generations
        .iter()
        .any(|(kind, value)| !supported_generation_kind(kind) || !valid_generation(value))
    {
        return Err(Error::State(
            "deployment intent record is invalid; retain it for recovery",
        ));
    }
    let additions = required_generation_kinds(document)?
        .into_iter()
        .filter(|kind| !generations.contains_key(*kind))
        .map(|kind| {
            let mut random = [0_u8; 16];
            getrandom::fill(&mut random)
                .map_err(|_| Error::State("cannot generate resource identities"))?;
            Ok((
                kind.into(),
                random.iter().map(|byte| format!("{byte:02x}")).collect(),
            ))
        })
        .collect::<Result<Vec<(String, String)>, Error>>()?;
    generations.extend(additions);
    Ok(())
}
impl Record {
    pub fn allocate_missing_generations(&mut self, document: &Document) -> Result<(), Error> {
        allocate_missing_generation_values(&mut self.generations, document)
    }
    pub fn new(document: Document) -> Result<Self, Error> {
        let mut generations = Generations::new();
        allocate_missing_generation_values(&mut generations, &document)?;
        Ok(Self {
            version: 7,
            digest: document.digest(),
            document,
            generations,
            ..Default::default()
        })
    }
    pub fn reconcile_pending_creations(&mut self, bindings: &BTreeMap<String, StateBinding>) {
        if !self.pending || self.runtime_pending {
            return;
        }
        self.pending_creations.retain(|address, desired| {
            // Fabric configuration has no independent runtime: its sandbox owns
            // any partial effects, and its configuration binding uses that ID.
            let address = address
                .strip_prefix("fabric_agent_configuration.")
                .map(|name| format!("openshell_sandbox.{name}"))
                .unwrap_or_else(|| address.clone());
            !bindings.get(&address).is_some_and(|binding| {
                !binding.id.is_empty()
                    && [
                        ("name", &binding.name),
                        ("workspace", &binding.workspace),
                        ("owner", &binding.owner),
                        ("generation", &binding.generation),
                    ]
                    .iter()
                    .all(|(key, value)| desired.get(*key).is_none_or(|want| want == *value))
            })
        });
        if self.pending_creations.is_empty() {
            self.finish_apply();
        }
        // This only resolves lost-ID uncertainty. A fresh provider refresh and
        // validated plan must still verify live ownership before any mutation.
    }
    pub fn validate_pending_intent(&self, document: &Document) -> Result<(), Error> {
        if self.pending
            && self.runtime_pending
            && self.document.spec.gateway.as_kubernetes().is_some()
            && self.digest != document.digest()
        {
            return Err(Error::Conflict(
                "unfinished Kubernetes platform apply requires its original configuration and state for recovery",
            ));
        }
        if !self.pending || self.runtime_pending {
            return Ok(());
        }
        let targets = crate::compile::targets(document, &self.generations)?;
        if self.pending_creations.iter().any(|(address, desired)| {
            !targets
                .iter()
                .any(|target| &target.address == address && &target.values == desired)
        }) {
            return Err(Error::Conflict(
                "unfinished creation requires its original resource configuration; retain the pending resource while revising unrelated intent",
            ));
        }
        Ok(())
    }
    pub fn validate_bound_sandboxes(
        &self,
        document: &Document,
        bindings: &BTreeMap<String, StateBinding>,
    ) -> Result<(), Error> {
        if !bindings
            .keys()
            .any(|address| address.starts_with("openshell_sandbox."))
        {
            return Ok(());
        }
        let before = crate::compile::targets(&self.document, &self.generations)?;
        let after = crate::compile::targets(document, &self.generations)?;
        for prior in before
            .iter()
            .filter(|target| target.kind == "sandbox" && bindings.contains_key(&target.address))
        {
            let next = after.iter().find(|target| target.address == prior.address);
            // Every compiled sandbox attribute is immutable. Model and adapter
            // settings live in the separate agent-configuration target.
            let action = match next {
                None => "remove",
                Some(next) if next.values != prior.values => "replace",
                _ => continue,
            };
            return Err(Error::SandboxChangeRefused {
                sandbox: prior.values["name"].clone(),
                action,
            });
        }
        // This only rejects authored changes before runtime reconciliation.
        // Provider refresh and plan still own live identity and drift checks.
        Ok(())
    }
    pub fn begin_apply(
        &mut self,
        document: &Document,
        creations: BTreeMap<String, crate::backend::Row>,
    ) {
        self.prepare_apply(document);
        if creations.is_empty() {
            // OpenTofu owns recovery for established bindings. Preserve any
            // earlier ambiguous creation, but do not invent one for updates,
            // deletions, or apply-time observations.
            return;
        }
        // Preserve every earlier lost reply until its resource binding is known.
        for (address, desired) in creations {
            self.pending_creations.entry(address).or_insert(desired);
        }
        self.pending = true;
        self.runtime_pending = false;
    }
    pub fn finish_apply(&mut self) {
        self.pending = false;
        self.runtime_pending = false;
        self.pending_creations.clear();
    }
    pub fn begin_runtime_apply(&mut self, document: &Document) {
        self.prepare_apply(document);
        // Runtime recovery must not clear an earlier ambiguous OpenShell mutation.
        if !self.pending {
            self.pending = true;
            self.runtime_pending = true;
        }
    }
    pub fn finish_runtime_apply(&mut self) {
        if self.runtime_pending {
            self.pending = false;
            self.runtime_pending = false;
        }
    }
    // Keep the authored intent and recovery flags at the same checkpoint.
    fn prepare_apply(&mut self, document: &Document) {
        self.document = document.clone();
        self.digest = document.digest();
        self.succeeded = false;
        self.destroyed = false;
        self.destroy_runtime = false;
    }

    // Durable mutations settle before health observations establish success.
    pub fn mark_succeeded(&mut self) {
        self.succeeded = true;
    }

    // Call only after both teardown plans account for the saved identities.
    pub fn begin_destroy(&mut self) {
        self.destroying = true;
        self.pending = false;
        self.succeeded = false;
    }

    pub fn finish_root_destroy(&mut self) {
        self.destroy_runtime = true;
    }

    pub fn finish_destroy(&mut self) {
        self.finish_apply();
        self.destroying = false;
        self.destroyed = true;
    }

    pub fn pending(&self) -> bool {
        self.pending
    }
    pub fn runtime_pending(&self) -> bool {
        self.runtime_pending
    }
    pub fn succeeded(&self) -> bool {
        self.succeeded
    }
    pub fn destroying(&self) -> bool {
        self.destroying
    }
    pub fn destroyed(&self) -> bool {
        self.destroyed
    }
    pub fn root_destroyed(&self) -> bool {
        self.destroy_runtime
    }
    fn validate(&self) -> Result<(), Error> {
        if self.version != 7 {
            return Err(Error::State(
                "deployment predates Docker-provider model cache ownership; retain state and use the original NemoClaw version for recovery or teardown",
            ));
        }
        let generations_valid = required_generation_kinds(&self.document).is_ok_and(|kinds| {
            kinds
                .iter()
                .all(|kind| self.generations.contains_key(*kind))
                && self
                    .generations
                    .iter()
                    .all(|(kind, value)| supported_generation_kind(kind) && valid_generation(value))
        });
        let has_pending_creations = !self.pending_creations.is_empty();
        if has_pending_creations != (self.pending && !self.runtime_pending)
            || (self.runtime_pending && !self.document.has_runtime())
            || self.validate_pending_intent(&self.document).is_err()
        {
            return Err(Error::State("pending resource recovery intent is invalid"));
        }
        if self.document.validate().is_err()
            || self.digest != self.document.digest()
            || !generations_valid
        {
            return Err(Error::State(
                "deployment intent record is invalid; retain it for recovery",
            ));
        }
        Ok(())
    }
}
#[derive(Clone, Debug, Default, Deserialize)]
pub(crate) struct StateBinding {
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub namespace: String,
    #[serde(default)]
    pub chart: String,
    #[serde(default)]
    pub workspace: String,
    #[serde(default)]
    pub owner: String,
    #[serde(default)]
    pub generation: String,
    #[serde(default)]
    pub spec: String,
    #[serde(default)]
    pub engine: String,
    #[serde(skip)]
    pub deposed: BTreeMap<String, String>,
}

impl StateBinding {
    /// Whether bound configuration differs from compiled values. An encoded
    /// specification compares whole; typed storage compares its identity.
    pub(crate) fn differs(&self, values: &crate::backend::Row) -> bool {
        match values.get("spec") {
            Some(spec) => *spec != self.spec,
            None => [
                ("name", &self.name),
                ("owner", &self.owner),
                ("generation", &self.generation),
                ("engine", &self.engine),
            ]
            .into_iter()
            .any(|(attribute, bound)| values.get(attribute).is_some_and(|want| want != bound)),
        }
    }
}

pub(crate) struct Store {
    pub directory: PathBuf,
    _lock: File,
}
impl Store {
    pub fn open(directory: &Path) -> Result<Self, Error> {
        let mut builder = fs::DirBuilder::new();
        builder.recursive(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        builder
            .create(directory)
            .map_err(|_| Error::State("cannot create deployment state directory"))?;
        let mut options = OpenOptions::new();
        options.create(true).truncate(false).read(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let lock = options
            .open(directory.join("deployment.lock"))
            .map_err(|_| Error::State("cannot open deployment lock"))?;
        lock.try_lock().map_err(|_| {
            Error::Conflict("another operation holds the deployment lock or locking failed")
        })?;
        Ok(Self {
            directory: directory.into(),
            _lock: lock,
        })
    }
    pub fn load(&self) -> Result<Option<Record>, Error> {
        let bytes = match fs::read(self.directory.join("intent.json")) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err(Error::State("cannot read deployment intent")),
        };
        let record: Record = serde_json::from_slice(&bytes).map_err(|_| {
            Error::State("deployment intent record is corrupt; retain it for recovery")
        })?;
        record.validate()?;
        Ok(Some(record))
    }
    pub fn save(&self, record: &Record) -> Result<(), Error> {
        record.validate()?;
        save_json(&self.directory.join("intent.json"), record).map_err(Into::into)
    }
    pub async fn bindings(
        &self,
        tofu: &Path,
        cancel: &crate::CancellationToken,
    ) -> Result<BTreeMap<String, StateBinding>, Error> {
        bindings(&self.directory, tofu, cancel).await
    }
}
pub(crate) fn schema_environment(directory: &Path) -> BTreeMap<String, String> {
    BTreeMap::from([
        ("TF_IN_AUTOMATION".into(), "1".into()),
        ("TF_INPUT".into(), "0".into()),
        ("CHECKPOINT_DISABLE".into(), "1".into()),
        (
            "TF_CLI_CONFIG_FILE".into(),
            directory
                .join("providers.tfrc")
                .to_string_lossy()
                .into_owned(),
        ),
    ])
}
/// Resource types that served OpenShell objects and Fabric agents before the
/// `openshell` and `fabric` providers.
const EARLIER_TYPES: [&str; 8] = [
    "nemoclaw_workspace",
    "nemoclaw_provider",
    "nemoclaw_provider_profile",
    "nemoclaw_sandbox",
    "nemoclaw_gateway_capabilities",
    "nemoclaw_agent_configuration",
    "nemoclaw_sandbox_readiness",
    "nemoclaw_fabric_capabilities",
];

/// Refuse state that an earlier release wrote with OpenShell or Fabric types of the
/// nemoclaw provider. Reading it would need that provider's schemas, and no
/// release upgrades it, so it is left unchanged for the release that wrote it.
fn reject_earlier_types(path: &Path) -> Result<(), Error> {
    #[derive(serde::Deserialize)]
    struct Resource {
        #[serde(rename = "type")]
        kind: String,
    }
    #[derive(serde::Deserialize)]
    struct State {
        #[serde(default)]
        resources: Vec<Resource>,
    }
    let state: State = serde_json::from_slice(
        &std::fs::read(path).map_err(|_| Error::State("cannot inspect OpenTofu state"))?,
    )
    .map_err(|_| Error::State("cannot inspect OpenTofu state"))?;
    if state
        .resources
        .iter()
        .any(|resource| EARLIER_TYPES.contains(&resource.kind.as_str()))
    {
        return Err(Error::State(
            "OpenTofu state holds OpenShell or Fabric resources from an earlier release; keep the state directory and use the release that wrote it",
        ));
    }
    Ok(())
}

pub(crate) async fn bindings(
    directory: &Path,
    tofu: &Path,
    cancel: &crate::CancellationToken,
) -> Result<BTreeMap<String, StateBinding>, Error> {
    if !directory
        .join("terraform.tfstate")
        .try_exists()
        .map_err(|_| Error::State("cannot inspect OpenTofu state"))?
    {
        return Ok(BTreeMap::new());
    }
    reject_earlier_types(&directory.join("terraform.tfstate"))?;
    let bytes = crate::process::run(
        directory,
        tofu,
        &["show", "-json"],
        &schema_environment(directory),
        cancel,
    )
    .await?;
    parse_bindings(&bytes)
}
fn parse_bindings(bytes: &[u8]) -> Result<BTreeMap<String, StateBinding>, Error> {
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
        values: serde_json::Value,
    }
    #[derive(Deserialize)]
    struct Values {
        root_module: Module,
    }
    #[derive(Deserialize)]
    struct State {
        format_version: String,
        values: Option<Values>,
    }
    let state: State = serde_json::from_slice(bytes)
        .map_err(|_| Error::State("invalid OpenTofu state JSON; retain state for recovery"))?;
    if state.format_version.split('.').next() != Some("1") {
        return Err(Error::State("unsupported OpenTofu state JSON version"));
    }
    let mut bindings: BTreeMap<String, StateBinding> = BTreeMap::new();
    let mut seen = std::collections::BTreeSet::new();
    let mut modules = state
        .values
        .map(|values| vec![values.root_module])
        .unwrap_or_default();
    while let Some(module) = modules.pop() {
        modules.extend(module.child_modules);
        for resource in module.resources {
            if resource.address.is_empty()
                || !seen.insert((resource.address.clone(), resource.deposed_key.clone()))
                || resource.deposed_key.as_ref().is_some_and(String::is_empty)
                || !resource.values.is_object()
            {
                return Err(Error::State(
                    "duplicate or incomplete OpenTofu state object",
                ));
            }
            match resource.mode.as_str() {
                // Data observations carry no managed binding. Their contracts are
                // validated by their provider and by the generated plan.
                "data" => continue,
                "managed" => {}
                _ => return Err(Error::State("unsupported OpenTofu resource mode")),
            }
            let attributes: StateBinding =
                serde_json::from_value(resource.values).map_err(|_| {
                    Error::State("OpenTofu binding is unreadable; retain state for recovery")
                })?;
            if attributes.id.is_empty() {
                return Err(Error::State("unbound resource in OpenTofu state"));
            }
            let binding = bindings.entry(resource.address).or_default();
            if binding.id == attributes.id
                || binding.deposed.values().any(|id| id == &attributes.id)
            {
                return Err(Error::State(
                    "current and deposed objects share a physical identity",
                ));
            }
            if let Some(key) = resource.deposed_key {
                binding.deposed.insert(key, attributes.id);
            } else {
                binding.id = attributes.id;
                binding.spec = attributes.spec;
                binding.name = attributes.name;
                binding.namespace = attributes.namespace;
                binding.chart = attributes.chart;
                binding.workspace = attributes.workspace;
                binding.owner = attributes.owner;
                binding.generation = attributes.generation;
                binding.engine = attributes.engine;
            }
        }
    }
    Ok(bindings)
}
pub(crate) use nemoclaw_runtime::files::{atomic_write, save_json};
