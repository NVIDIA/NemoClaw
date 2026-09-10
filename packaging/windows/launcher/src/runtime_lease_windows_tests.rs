// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use super::*;
use std::os::windows::ffi::OsStrExt;
use std::path::{Path, PathBuf};

#[repr(C)]
struct SecurityAttributes {
    length: u32,
    descriptor: *mut c_void,
    inherit: i32,
}
#[link(name = "advapi32")]
unsafe extern "system" {
    fn ConvertStringSecurityDescriptorToSecurityDescriptorW(
        value: *const u16,
        revision: u32,
        descriptor: *mut *mut c_void,
        size: *mut u32,
    ) -> i32;
}
#[link(name = "kernel32")]
unsafe extern "system" {
    fn CreateDirectoryW(path: *const u16, security: *const SecurityAttributes) -> i32;
    fn CreateFileW(
        path: *const u16,
        access: u32,
        share: u32,
        security: *const SecurityAttributes,
        disposition: u32,
        flags: u32,
        template: RawHandle,
    ) -> RawHandle;
    fn WriteFile(
        handle: RawHandle,
        bytes: *const c_void,
        length: u32,
        written: *mut u32,
        overlapped: *mut c_void,
    ) -> i32;
}
fn wide(path: &Path) -> Vec<u16> {
    path.as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}
fn security(writable: bool) -> LocalMemory {
    let value = if writable {
        "O:BAD:P(A;OICI;FA;;;BA)(A;OICI;FA;;;SY)(A;OICI;FA;;;BU)"
    } else {
        "O:BAD:P(A;OICI;FA;;;BA)(A;OICI;FA;;;SY)(A;OICI;GRGX;;;BU)(A;OICI;GRGX;;;AC)"
    };
    let value = value
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let mut output = null_mut();
    assert_ne!(
        unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                value.as_ptr(),
                1,
                &mut output,
                null_mut(),
            )
        },
        0
    );
    LocalMemory(output)
}
fn directory(path: &Path, writable: bool) {
    let security = security(writable);
    let attributes = SecurityAttributes {
        length: std::mem::size_of::<SecurityAttributes>() as u32,
        descriptor: security.0,
        inherit: 0,
    };
    assert_ne!(
        unsafe { CreateDirectoryW(wide(path).as_ptr(), &attributes) },
        0,
        "fixture needs the same elevated Program Files installation authority: {}",
        std::io::Error::last_os_error()
    );
}
fn file(path: &Path, bytes: &[u8]) {
    let security = security(false);
    let attributes = SecurityAttributes {
        length: std::mem::size_of::<SecurityAttributes>() as u32,
        descriptor: security.0,
        inherit: 0,
    };
    let handle = unsafe {
        CreateFileW(
            wide(path).as_ptr(),
            0x40000000,
            0,
            &attributes,
            1,
            0x80,
            null_mut(),
        )
    };
    assert_ne!(handle as isize, -1);
    let handle = Handle(handle);
    let mut written = 0;
    assert_ne!(
        unsafe {
            WriteFile(
                handle.0,
                bytes.as_ptr().cast(),
                bytes.len() as u32,
                &mut written,
                null_mut(),
            )
        },
        0
    );
    assert_eq!(written as usize, bytes.len());
}
struct Fixture {
    root: PathBuf,
    descriptor: Descriptor,
}
impl Fixture {
    fn new(writable: bool) -> Self {
        let installed = installed_path().unwrap();
        let program_files = installed.strip_suffix("\\NVIDIA\\NemoClaw").unwrap();
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = PathBuf::from(program_files).join(format!(
            "NemoClawLeaseFixture-{}-{nonce:x}",
            std::process::id()
        ));
        directory(&root, writable);
        directory(&root.join("runtimes"), false);
        let descriptor = Descriptor {
            runtime_id: "a".repeat(64),
            manifest_sha256: "b".repeat(64),
            source_revision: "c".repeat(40),
            node_sha256: "d".repeat(64),
            node_version: "22.23.2".into(),
        };
        directory(&root.join("runtimes").join(&descriptor.runtime_id), false);
        file(&root.join("runtime-current"), &descriptor.bytes());
        file(
            &root
                .join("runtimes")
                .join(&descriptor.runtime_id)
                .join("runtime.ready"),
            &descriptor.bytes(),
        );
        Self { root, descriptor }
    }
    fn runtime(&self) -> Runtime {
        Runtime::open(self.root.to_str().unwrap(), &self.descriptor.runtime_id).unwrap()
    }
    fn transition(&self, restore: bool) -> Result<(), &'static str> {
        transition_at(
            self.root.to_str().unwrap(),
            &self.descriptor.runtime_id,
            &self.descriptor.manifest_sha256,
            restore,
        )
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.root).unwrap();
    }
}

#[test]
fn concurrent_readers_block_retirement_until_every_lease_closes() {
    let fixture = Fixture::new(false);
    let control = ControlDirectory::at(fixture.root.to_str().unwrap()).unwrap();
    let first = open(
        control.handles.last(),
        "runtime-current",
        false,
        READ_ACCESS,
        1,
    )
    .unwrap();
    let second = open(
        control.handles.last(),
        "runtime-current",
        false,
        READ_ACCESS,
        1,
    )
    .unwrap();
    assert_eq!(fixture.transition(false), Err("runtime-busy"));
    drop(first);
    assert_eq!(fixture.transition(false), Err("runtime-busy"));
    drop(second);
    fixture.transition(false).unwrap();
    assert!(
        open(
            control.handles.last(),
            "runtime-current",
            false,
            READ_ACCESS,
            1
        )
        .is_err()
    );
    fixture.transition(true).unwrap();
    assert_eq!(
        descriptor(
            &open(
                control.handles.last(),
                "runtime-current",
                false,
                READ_ACCESS,
                1
            )
            .unwrap()
        )
        .unwrap(),
        fixture.descriptor
    );
}
#[test]
fn delete_acquisition_closes_admission_before_atomic_rename() {
    let fixture = Fixture::new(false);
    let control = ControlDirectory::at(fixture.root.to_str().unwrap()).unwrap();
    let retiring = open(
        control.handles.last(),
        "runtime-current",
        false,
        DELETE_ACCESS,
        3,
    )
    .unwrap();
    assert!(matches!(
        open(
            control.handles.last(),
            "runtime-current",
            false,
            READ_ACCESS,
            1
        ),
        Err("runtime-busy")
    ));
    rename(&retiring, "runtime-retired").unwrap();
    drop(retiring);
    assert!(matches!(
        open(
            control.handles.last(),
            "runtime-current",
            false,
            READ_ACCESS,
            1
        ),
        Err("runtime-unavailable")
    ));
    fixture.transition(true).unwrap();
}
#[test]
fn wrong_digest_does_not_retire_or_remove_the_ready_marker() {
    let fixture = Fixture::new(false);
    assert_eq!(
        transition_at(
            fixture.root.to_str().unwrap(),
            &fixture.descriptor.runtime_id,
            &"d".repeat(64),
            false
        ),
        Err("runtime-identity")
    );
    assert!(
        fixture
            .runtime()
            .marker("runtime.ready", READ_ACCESS, 1)
            .is_ok()
    );
}
#[test]
fn user_writable_installed_root_is_refused_without_acl_repair() {
    let fixture = Fixture::new(true);
    assert!(matches!(
        Runtime::open(
            fixture.root.to_str().unwrap(),
            &fixture.descriptor.runtime_id
        ),
        Err("runtime-writable")
    ));
}
#[test]
fn hard_linked_readiness_marker_is_not_a_valid_seal() {
    let fixture = Fixture::new(false);
    let directory = fixture
        .root
        .join("runtimes")
        .join(&fixture.descriptor.runtime_id);
    std::fs::hard_link(directory.join("runtime.ready"), directory.join("alias")).unwrap();
    let runtime = fixture.runtime();
    assert_eq!(
        descriptor(&runtime.marker("runtime.ready", READ_ACCESS, 1).unwrap()),
        Err("runtime-descriptor")
    );
}
#[test]
fn active_runtime_directory_cannot_be_replaced() {
    let fixture = Fixture::new(false);
    let runtime = fixture.runtime();
    let from = fixture
        .root
        .join("runtimes")
        .join(&fixture.descriptor.runtime_id);
    let to = fixture.root.join("runtimes").join("moved");
    assert!(std::fs::rename(&from, &to).is_err());
    drop(runtime);
    std::fs::rename(&from, &to).unwrap();
    std::fs::rename(&to, &from).unwrap();
}

#[test]
fn rollback_after_busy_retirement_is_an_exact_noop() {
    let fixture = Fixture::new(false);
    let control = ControlDirectory::at(fixture.root.to_str().unwrap()).unwrap();
    let lease = open(
        control.handles.last(),
        "runtime-current",
        false,
        READ_ACCESS,
        1,
    )
    .unwrap();
    assert_eq!(fixture.transition(false), Err("runtime-busy"));
    fixture.transition(true).unwrap();
    assert_eq!(descriptor(&lease).unwrap(), fixture.descriptor);
}
#[test]
fn protected_journal_create_read_remove_is_fixed_and_exclusive() {
    let fixture = Fixture::new(false);
    let control = ControlDirectory::at(fixture.root.to_str().unwrap()).unwrap();
    control
        .write_new(ControlFile::Maintenance, b"fixture journal")
        .unwrap();
    assert!(
        control
            .write_new(ControlFile::Maintenance, b"replacement")
            .is_err()
    );
    assert_eq!(
        control.read(ControlFile::Maintenance).unwrap().unwrap(),
        b"fixture journal"
    );
    control.remove(ControlFile::Maintenance).unwrap();
    assert!(control.read(ControlFile::Maintenance).unwrap().is_none());
}

#[test]
fn maintenance_replacement_preserves_old_journal_on_wrong_expectation() {
    let fixture = Fixture::new(false);
    let control = ControlDirectory::at(fixture.root.to_str().unwrap()).unwrap();
    control
        .write_new(ControlFile::Maintenance, b"old intent")
        .unwrap();
    assert_eq!(
        control.replace_exact(ControlFile::Maintenance, b"different", b"new intent"),
        Err("runtime-control-changed")
    );
    assert_eq!(
        control.read(ControlFile::Maintenance).unwrap().unwrap(),
        b"old intent"
    );
    control
        .replace_exact(ControlFile::Maintenance, b"old intent", b"new intent")
        .unwrap();
    assert_eq!(
        control.read(ControlFile::Maintenance).unwrap().unwrap(),
        b"new intent"
    );
    control.remove(ControlFile::Maintenance).unwrap();
}

#[test]
fn content_verifier_reads_pinned_files_and_rejects_escape() {
    let fixture = Fixture::new(false);
    let control = ControlDirectory::at(fixture.root.to_str().unwrap()).unwrap();
    let directory = control.open_content_directory("runtimes").unwrap();
    let mut input = control.open_content_file("runtime-current").unwrap();
    assert_eq!(input.size(), fixture.descriptor.bytes().len() as u64);
    let mut bytes = vec![0u8; input.size() as usize];
    assert_eq!(input.read_chunk(&mut bytes).unwrap(), bytes.len());
    assert_eq!(bytes, fixture.descriptor.bytes());
    assert!(control.open_content_file("../outside").is_err());
    assert!(control.open_content_directory("C:/outside").is_err());
    assert!(std::fs::write(fixture.root.join("runtime-current"), b"overwrite").is_err());
    drop(input);
    drop(directory);
}
