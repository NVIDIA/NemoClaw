// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Installer transaction ordering. The Windows store must implement the native
//! fixed-root descriptor/journal operations; this module never accepts a path.

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RuntimeIdentity {
    pub runtime_id: String,
    pub manifest_sha256: String,
    pub source_revision: String,
    pub node_sha256: String,
    pub node_version: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Operation {
    Install(RuntimeIdentity),
    Remove,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Stage {
    Prepared,
    Retired,
    Verified,
    Selected,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Journal {
    pub owner_runtime_id: String,
    pub owner_product_code: String,
    pub previous: Option<RuntimeIdentity>,
    pub operation: Operation,
    pub stage: Stage,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Error {
    Identity,
    NoTransaction,
    ForeignTransaction,
    LegacyRequiresStopFirst,
    Busy,
    Native(&'static str),
}

impl RuntimeIdentity {
    fn fields(&self) -> Vec<String> {
        vec![
            self.runtime_id.clone(),
            self.manifest_sha256.clone(),
            self.source_revision.clone(),
            self.node_sha256.clone(),
            self.node_version.clone(),
        ]
    }
    fn from_fields(fields: &[&str]) -> Result<Self, Error> {
        if fields.len() != 5 {
            return Err(Error::Identity);
        }
        let value = Self {
            runtime_id: fields[0].into(),
            manifest_sha256: fields[1].into(),
            source_revision: fields[2].into(),
            node_sha256: fields[3].into(),
            node_version: fields[4].into(),
        };
        value.validate()?;
        Ok(value)
    }
}

impl Journal {
    pub fn bytes(&self) -> Result<Vec<u8>, Error> {
        if !hex(&self.owner_runtime_id, 64) || !product(&self.owner_product_code) {
            return Err(Error::Identity);
        }
        let operation = match self.operation {
            Operation::Install(_) => "install",
            Operation::Remove => "remove",
        };
        let stage = match self.stage {
            Stage::Prepared => "prepared",
            Stage::Retired => "retired",
            Stage::Verified => "verified",
            Stage::Selected => "selected",
        };
        let mut fields = vec![
            "NEMOCLAW_MSI_TRANSACTION_V1".into(),
            self.owner_runtime_id.clone(),
            self.owner_product_code.clone(),
            operation.into(),
            stage.into(),
        ];
        match &self.previous {
            Some(value) => {
                value.validate()?;
                fields.extend(value.fields());
            }
            None => fields.extend(vec!["-".into(); 5]),
        }
        match &self.operation {
            Operation::Install(value) => {
                value.validate()?;
                if value.runtime_id != self.owner_runtime_id {
                    return Err(Error::Identity);
                }
                fields.extend(value.fields());
            }
            Operation::Remove => fields.extend(vec!["-".into(); 5]),
        }
        Ok((fields.join("\n") + "\n").into_bytes())
    }
    pub fn parse(bytes: &[u8]) -> Result<Self, Error> {
        if bytes.len() > 2048 || !bytes.ends_with(b"\n") {
            return Err(Error::Identity);
        }
        let text = std::str::from_utf8(bytes).map_err(|_| Error::Identity)?;
        let fields = text.split('\n').collect::<Vec<_>>();
        if fields.len() != 16 || fields[0] != "NEMOCLAW_MSI_TRANSACTION_V1" || fields[15] != "" {
            return Err(Error::Identity);
        }
        let previous = if fields[5..10].iter().all(|v| *v == "-") {
            None
        } else {
            Some(RuntimeIdentity::from_fields(&fields[5..10])?)
        };
        let operation = match fields[3] {
            "install" => Operation::Install(RuntimeIdentity::from_fields(&fields[10..15])?),
            "remove" if fields[10..15].iter().all(|v| *v == "-") => Operation::Remove,
            _ => return Err(Error::Identity),
        };
        let stage = match fields[4] {
            "prepared" => Stage::Prepared,
            "retired" => Stage::Retired,
            "verified" => Stage::Verified,
            "selected" => Stage::Selected,
            _ => return Err(Error::Identity),
        };
        let value = Self {
            owner_runtime_id: fields[1].into(),
            owner_product_code: fields[2].into(),
            previous,
            operation,
            stage,
        };
        if value.bytes()? != bytes {
            return Err(Error::Identity);
        }
        Ok(value)
    }
}

pub enum InstalledState {
    Absent,
    Legacy,
    Selected(RuntimeIdentity),
}

/// Implementations must operate through validated handles under the fixed
/// installation root. The journal is the runtime-maintenance admission marker.
/// All journal creates/replacements/removals are durable and ownership checked.
/// Reading an arbitrary caller file is never an implementation of this trait.
pub trait NativeStore {
    fn installed_state(&mut self) -> Result<InstalledState, Error>;
    fn read_journal(&mut self) -> Result<Option<Journal>, Error>;
    fn create_journal(&mut self, journal: &Journal) -> Result<(), Error>;
    fn update_journal(&mut self, previous: &Journal, next: &Journal) -> Result<(), Error>;
    fn remove_journal(&mut self, expected: &Journal) -> Result<(), Error>;
    fn retire_selected(&mut self, expected: &RuntimeIdentity) -> Result<(), Error>;
    fn verify_complete_content(&mut self, expected: &RuntimeIdentity) -> Result<(), Error>;
    fn restore_previous(&mut self, expected: Option<&RuntimeIdentity>) -> Result<(), Error>;
    fn select_verified(&mut self, expected: &RuntimeIdentity) -> Result<(), Error>;
    fn finish_removal(&mut self, previous: Option<&RuntimeIdentity>) -> Result<(), Error>;
}

fn hex(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

impl RuntimeIdentity {
    pub fn validate(&self) -> Result<(), Error> {
        let version = self.node_version.split('.').collect::<Vec<_>>();
        if !hex(&self.runtime_id, 64)
            || !hex(&self.manifest_sha256, 64)
            || !hex(&self.source_revision, 40)
            || !hex(&self.node_sha256, 64)
            || version.len() != 3
            || version.iter().any(|p| {
                p.is_empty()
                    || p.len() > 5
                    || (p.len() > 1 && p.starts_with('0'))
                    || !p.bytes().all(|b| b.is_ascii_digit())
            })
        {
            return Err(Error::Identity);
        }
        Ok(())
    }
}

fn product(value: &str) -> bool {
    let bytes = value.as_bytes();
    value.len() == 38
        && bytes[0] == b'{'
        && bytes[37] == b'}'
        && bytes.iter().enumerate().all(|(i, b)| match i {
            0 | 37 => true,
            9 | 14 | 19 | 24 => *b == b'-',
            _ => b.is_ascii_hexdigit(),
        })
}

fn owned<S: NativeStore>(store: &mut S, owner: &str) -> Result<Journal, Error> {
    if !hex(owner, 64) {
        return Err(Error::Identity);
    }
    let journal = store.read_journal()?.ok_or(Error::NoTransaction)?;
    if journal.owner_runtime_id != owner {
        return Err(Error::ForeignTransaction);
    }
    Ok(journal)
}

pub fn begin<S: NativeStore>(
    store: &mut S,
    owner: &str,
    product_code: &str,
    operation: Operation,
) -> Result<(), Error> {
    if !hex(owner, 64) || !product(product_code) {
        return Err(Error::Identity);
    }
    if let Operation::Install(target) = &operation {
        target.validate()?;
        if target.runtime_id != owner {
            return Err(Error::Identity);
        }
    }
    if store.read_journal()?.is_some() {
        return Err(Error::ForeignTransaction);
    }
    let previous = match store.installed_state()? {
        InstalledState::Absent => None,
        InstalledState::Legacy => return Err(Error::LegacyRequiresStopFirst),
        InstalledState::Selected(value) => {
            value.validate()?;
            Some(value)
        }
    };
    if let (Some(previous), Operation::Install(target)) = (&previous, &operation) {
        if previous.runtime_id == target.runtime_id && previous != target {
            return Err(Error::Native("runtime-namespace-reused"));
        }
    }
    if operation == Operation::Remove
        && previous
            .as_ref()
            .is_some_and(|value| value.runtime_id != owner)
    {
        return Err(Error::ForeignTransaction);
    }
    let journal = Journal {
        owner_runtime_id: owner.into(),
        owner_product_code: product_code.into(),
        previous,
        operation,
        stage: Stage::Prepared,
    };
    store.create_journal(&journal)?;
    // Do not restore in a finally/catch. MSI rollback owns restoration, including
    // the busy path where the exact ready selector never changed.
    if let Some(previous) = &journal.previous {
        store.retire_selected(previous)?;
    }
    let mut next = journal.clone();
    next.stage = Stage::Retired;
    store.update_journal(&journal, &next)
}

pub fn join_remove<S: NativeStore>(
    store: &mut S,
    removed_runtime: &str,
    parent_product: &str,
) -> Result<(), Error> {
    if !hex(removed_runtime, 64) || !product(parent_product) {
        return Err(Error::Identity);
    }
    let journal = store.read_journal()?.ok_or(Error::NoTransaction)?;
    if !journal
        .owner_product_code
        .eq_ignore_ascii_case(parent_product)
        || journal.previous.as_ref().map(|v| v.runtime_id.as_str()) != Some(removed_runtime)
        || !matches!(journal.stage, Stage::Retired | Stage::Verified)
    {
        return Err(Error::ForeignTransaction);
    }
    Ok(())
}

pub fn verify<S: NativeStore>(
    store: &mut S,
    owner: &str,
    target: &RuntimeIdentity,
) -> Result<(), Error> {
    target.validate()?;
    let journal = owned(store, owner)?;
    if journal.operation != Operation::Install(target.clone()) || journal.stage != Stage::Retired {
        return Err(Error::ForeignTransaction);
    }
    store.verify_complete_content(target)?;
    let mut next = journal.clone();
    next.stage = Stage::Verified;
    store.update_journal(&journal, &next)
}

/// Called only by the rollback action queued before retirement, after all later
/// MSI file rollback. Failed verification leaves the maintenance marker intact.
pub fn rollback<S: NativeStore>(store: &mut S, owner: &str) -> Result<(), Error> {
    if !hex(owner, 64) {
        return Err(Error::Identity);
    }
    // A failure before journal creation needs no undo; an existing foreign
    // journal must never be removed as though it belonged to this transaction.
    if store.read_journal()?.is_none() {
        return Ok(());
    }
    let journal = owned(store, owner)?;
    if let Some(previous) = &journal.previous {
        store.verify_complete_content(previous)?;
    }
    store.restore_previous(journal.previous.as_ref())?;
    store.remove_journal(&journal)
}

pub fn commit<S: NativeStore>(store: &mut S, owner: &str, removing: bool) -> Result<(), Error> {
    let journal = owned(store, owner)?;
    match (&journal.operation, removing, journal.stage) {
        (Operation::Install(target), false, Stage::Verified) => store.select_verified(target)?,
        (Operation::Remove, true, Stage::Retired) => {
            store.finish_removal(journal.previous.as_ref())?
        }
        _ => return Err(Error::ForeignTransaction),
    }
    let mut selected = journal.clone();
    selected.stage = Stage::Selected;
    store.update_journal(&journal, &selected)?;
    // Admission opens only after successful selection and durable journal
    // update. If any step fails, rollback still has the complete prior tuple.
    store.remove_journal(&selected)
}

/// Exact embedded-helper command contract; arguments contain identities only.
/// The MSI-supplied parent product code is checked against the protected journal
/// by join_remove and is never sufficient to bypass retirement by itself.
pub fn dispatch<S: NativeStore>(store: &mut S, arguments: &[String]) -> Result<(), Error> {
    let args = arguments.iter().map(String::as_str).collect::<Vec<_>>();
    match args.as_slice() {
        [
            "begin-install",
            id,
            digest,
            source,
            node,
            version,
            product_code,
        ] => {
            let target = RuntimeIdentity::from_fields(&[id, digest, source, node, version])?;
            begin(store, id, product_code, Operation::Install(target))
        }
        ["begin-remove", id, product_code] => begin(store, id, product_code, Operation::Remove),
        ["join-remove", id, parent] => join_remove(store, id, parent),
        ["verify", id, digest, source, node, version] => {
            let target = RuntimeIdentity::from_fields(&[id, digest, source, node, version])?;
            verify(store, id, &target)
        }
        ["rollback", id] => rollback(store, id),
        ["commit-install", id] => commit(store, id, false),
        ["commit-remove", id] => commit(store, id, true),
        _ => Err(Error::Identity),
    }
}

#[cfg(test)]
#[path = "runtime_transaction_tests.rs"]
mod tests;
