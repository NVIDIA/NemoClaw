// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

#[cfg(test)]
mod tests;

use crate::{Error, compile::Generations, config::Document};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs::{self, File, OpenOptions},
    io::{ErrorKind, Write},
    path::{Path, PathBuf},
};

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub(crate) struct Record {
    pub version: u32,
    pub document: Document,
    pub generations: Generations,
    pub pending: bool,
    pub succeeded: bool,
    pub digest: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub plan_digest: String,
    #[serde(skip_serializing_if = "is_false")]
    pub destroying: bool,
    #[serde(skip_serializing_if = "is_false")]
    pub destroyed: bool,
    #[serde(skip_serializing_if = "is_false")]
    pub destroy_runtime: bool,
}
fn is_false(value: &bool) -> bool {
    !*value
}
impl Record {
    pub fn new(document: Document) -> Result<Self, Error> {
        document.validate()?;
        let mut generations = Generations::new();
        let mut kinds = vec!["workspace", "provider", "sandbox", "managed_gateway"];
        kinds.extend(crate::services::generation_kinds(&document)?);
        kinds.sort_unstable();
        kinds.dedup();
        for kind in kinds {
            let mut random = [0_u8; 16];
            getrandom::fill(&mut random)
                .map_err(|_| Error::State("cannot generate resource identities"))?;
            generations.insert(
                kind.into(),
                random.iter().map(|b| format!("{b:02x}")).collect(),
            );
        }
        Ok(Self {
            version: 7,
            digest: document.digest(),
            document,
            generations,
            ..Default::default()
        })
    }
    fn validate(&self) -> Result<(), Error> {
        if self.version != 7 {
            return Err(Error::State(
                "deployment predates Docker-provider model cache ownership; retain state and use the original NemoClaw version for recovery or teardown",
            ));
        }
        let service_generations_valid = crate::services::generation_kinds(&self.document)
            .is_ok_and(|kinds| {
                kinds.iter().all(|kind| {
                    self.generations
                        .get(*kind)
                        .is_some_and(|value| !value.is_empty())
                })
            });
        if self.document.validate().is_err()
            || self.digest != self.document.digest()
            || ["workspace", "provider", "sandbox"]
                .iter()
                .any(|kind| self.generations.get(*kind).is_none_or(String::is_empty))
            || !service_generations_valid
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
    pub spec: String,
    #[serde(skip)]
    pub deposed: BTreeMap<String, String>,
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
        save_json(&self.directory.join("intent.json"), record)
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
            }
        }
    }
    Ok(bindings)
}
pub(crate) fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), Error> {
    let parent = path.parent().ok_or(Error::State("invalid state path"))?;
    let mut file = tempfile::NamedTempFile::new_in(parent)
        .map_err(|_| Error::State("cannot create atomic state write"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.as_file()
            .set_permissions(fs::Permissions::from_mode(0o600))
            .map_err(|_| Error::State("cannot protect state file"))?;
    }
    file.write_all(bytes)
        .and_then(|()| file.as_file().sync_all())
        .map_err(|_| Error::State("cannot write and sync state file"))?;
    file.persist(path)
        .map_err(|_| Error::State("cannot commit state file"))?;
    #[cfg(unix)]
    File::open(parent)
        .and_then(|directory| directory.sync_all())
        .map_err(|_| Error::State("cannot sync state directory"))?;
    Ok(())
}
pub(crate) fn save_json(path: &Path, value: &impl Serialize) -> Result<(), Error> {
    let mut bytes =
        serde_json::to_vec_pretty(value).map_err(|_| Error::State("cannot serialize state"))?;
    bytes.push(b'\n');
    atomic_write(path, &bytes)
}
