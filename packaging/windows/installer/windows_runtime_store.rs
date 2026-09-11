// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::runtime_lease::{
    native::{self, ContentFile, ControlDirectory, ControlFile, CreatedDirectories},
    Descriptor,
};
use super::runtime_manifest::{self, Entry};
use super::runtime_transaction::{
    Error, InstalledState, Journal, NativeStore, Operation, RuntimeIdentity, Stage,
};
use super::windows_sha256::Sha256;
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

const STORAGE_HEADER: &str = "NEMOCLAW_MSI_STORAGE_V1\n";
fn native_error(value: &'static str) -> Error {
    if value == "runtime-busy" {
        Error::Busy
    } else {
        Error::Native(value)
    }
}
fn identity(value: Descriptor) -> RuntimeIdentity {
    RuntimeIdentity {
        runtime_id: value.runtime_id,
        manifest_sha256: value.manifest_sha256,
        source_revision: value.source_revision,
        node_sha256: value.node_sha256,
        node_version: value.node_version,
    }
}
fn descriptor(value: &RuntimeIdentity) -> Descriptor {
    Descriptor {
        runtime_id: value.runtime_id.clone(),
        manifest_sha256: value.manifest_sha256.clone(),
        source_revision: value.source_revision.clone(),
        node_sha256: value.node_sha256.clone(),
        node_version: value.node_version.clone(),
    }
}

pub struct WindowsStore {
    #[cfg(feature = "msi-boundary-fixture")]
    pub fail_before_admission: bool,
    directory: Option<ControlDirectory>,
    created: CreatedDirectories,
    journal: Option<Journal>,
}
impl WindowsStore {
    pub fn new() -> Self {
        Self {
            #[cfg(feature = "msi-boundary-fixture")]
            fail_before_admission: false,
            directory: None,
            created: CreatedDirectories::default(),
            journal: None,
        }
    }
    fn open(&mut self) -> Result<bool, Error> {
        if self.directory.is_some() {
            return Ok(true);
        }
        match ControlDirectory::open() {
            Ok(value) => {
                self.directory = Some(value);
                Ok(true)
            }
            Err("runtime-unavailable") => Ok(false),
            Err(value) => Err(native_error(value)),
        }
    }
    fn directory(&self) -> Result<&ControlDirectory, Error> {
        self.directory
            .as_ref()
            .ok_or(Error::Native("runtime-installation"))
    }
    fn storage(&self, journal: &Journal) -> Result<Vec<u8>, Error> {
        let mask = u8::from(self.created.vendor) | (u8::from(self.created.application) << 1);
        let mut bytes = format!("{STORAGE_HEADER}{mask}\n").into_bytes();
        bytes.extend(journal.bytes()?);
        Ok(bytes)
    }
    fn control_descriptor(&self, name: ControlFile) -> Result<Option<RuntimeIdentity>, Error> {
        self.directory()?
            .read(name)
            .map_err(native_error)?
            .map(|bytes| {
                Descriptor::parse(&bytes)
                    .map(identity)
                    .map_err(native_error)
            })
            .transpose()
    }
    fn remove_retired(&self, previous: Option<&RuntimeIdentity>) -> Result<(), Error> {
        if let Some(actual) = self.control_descriptor(ControlFile::Retired)? {
            if Some(&actual) != previous {
                return Err(Error::ForeignTransaction);
            }
            self.directory()?
                .remove(ControlFile::Retired)
                .map_err(native_error)?;
        }
        Ok(())
    }
}

fn read_bounded(file: &mut ContentFile<'_>, limit: usize) -> Result<Vec<u8>, Error> {
    if file.size() > limit as u64 {
        return Err(Error::Native("runtime-content-bound"));
    }
    let mut output = Vec::with_capacity(file.size() as usize);
    let mut chunk = [0u8; 64 * 1024];
    loop {
        let count = file.read_chunk(&mut chunk).map_err(native_error)?;
        if count == 0 {
            break;
        }
        if output.len() + count > limit {
            return Err(Error::Native("runtime-content-bound"));
        }
        output.extend_from_slice(&chunk[..count]);
    }
    if output.len() as u64 != file.size() {
        return Err(Error::Native("runtime-content-size"));
    }
    Ok(output)
}
fn hash_file(file: &mut ContentFile<'_>) -> Result<String, Error> {
    let mut hash = Sha256::new()?;
    let mut chunk = [0u8; 64 * 1024];
    let mut total = 0u64;
    loop {
        let count = file.read_chunk(&mut chunk).map_err(native_error)?;
        if count == 0 {
            break;
        }
        total = total.checked_add(count as u64).ok_or(Error::Identity)?;
        hash.update(&chunk[..count])?;
    }
    if total != file.size() {
        return Err(Error::Native("runtime-content-size"));
    }
    hash.finish()
}

fn verify_directory(
    control: &ControlDirectory,
    installed: &Path,
    prefix: &str,
    relative: &str,
    expected: &BTreeMap<String, Entry>,
    seen: &mut BTreeSet<String>,
) -> Result<(), Error> {
    let path = if relative.is_empty() {
        prefix.to_owned()
    } else {
        format!("{prefix}/{relative}")
    };
    let _guard = control
        .open_content_directory(&path)
        .map_err(native_error)?;
    for item in std::fs::read_dir(installed.join(&path))
        .map_err(|_| Error::Native("runtime-enumeration"))?
    {
        let item = item.map_err(|_| Error::Native("runtime-enumeration"))?;
        let name = item
            .file_name()
            .into_string()
            .map_err(|_| Error::Identity)?;
        if relative.is_empty() && matches!(name.as_str(), "runtime.manifest" | "runtime.ready") {
            continue;
        }
        let name = if relative.is_empty() {
            name
        } else {
            format!("{relative}/{name}")
        };
        runtime_manifest::validate_relative(&name)?;
        if seen.len() >= runtime_manifest::MAX_ENTRIES || !seen.insert(name.clone()) {
            return Err(Error::Identity);
        }
        let kind = item
            .file_type()
            .map_err(|_| Error::Native("runtime-enumeration"))?;
        match expected.get(&name) {
            Some(Entry::Directory) if kind.is_dir() => {
                verify_directory(control, installed, prefix, &name, expected, seen)?
            }
            Some(Entry::File { size, sha256 }) if kind.is_file() => {
                let mut file = control
                    .open_content_file(&format!("{prefix}/{name}"))
                    .map_err(native_error)?;
                if file.size() != *size || hash_file(&mut file)? != *sha256 {
                    return Err(Error::Native("runtime-content-mismatch"));
                }
            }
            _ => return Err(Error::Native("runtime-inventory-mismatch")),
        }
    }
    Ok(())
}

impl NativeStore for WindowsStore {
    fn installed_state(&mut self) -> Result<InstalledState, Error> {
        if !self.open()? {
            return Ok(InstalledState::Absent);
        }
        if self.control_descriptor(ControlFile::Retired)?.is_some() {
            return Err(Error::Native("runtime-orphan-retirement"));
        }
        if let Some(value) = self.control_descriptor(ControlFile::Current)? {
            return Ok(InstalledState::Selected(value));
        }
        let _guard = self
            .directory()?
            .open_content_directory("")
            .map_err(native_error)?;
        let installation = native::installed_path().map_err(native_error)?;
        let mut entries =
            std::fs::read_dir(installation).map_err(|_| Error::Native("runtime-enumeration"))?;
        match entries.next() {
            None => Ok(InstalledState::Absent),
            Some(Ok(_)) => Ok(InstalledState::Legacy),
            Some(Err(_)) => Err(Error::Native("runtime-enumeration")),
        }
    }
    fn read_journal(&mut self) -> Result<Option<Journal>, Error> {
        if !self.open()? {
            return Ok(None);
        }
        let Some(bytes) = self
            .directory()?
            .read(ControlFile::Maintenance)
            .map_err(native_error)?
        else {
            return Ok(None);
        };
        let body = bytes
            .strip_prefix(STORAGE_HEADER.as_bytes())
            .ok_or(Error::Identity)?;
        if body.len() < 2 || body[1] != b'\n' || !matches!(body[0], b'0'..=b'3') {
            return Err(Error::Identity);
        }
        let mask = body[0] - b'0';
        let journal = Journal::parse(&body[2..])?;
        self.created = CreatedDirectories {
            vendor: mask & 1 != 0,
            application: mask & 2 != 0,
        };
        self.journal = Some(journal.clone());
        Ok(Some(journal))
    }
    fn create_journal(&mut self, journal: &Journal) -> Result<(), Error> {
        if self.directory.is_none() {
            let (directory, created) = ControlDirectory::open_or_create().map_err(native_error)?;
            self.directory = Some(directory);
            self.created = created;
        }
        self.directory()?
            .write_new(ControlFile::Maintenance, &self.storage(journal)?)
            .map_err(native_error)?;
        self.journal = Some(journal.clone());
        Ok(())
    }
    fn update_journal(&mut self, previous: &Journal, next: &Journal) -> Result<(), Error> {
        if self.journal.as_ref() != Some(previous) {
            return Err(Error::ForeignTransaction);
        }
        let old = self.storage(previous)?;
        let new = self.storage(next)?;
        self.directory()?
            .discard_orphan_next()
            .map_err(native_error)?;
        self.directory()?
            .replace_exact(ControlFile::Maintenance, &old, &new)
            .map_err(native_error)?;
        self.journal = Some(next.clone());
        Ok(())
    }
    fn remove_journal(&mut self, expected: &Journal) -> Result<(), Error> {
        #[cfg(feature = "msi-boundary-fixture")]
        if self.fail_before_admission && expected.stage == Stage::Selected {
            return Err(Error::Native("fixture-before-admission"));
        }
        if self.journal.as_ref() != Some(expected)
            || self
                .directory()?
                .read(ControlFile::Maintenance)
                .map_err(native_error)?
                != Some(self.storage(expected)?)
        {
            return Err(Error::ForeignTransaction);
        }
        self.directory()?
            .discard_orphan_next()
            .map_err(native_error)?;
        self.directory()?
            .remove(ControlFile::Maintenance)
            .map_err(native_error)?;
        self.journal = None;
        // MSI cannot remove the root while these transaction markers exist.
        // Close our directory lease before empty-only successful-remove cleanup.
        if expected.stage == Stage::Selected && expected.operation == Operation::Remove {
            self.directory = None;
            ControlDirectory::cleanup_removed_installation().map_err(native_error)?;
        } else if expected.stage != Stage::Selected && expected.previous.is_none() {
            self.directory = None;
            ControlDirectory::cleanup_created(self.created).map_err(native_error)?;
        }
        Ok(())
    }
    fn retire_selected(&mut self, expected: &RuntimeIdentity) -> Result<(), Error> {
        if self.control_descriptor(ControlFile::Current)?.as_ref() != Some(expected) {
            return Err(Error::ForeignTransaction);
        }
        native::transition(&expected.runtime_id, &expected.manifest_sha256, false)
            .map_err(native_error)
    }
    fn verify_complete_content(&mut self, expected: &RuntimeIdentity) -> Result<(), Error> {
        expected.validate()?;
        let control = self.directory()?;
        let prefix = format!("runtimes/{}", expected.runtime_id);
        let mut manifest = control
            .open_content_file(&format!("{prefix}/runtime.manifest"))
            .map_err(native_error)?;
        let bytes = read_bounded(&mut manifest, runtime_manifest::MAX_MANIFEST_BYTES)?;
        let mut hash = Sha256::new()?;
        hash.update(&bytes)?;
        if hash.finish()? != expected.manifest_sha256 {
            return Err(Error::Native("runtime-manifest-mismatch"));
        }
        let entries = runtime_manifest::parse(&bytes, expected)?;
        let mut ready = control
            .open_content_file(&format!("{prefix}/runtime.ready"))
            .map_err(native_error)?;
        if Descriptor::parse(&read_bounded(&mut ready, 512)?)
            .map(identity)
            .map_err(native_error)?
            != *expected
        {
            return Err(Error::Identity);
        }
        let mut node = control
            .open_content_file("bin/node.exe")
            .map_err(native_error)?;
        if hash_file(&mut node)? != expected.node_sha256 {
            return Err(Error::Native("runtime-node-mismatch"));
        }
        let mut seen = BTreeSet::new();
        let installation = native::installed_path().map_err(native_error)?;
        verify_directory(
            control,
            Path::new(&installation),
            &prefix,
            "",
            &entries,
            &mut seen,
        )?;
        if seen.len() != entries.len() {
            return Err(Error::Native("runtime-inventory-incomplete"));
        }
        Ok(())
    }
    fn restore_previous(&mut self, expected: Option<&RuntimeIdentity>) -> Result<(), Error> {
        let journal = self.journal.as_ref().ok_or(Error::NoTransaction)?;
        if journal.previous.as_ref() != expected {
            return Err(Error::ForeignTransaction);
        }
        let current = self.control_descriptor(ControlFile::Current)?;
        if let Some(actual) = &current {
            let target = match &journal.operation {
                Operation::Install(value) => Some(value),
                Operation::Remove => None,
            };
            if Some(actual) != expected && Some(actual) != target {
                return Err(Error::ForeignTransaction);
            }
        }
        match (current, expected) {
            (Some(actual), Some(value)) if actual == *value => {}
            (Some(actual), Some(value)) => self
                .directory()?
                .replace_exact(
                    ControlFile::Current,
                    &descriptor(&actual).bytes(),
                    &descriptor(value).bytes(),
                )
                .map_err(native_error)?,
            (None, Some(value)) => self
                .directory()?
                .write_new(ControlFile::Current, &descriptor(value).bytes())
                .map_err(native_error)?,
            (Some(_), None) => self
                .directory()?
                .remove(ControlFile::Current)
                .map_err(native_error)?,
            (None, None) => {}
        }
        self.remove_retired(expected)
    }
    fn select_verified(&mut self, expected: &RuntimeIdentity) -> Result<(), Error> {
        let journal = self.journal.as_ref().ok_or(Error::NoTransaction)?;
        if journal.stage != Stage::Verified
            || journal.operation != Operation::Install(expected.clone())
        {
            return Err(Error::ForeignTransaction);
        }
        if let Some(actual) = self.control_descriptor(ControlFile::Current)? {
            if actual != *expected {
                return Err(Error::ForeignTransaction);
            }
        } else {
            self.directory()?
                .write_new(ControlFile::Current, &descriptor(expected).bytes())
                .map_err(native_error)?;
        }
        self.remove_retired(journal.previous.as_ref())
    }
    fn finish_removal(&mut self, previous: Option<&RuntimeIdentity>) -> Result<(), Error> {
        if self.control_descriptor(ControlFile::Current)?.is_some() {
            return Err(Error::ForeignTransaction);
        }
        self.remove_retired(previous)
    }
}
