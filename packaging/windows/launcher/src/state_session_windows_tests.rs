// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::*;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

#[link(name = "advapi32")]
unsafe extern "system" {
    fn ConvertStringSidToSidW(string: *const u16, sid: *mut *mut c_void) -> i32;
    fn GetSecurityDescriptorDacl(
        descriptor: *const c_void,
        present: *mut i32,
        acl: *mut *mut Acl,
        defaulted: *mut i32,
    ) -> i32;
    fn SetSecurityInfo(
        handle: RawHandle,
        kind: u32,
        information: u32,
        owner: *const c_void,
        group: *const c_void,
        dacl: *const Acl,
        sacl: *const Acl,
    ) -> u32;
}

fn unique_name() -> String {
    format!(
        "qualification-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    )
}

struct Fixture {
    root: String,
    sid: String,
}

impl Fixture {
    fn new() -> Self {
        let sid = current_sid().unwrap();
        let root = format!(
            "{}:\\NemoClawState-{}",
            windows_drive().unwrap(),
            unique_name()
        );
        let (_, created) = state_directory(&root, &sid).unwrap();
        assert!(created, "The unique qualification directory must be new");
        Self { root, sid }
    }

    fn write_security(&self, information: u32, owner: *const c_void, acl: *const Acl) {
        let root = wide(&self.root);
        let handle = unsafe {
            CreateFileW(
                root.as_ptr(),
                READ_CONTROL | 0x000c_0000,
                7,
                null(),
                3,
                0x0220_0000,
                null_mut(),
            )
        };
        assert!(handle as isize != -1 && !handle.is_null());
        let handle = Handle(handle);
        assert_eq!(
            unsafe { SetSecurityInfo(handle.0, 1, information, owner, null(), acl, null()) },
            0
        );
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        // Delete only this test's marker and empty directory/junction. Never
        // recurse or address the stable per-user/agent production state paths.
        let _ = std::fs::remove_file(Path::new(&self.root).join("qualification-marker.txt"));
        let _ = std::fs::remove_dir(&self.root);
    }
}

#[test]
fn private_directory_reuse_preserves_data_and_releases_handles() {
    let fixture = Fixture::new();
    let marker = Path::new(&fixture.root).join("qualification-marker.txt");
    std::fs::write(&marker, b"persistent agent data").unwrap();
    let (handle, created) = state_directory(&fixture.root, &fixture.sid).unwrap();
    assert!(!created);
    assert_eq!(std::fs::read(&marker).unwrap(), b"persistent agent data");
    verify_security(&handle, &fixture.sid, true).unwrap();
    drop(handle);
    let root = fixture.root.clone();
    drop(fixture);
    assert!(
        !Path::new(&root).exists(),
        "Releasing the handle permits fixture cleanup"
    );
}

#[test]
fn a_second_session_is_rejected_until_ownership_is_released() {
    let sid = current_sid().unwrap();
    let name = unique_name();
    let lease = acquire(&sid, &name).unwrap();
    let other_sid = sid.clone();
    let other_name = name.clone();
    let blocked = std::thread::spawn(move || acquire(&other_sid, &other_name).err())
        .join()
        .unwrap();
    assert!(
        blocked
            .unwrap()
            .contains("already has an active native session")
    );
    drop(lease);
    std::thread::spawn(move || {
        let _lease = acquire(&sid, &name).unwrap();
    })
    .join()
    .unwrap();
}

#[test]
fn an_active_directory_cannot_be_replaced() {
    let fixture = Fixture::new();
    let (handle, _) = state_directory(&fixture.root, &fixture.sid).unwrap();
    assert!(std::fs::rename(&fixture.root, format!("{}.moved", fixture.root)).is_err());
    assert!(Path::new(&fixture.root).is_dir());
    drop(handle);
}

#[test]
fn reparse_state_is_rejected_without_following_the_target() {
    let target = Fixture::new();
    let fixture = Fixture::new();
    std::fs::remove_dir(&fixture.root).unwrap();
    // Native packaging qualification is elevated for MSI installation. This
    // checks the real Windows symlink path; inability to create it is a failure.
    std::os::windows::fs::symlink_dir(&target.root, &fixture.root).unwrap();
    let error = state_directory(&fixture.root, &fixture.sid).err().unwrap();
    assert!(error.contains("without a reparse point"));
    assert!(Path::new(&target.root).is_dir());
}

#[test]
fn an_existing_foreign_owner_is_rejected_without_repair() {
    let fixture = Fixture::new();
    let mut administrator_sid = null_mut();
    assert_ne!(
        unsafe { ConvertStringSidToSidW(wide("S-1-5-32-544").as_ptr(), &mut administrator_sid) },
        0
    );
    let _owner_memory = LocalMemory(administrator_sid);
    // The elevated qualification account can assign its Administrators group as
    // owner, while retaining the current-user DACL so the fixture stays removable.
    fixture.write_security(1, administrator_sid, null());
    let error = state_directory(&fixture.root, &fixture.sid).err().unwrap();
    assert!(error.contains("belongs to another Windows account"));
}

#[test]
fn a_broad_access_grant_is_rejected_without_rewriting_existing_state() {
    let fixture = Fixture::new();
    let sddl = wide(&format!(
        "O:{}D:P(A;OICI;FA;;;{})(A;OICI;FA;;;SY)(A;OICI;FR;;;WD)",
        fixture.sid, fixture.sid
    ));
    let mut descriptor = null_mut();
    assert_ne!(
        unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                sddl.as_ptr(),
                1,
                &mut descriptor,
                null_mut(),
            )
        },
        0
    );
    let _memory = LocalMemory(descriptor);
    let mut present = 0;
    let mut defaulted = 0;
    let mut dacl = null_mut();
    assert_ne!(
        unsafe { GetSecurityDescriptorDacl(descriptor, &mut present, &mut dacl, &mut defaulted) },
        0
    );
    assert_ne!(present, 0);
    fixture.write_security(0x8000_0004, null(), dacl);
    let error = state_directory(&fixture.root, &fixture.sid).err().unwrap();
    assert!(error.contains("unexpected grants"));
}

#[test]
fn selected_state_removal_uses_held_handles_and_does_not_create_absent_state() {
    let fixture = Fixture::new();
    let nested = Path::new(&fixture.root).join("nested");
    std::fs::create_dir(&nested).unwrap();
    std::fs::write(nested.join("data.txt"), b"owned test data").unwrap();
    let readonly = nested.join("readonly.txt");
    std::fs::write(&readonly, b"owned read-only data").unwrap();
    let mut permissions = std::fs::metadata(&readonly).unwrap().permissions();
    permissions.set_readonly(true);
    std::fs::set_permissions(&readonly, permissions).unwrap();
    assert!(remove_owned_tree(&fixture.root, &fixture.sid).unwrap());
    assert!(!Path::new(&fixture.root).exists());
    assert!(!remove_owned_tree(&fixture.root, &fixture.sid).unwrap());
    assert!(!Path::new(&fixture.root).exists());
}

#[test]
fn removal_rejects_a_nested_reparse_point_before_deleting_any_owned_file() {
    let target = Fixture::new();
    let fixture = Fixture::new();
    let marker = Path::new(&fixture.root).join("qualification-marker.txt");
    std::fs::write(&marker, b"must survive rejected removal").unwrap();
    let link = Path::new(&fixture.root).join("outside");
    std::os::windows::fs::symlink_dir(&target.root, &link).unwrap();
    let error = remove_owned_tree(&fixture.root, &fixture.sid).unwrap_err();
    assert!(error.contains("reparse point"));
    assert_eq!(std::fs::read(&marker).unwrap(), b"must survive rejected removal");
    assert!(Path::new(&target.root).is_dir());
    std::fs::remove_dir(link).unwrap();
}

#[test]
fn removing_a_readonly_hard_link_preserves_the_other_name_and_its_attributes() {
    let target = Fixture::new();
    let fixture = Fixture::new();
    let original = Path::new(&target.root).join("qualification-marker.txt");
    std::fs::write(&original, b"other owned fixture data").unwrap();
    std::fs::hard_link(&original, Path::new(&fixture.root).join("linked-data.txt")).unwrap();
    let mut permissions = std::fs::metadata(&original).unwrap().permissions();
    permissions.set_readonly(true);
    std::fs::set_permissions(&original, permissions).unwrap();
    assert!(remove_owned_tree(&fixture.root, &fixture.sid).unwrap());
    assert_eq!(std::fs::read(&original).unwrap(), b"other owned fixture data");
    assert!(std::fs::metadata(&original).unwrap().permissions().readonly());
    let mut permissions = std::fs::metadata(&original).unwrap().permissions();
    permissions.set_readonly(false);
    std::fs::set_permissions(&original, permissions).unwrap();
}
