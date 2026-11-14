// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Protocol controls only. This store does not model Windows sharing or MSI
// scheduling; those are separate required Windows integration controls.
use super::*;

fn identity(ch: char) -> RuntimeIdentity {
    RuntimeIdentity {
        runtime_id: ch.to_string().repeat(64),
        manifest_sha256: "b".repeat(64),
        source_revision: "c".repeat(40),
        node_sha256: "d".repeat(64),
        node_version: "22.23.2".into(),
    }
}
const PRODUCT: &str = "{12345678-1234-1234-1234-123456789abc}";

struct Store {
    selected: Option<RuntimeIdentity>,
    journal: Option<Journal>,
    busy: bool,
    corrupt: bool,
    legacy: bool,
    fail_selected_write: bool,
    events: Vec<&'static str>,
}
impl Store {
    fn old() -> Self {
        Self {
            selected: Some(identity('a')),
            journal: None,
            busy: false,
            corrupt: false,
            legacy: false,
            fail_selected_write: false,
            events: vec![],
        }
    }
}
impl NativeStore for Store {
    fn installed_state(&mut self) -> Result<InstalledState, Error> {
        Ok(if self.legacy {
            InstalledState::Legacy
        } else {
            self.selected
                .clone()
                .map_or(InstalledState::Absent, InstalledState::Selected)
        })
    }
    fn read_journal(&mut self) -> Result<Option<Journal>, Error> {
        Ok(self.journal.clone())
    }
    fn create_journal(&mut self, value: &Journal) -> Result<(), Error> {
        assert!(self.journal.is_none());
        self.events.push("block-admission");
        self.journal = Some(value.clone());
        Ok(())
    }
    fn update_journal(&mut self, old: &Journal, next: &Journal) -> Result<(), Error> {
        assert_eq!(self.journal.as_ref(), Some(old));
        if self.fail_selected_write && next.stage == Stage::Selected {
            return Err(Error::Native("journal-write"));
        }
        self.journal = Some(next.clone());
        Ok(())
    }
    fn remove_journal(&mut self, expected: &Journal) -> Result<(), Error> {
        assert_eq!(self.journal.as_ref(), Some(expected));
        self.events.push("open-admission");
        self.journal = None;
        Ok(())
    }
    fn retire_selected(&mut self, expected: &RuntimeIdentity) -> Result<(), Error> {
        assert_eq!(self.selected.as_ref(), Some(expected));
        if self.busy {
            return Err(Error::Busy);
        }
        self.events.push("retire");
        self.selected = None;
        Ok(())
    }
    fn verify_complete_content(&mut self, _expected: &RuntimeIdentity) -> Result<(), Error> {
        self.events.push("verify-full-content");
        if self.corrupt {
            return Err(Error::Native("content-mismatch"));
        }
        Ok(())
    }
    fn restore_previous(&mut self, previous: Option<&RuntimeIdentity>) -> Result<(), Error> {
        self.events.push("restore-after-rollback");
        self.selected = previous.cloned();
        Ok(())
    }
    fn select_verified(&mut self, value: &RuntimeIdentity) -> Result<(), Error> {
        assert!(self.journal.is_some());
        self.events.push("select");
        self.selected = Some(value.clone());
        Ok(())
    }
    fn finish_removal(&mut self, _previous: Option<&RuntimeIdentity>) -> Result<(), Error> {
        self.events.push("finish-removal");
        self.selected = None;
        Ok(())
    }
}

#[test]
fn busy_retirement_preserves_selection_until_explicit_rollback() {
    let mut store = Store::old();
    store.busy = true;
    let next = identity('e');
    assert_eq!(
        begin(
            &mut store,
            &next.runtime_id,
            PRODUCT,
            Operation::Install(next.clone())
        ),
        Err(Error::Busy)
    );
    assert_eq!(store.selected, Some(identity('a')));
    assert_eq!(store.events, vec!["block-admission"]);
    assert!(store.journal.is_some());
    rollback(&mut store, &next.runtime_id).unwrap();
    assert_eq!(store.selected, Some(identity('a')));
    assert!(store.journal.is_none());
}

#[test]
fn rollback_verifies_restored_content_before_reopening() {
    let mut store = Store::old();
    let next = identity('e');
    begin(
        &mut store,
        &next.runtime_id,
        PRODUCT,
        Operation::Install(next.clone()),
    )
    .unwrap();
    store.corrupt = true;
    assert_eq!(
        rollback(&mut store, &next.runtime_id),
        Err(Error::Native("content-mismatch"))
    );
    assert!(store.selected.is_none());
    assert!(store.journal.is_some());
    store.corrupt = false;
    rollback(&mut store, &next.runtime_id).unwrap();
    assert_eq!(
        &store.events[store.events.len() - 3..],
        &[
            "verify-full-content",
            "restore-after-rollback",
            "open-admission"
        ]
    );
}

#[test]
fn a_public_parent_property_cannot_substitute_for_a_matching_retired_journal() {
    let mut store = Store::old();
    let next = identity('e');
    assert_eq!(
        join_remove(&mut store, &identity('a').runtime_id, PRODUCT),
        Err(Error::NoTransaction)
    );
    begin(
        &mut store,
        &next.runtime_id,
        PRODUCT,
        Operation::Install(next.clone()),
    )
    .unwrap();
    assert_eq!(
        join_remove(&mut store, &identity('f').runtime_id, PRODUCT),
        Err(Error::ForeignTransaction)
    );
    join_remove(&mut store, &identity('a').runtime_id, PRODUCT).unwrap();
}

#[test]
fn commit_cannot_select_an_unverified_runtime() {
    let mut store = Store::old();
    let next = identity('e');
    begin(
        &mut store,
        &next.runtime_id,
        PRODUCT,
        Operation::Install(next.clone()),
    )
    .unwrap();
    assert_eq!(
        commit(&mut store, &next.runtime_id, false),
        Err(Error::ForeignTransaction)
    );
    assert!(store.selected.is_none());
    verify(&mut store, &next.runtime_id, &next).unwrap();
    commit(&mut store, &next.runtime_id, false).unwrap();
    assert_eq!(store.selected, Some(next));
    assert!(store.journal.is_none());
}

#[test]
fn a_partial_commit_keeps_rollback_identity_and_admission_closed() {
    let mut store = Store::old();
    let next = identity('e');
    begin(
        &mut store,
        &next.runtime_id,
        PRODUCT,
        Operation::Install(next.clone()),
    )
    .unwrap();
    verify(&mut store, &next.runtime_id, &next).unwrap();
    store.fail_selected_write = true;
    assert_eq!(
        commit(&mut store, &next.runtime_id, false),
        Err(Error::Native("journal-write"))
    );
    assert!(store.journal.is_some());
    rollback(&mut store, &next.runtime_id).unwrap();
    assert_eq!(store.selected, Some(identity('a')));
    assert!(store.journal.is_none());
}

#[test]
fn direct_uninstall_retires_before_commit_and_does_not_select_a_runtime() {
    let mut store = Store::old();
    let owner = identity('a').runtime_id;
    begin(&mut store, &owner, PRODUCT, Operation::Remove).unwrap();
    assert!(store.selected.is_none());
    assert!(store.journal.is_some());
    commit(&mut store, &owner, true).unwrap();
    assert!(store.selected.is_none());
    assert!(store.journal.is_none());
}

#[test]
fn legacy_transition_is_refused_without_claiming_a_marker_proves_quiescence() {
    let mut store = Store::old();
    store.legacy = true;
    let next = identity('e');
    assert_eq!(
        begin(
            &mut store,
            &next.runtime_id,
            PRODUCT,
            Operation::Install(next.clone())
        ),
        Err(Error::LegacyRequiresStopFirst)
    );
    assert!(store.events.is_empty());
    assert!(store.journal.is_none());
}

#[test]
fn first_install_rollback_restores_absence() {
    let mut store = Store::old();
    store.selected = None;
    let next = identity('e');
    begin(
        &mut store,
        &next.runtime_id,
        PRODUCT,
        Operation::Install(next.clone()),
    )
    .unwrap();
    rollback(&mut store, &next.runtime_id).unwrap();
    assert!(store.selected.is_none());
    assert!(store.journal.is_none());
}

#[test]
fn a_stale_product_uninstall_cannot_retire_a_different_selected_runtime() {
    let mut store = Store::old();
    assert_eq!(
        begin(
            &mut store,
            &identity('e').runtime_id,
            PRODUCT,
            Operation::Remove
        ),
        Err(Error::ForeignTransaction)
    );
    assert_eq!(store.selected, Some(identity('a')));
    assert!(store.events.is_empty());
    assert!(store.journal.is_none());
}

#[test]
fn journal_codec_rejects_extra_data_and_preserves_prior_shared_node_tuple() {
    let mut store = Store::old();
    let next = identity('e');
    begin(
        &mut store,
        &next.runtime_id,
        PRODUCT,
        Operation::Install(next.clone()),
    )
    .unwrap();
    let journal = store.journal.unwrap();
    let bytes = journal.bytes().unwrap();
    assert_eq!(Journal::parse(&bytes), Ok(journal));
    let mut changed = bytes.clone();
    changed.extend_from_slice(b"extra\n");
    assert_eq!(Journal::parse(&changed), Err(Error::Identity));
    assert_eq!(
        Journal::parse(&bytes[..bytes.len() - 1]),
        Err(Error::Identity)
    );
}

#[test]
fn helper_dispatch_rejects_unexpected_arguments_before_native_operations() {
    let mut store = Store::old();
    assert_eq!(
        dispatch(
            &mut store,
            &[
                "begin-remove".into(),
                identity('a').runtime_id,
                PRODUCT.into(),
                "--root".into(),
                "C:\\foreign".into()
            ]
        ),
        Err(Error::Identity)
    );
    assert!(store.events.is_empty());
}

#[test]
fn a_namespace_cannot_be_reused_for_a_different_sealed_tuple() {
    let mut store = Store::old();
    let mut target = identity('a');
    target.manifest_sha256 = "f".repeat(64);
    assert_eq!(
        begin(
            &mut store,
            &target.runtime_id,
            PRODUCT,
            Operation::Install(target.clone())
        ),
        Err(Error::Native("runtime-namespace-reused"))
    );
    assert!(store.events.is_empty());
    assert!(store.journal.is_none());
}
