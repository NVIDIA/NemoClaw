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
            version: 4,
            digest: document.digest(),
            document,
            generations,
            ..Default::default()
        })
    }
    fn validate(&self) -> Result<(), Error> {
        if self.version != 4 {
            return Err(Error::State(
                "deployment predates Docker-provider compute ownership; retain state and use the original NemoClaw version for recovery or teardown",
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
    pub fn bindings(&self) -> Result<BTreeMap<String, StateBinding>, Error> {
        bindings(&self.directory)
    }
}
pub(crate) fn bindings(directory: &Path) -> Result<BTreeMap<String, StateBinding>, Error> {
    let bytes = match fs::read(directory.join("terraform.tfstate")) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(BTreeMap::new()),
        Err(_) => return Err(Error::State("cannot read OpenTofu state")),
    };
    #[derive(Deserialize)]
    struct Instance {
        #[serde(default)]
        index_key: serde_json::Value,
        #[serde(default)]
        deposed: serde_json::Value,
        attributes: serde_json::Value,
    }
    #[derive(Deserialize)]
    struct Resource {
        #[serde(default)]
        module: Option<String>,
        #[serde(default)]
        mode: Option<String>,
        r#type: String,
        name: String,
        instances: Vec<Instance>,
    }
    #[derive(Deserialize)]
    struct State {
        resources: Vec<Resource>,
    }
    let state: State = serde_json::from_slice(&bytes)
        .map_err(|_| Error::State("OpenTofu state is unreadable; retain it for recovery"))?;
    let mut bindings = BTreeMap::new();
    let mut observations = std::collections::BTreeSet::new();
    for resource in state.resources {
        if resource.instances.len() != 1 || resource.module.is_some() {
            return Err(Error::State("unexpected resource instances in state"));
        }
        let instance = resource
            .instances
            .into_iter()
            .next()
            .expect("checked length");
        let address = format!("{}.{}", resource.r#type, resource.name);
        if !instance.index_key.is_null()
            || !instance.deposed.is_null()
            || !instance.attributes.is_object()
        {
            return Err(Error::State("unexpected resource instances in state"));
        }
        if resource.mode.as_deref() == Some("data") {
            let known = if format!("data.{address}") == crate::compile::GATEWAY_CAPABILITIES_ADDRESS
            {
                true
            } else if resource.r#type == "nemoclaw_service_capacity" {
                instance.attributes["engine"]
                    .as_str()
                    .is_some_and(|engine| {
                        crate::docker::Engine::validate_endpoint(engine).is_ok()
                            && resource.name == crate::services::capacity::observation_name(engine)
                    })
            } else if resource.r#type == "docker_image" {
                resource.name.starts_with("image_")
            } else {
                false
            };
            if !known || !observations.insert(address) {
                return Err(Error::State("unexpected or duplicate observation in state"));
            }
            continue;
        }
        if resource.mode.as_ref().is_some_and(|mode| mode != "managed") {
            return Err(Error::State("unexpected resource instances in state"));
        }
        let attributes: StateBinding = serde_json::from_value(instance.attributes)
            .map_err(|_| Error::State("OpenTofu state is unreadable; retain it for recovery"))?;
        if attributes.id.is_empty() || bindings.insert(address, attributes).is_some() {
            return Err(Error::State("duplicate or unbound resource in state"));
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
