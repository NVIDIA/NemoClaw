// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use crate::metadata_acl::{Descriptor, MAX_DESCRIPTOR, hex};
use std::ffi::{OsStr, c_void};
use std::os::windows::ffi::OsStrExt;
use std::ptr::{null, null_mut};
use std::time::Instant;

type RawHandle = *mut c_void;
struct Handle(RawHandle);
impl Drop for Handle {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.0);
        }
    }
}
struct LocalDescriptor(*mut c_void);
impl Drop for LocalDescriptor {
    fn drop(&mut self) {
        unsafe {
            LocalFree(self.0);
        }
    }
}

#[repr(C)]
#[derive(Default)]
struct FileInformation {
    attributes: u32,
    creation: [u32; 2],
    access: [u32; 2],
    write: [u32; 2],
    volume: u32,
    size_high: u32,
    size_low: u32,
    links: u32,
    index_high: u32,
    index_low: u32,
}

fn wide(value: &OsStr) -> Vec<u16> {
    value.encode_wide().chain([0]).collect()
}
fn api_error(stage: &str) -> String {
    format!("{stage}: Win32 error {}", unsafe { GetLastError() })
}

fn system_drive() -> Result<String, String> {
    // Resolve the actual Windows installation volume, never an environment
    // variable, working directory, caller path or user registry value.
    let mut windows = vec![0u16; 32768];
    let length =
        unsafe { GetSystemWindowsDirectoryW(windows.as_mut_ptr(), windows.len() as u32) } as usize;
    if length == 0 || length >= windows.len() {
        return Err(api_error("windows-directory"));
    }
    let mut volume = vec![0u16; 32768];
    if unsafe { GetVolumePathNameW(windows.as_ptr(), volume.as_mut_ptr(), volume.len() as u32) }
        == 0
    {
        return Err(api_error("windows-volume"));
    }
    let end = volume
        .iter()
        .position(|value| *value == 0)
        .ok_or("windows-volume-bound")?;
    if end != 3 || !matches!(volume[0], 65..=90 | 97..=122) || volume[1] != 58 || volume[2] != 92 {
        return Err("The Windows volume is not an ordinary local drive root.".into());
    }
    let mut filesystem = [0u16; 32];
    if unsafe {
        GetVolumeInformationW(
            volume.as_ptr(),
            null_mut(),
            0,
            null_mut(),
            null_mut(),
            null_mut(),
            filesystem.as_mut_ptr(),
            filesystem.len() as u32,
        )
    } == 0
    {
        return Err(api_error("windows-filesystem"));
    }
    let fs_end = filesystem
        .iter()
        .position(|value| *value == 0)
        .ok_or("filesystem-name-bound")?;
    if String::from_utf16_lossy(&filesystem[..fs_end]) != "NTFS" {
        return Err("The Windows volume must use NTFS.".into());
    }
    Ok(String::from_utf16_lossy(&volume[..end]))
}

const READ_CONTROL: u32 = 0x0002_0000;
const WRITE_DAC: u32 = 0x0004_0000;

fn open(path: &OsStr, directory: bool, access: u32) -> Result<Handle, String> {
    let name = wide(path);
    let raw = unsafe { CreateFileW(name.as_ptr(), access, 7, null(), 3, 0x0220_0000, null_mut()) };
    if raw as isize == -1 {
        return Err(api_error(if access == READ_CONTROL {
            "open-metadata-inspection-target"
        } else {
            "open-metadata-update-target"
        }));
    }
    let handle = Handle(raw);
    identity(&handle, directory)?;
    Ok(handle)
}

fn identity(handle: &Handle, directory: bool) -> Result<(u32, u32, u32), String> {
    let mut info = FileInformation::default();
    if unsafe { GetFileInformationByHandle(handle.0, &mut info) } == 0 {
        return Err(api_error("metadata-target-identity"));
    }
    if info.attributes & 0x400 != 0 || (directory && info.attributes & 0x10 == 0) {
        return Err("The metadata target is redirected or is not a directory.".into());
    }
    Ok((info.volume, info.index_high, info.index_low))
}

fn open_update(
    path: &OsStr,
    directory: bool,
    inspected: &Handle,
    before: &Descriptor,
) -> Result<Handle, String> {
    // Security inspection and DACL updates need no data-write/delete access.
    // Keep the inspected object held while admitting this narrower update handle.
    let update = open(path, directory, READ_CONTROL | WRITE_DAC)?;
    if identity(inspected, directory)? != identity(&update, directory)? {
        return Err("The metadata target changed before its update.".into());
    }
    if read(&update)?.bytes != before.bytes {
        return Err("The metadata descriptor changed before its update.".into());
    }
    Ok(update)
}

fn read(handle: &Handle) -> Result<Descriptor, String> {
    let mut pointer = null_mut();
    let status = unsafe {
        GetSecurityInfo(
            handle.0,
            1,
            7,
            null_mut(),
            null_mut(),
            null_mut(),
            null_mut(),
            &mut pointer,
        )
    };
    if status != 0 {
        return Err(format!("read-descriptor: Win32 error {status}"));
    }
    if pointer.is_null() {
        return Err("The metadata descriptor is missing.".into());
    }
    let allocation = LocalDescriptor(pointer);
    if unsafe { IsValidSecurityDescriptor(allocation.0) } == 0 {
        return Err("The metadata descriptor is invalid.".into());
    }
    let size = unsafe { GetSecurityDescriptorLength(allocation.0) } as usize;
    if !(20..=MAX_DESCRIPTOR).contains(&size) {
        return Err("The metadata descriptor exceeds its bound.".into());
    }
    let bytes = unsafe { std::slice::from_raw_parts(allocation.0.cast::<u8>(), size) }.to_vec();
    Descriptor::parse(bytes).map_err(str::to_owned)
}

fn write(handle: &Handle, acl: &[u8], control: u16) -> Result<(), String> {
    // SetSecurityInfo propagates existing inheritable ACEs when the handle was
    // not opened MAXIMUM_ALLOWED. Set this one held object's DACL directly;
    // retain existing control bits and request no owner/group/SACL/protection change.
    let mut aligned = vec![0u32; (20 + acl.len()).div_ceil(4)];
    let bytes = unsafe {
        std::slice::from_raw_parts_mut(aligned.as_mut_ptr().cast::<u8>(), 20 + acl.len())
    };
    bytes[0] = 1;
    bytes[2..4].copy_from_slice(&control.to_le_bytes());
    bytes[16..20].copy_from_slice(&20u32.to_le_bytes());
    bytes[20..].copy_from_slice(acl);
    let status = unsafe { NtSetSecurityObject(handle.0, 4, aligned.as_mut_ptr().cast()) };
    if status != 0 {
        return Err(format!("write-metadata-dacl: Win32 error {}", unsafe {
            RtlNtStatusToDosError(status)
        }));
    }
    Ok(())
}

struct Preparation {
    before: Descriptor,
    after: Descriptor,
    additions: usize,
    write_micros: u128,
    write_result: Result<(), String>,
    verification: Result<(), String>,
}

fn prepare_target(path: &OsStr, directory: bool) -> Result<Preparation, String> {
    let inspected = open(path, directory, READ_CONTROL)?;
    let before = read(&inspected)?;
    let plan = before.plan().map_err(str::to_owned)?;
    let update = if plan.additions == 0 {
        None
    } else {
        Some(open_update(path, directory, &inspected, &before)?)
    };
    let handle = update.as_ref().unwrap_or(&inspected);
    let timer = Instant::now();
    let write_result = if plan.additions == 0 {
        Ok(())
    } else {
        write(handle, &plan.acl, before.control)
    };
    let write_micros = if plan.additions == 0 {
        0
    } else {
        timer.elapsed().as_micros()
    };
    // Retain post-write data even if the native setter reported a failure.
    let after = read(handle)?;
    let verification = before.verify(&plan, &after).map_err(str::to_owned);
    Ok(Preparation {
        before,
        after,
        additions: plan.additions,
        write_micros,
        write_result,
        verification,
    })
}

pub fn prepare_system_drive() -> Result<(usize, usize), String> {
    let root = system_drive()?;
    let prepared = prepare_target(OsStr::new(&root), true)?;
    let Preparation {
        before,
        after,
        additions,
        write_micros,
        write_result,
        verification,
    } = prepared;
    println!(
        r#"{{"schemaVersion":1,"classification":"nemoclaw-system-drive-metadata","systemDriveRoot":"{}:\\","addedAces":{},"writeCalls":{},"writeMicroseconds":{},"beforeControl":{},"afterControl":{},"beforeDescriptorHex":"{}","afterDescriptorHex":"{}","verified":{},"saclWriteRequested":false,"customerPathRegistryChanged":false}}"#,
        root.as_bytes()[0] as char,
        additions,
        usize::from(additions != 0),
        write_micros,
        before.control,
        after.control,
        hex(&before.bytes),
        hex(&after.bytes),
        write_result.is_ok() && verification.is_ok()
    );
    write_result?;
    verification?;
    Ok((additions, usize::from(additions != 0)))
}

#[link(name = "kernel32")]
unsafe extern "system" {
    fn GetLastError() -> u32;
    #[cfg(test)]
    fn SetLastError(error: u32);
    fn GetSystemWindowsDirectoryW(buffer: *mut u16, size: u32) -> u32;
    fn GetVolumePathNameW(file: *const u16, volume: *mut u16, size: u32) -> i32;
    fn GetVolumeInformationW(
        root: *const u16,
        label: *mut u16,
        label_size: u32,
        serial: *mut u32,
        component: *mut u32,
        flags: *mut u32,
        filesystem: *mut u16,
        filesystem_size: u32,
    ) -> i32;
    fn CreateFileW(
        name: *const u16,
        access: u32,
        share: u32,
        security: *const c_void,
        creation: u32,
        flags: u32,
        template: RawHandle,
    ) -> RawHandle;
    fn GetFileInformationByHandle(handle: RawHandle, info: *mut FileInformation) -> i32;
    fn CloseHandle(handle: RawHandle) -> i32;
    fn LocalFree(pointer: *mut c_void) -> *mut c_void;
}
#[link(name = "advapi32")]
unsafe extern "system" {
    fn GetSecurityInfo(
        handle: RawHandle,
        kind: i32,
        information: u32,
        owner: *mut *mut c_void,
        group: *mut *mut c_void,
        dacl: *mut *mut c_void,
        sacl: *mut *mut c_void,
        descriptor: *mut *mut c_void,
    ) -> u32;
    #[cfg(test)]
    fn GetKernelObjectSecurity(
        handle: RawHandle,
        information: u32,
        descriptor: *mut c_void,
        bytes: u32,
        needed: *mut u32,
    ) -> i32;
    fn GetSecurityDescriptorLength(descriptor: *mut c_void) -> u32;
    fn IsValidSecurityDescriptor(descriptor: *mut c_void) -> i32;
}

#[link(name = "ntdll")]
unsafe extern "system" {
    fn NtSetSecurityObject(handle: RawHandle, information: u32, descriptor: *const c_void) -> i32;
    fn RtlNtStatusToDosError(status: i32) -> u32;
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fixture(std::path::PathBuf);
    impl Drop for Fixture {
        fn drop(&mut self) {
            if let Err(error) = std::fs::remove_dir_all(&self.0) {
                if std::thread::panicking() {
                    eprintln!("Owned fixture cleanup also failed: {error}");
                } else {
                    panic!("Owned fixture cleanup failed: {error}");
                }
            }
        }
    }
    fn fixture(label: &str) -> Fixture {
        let path =
            std::env::temp_dir().join(format!("nemoclaw-metadata-{label}-{}", std::process::id()));
        assert!(!path.exists());
        std::fs::create_dir(&path).unwrap();
        Fixture(path)
    }
    fn competing_reader(path: &OsStr) -> Handle {
        let name = wide(path);
        let handle = unsafe {
            CreateFileW(
                name.as_ptr(),
                0x8000_0000,
                1,
                null(),
                3,
                0x0220_0000,
                null_mut(),
            )
        };
        assert_ne!(handle as isize, -1, "{}", api_error("fixture-reader"));
        Handle(handle)
    }
    fn assert_legacy_sharing_failure(path: &OsStr) {
        let name = wide(path);
        let handle = unsafe {
            CreateFileW(
                name.as_ptr(),
                0x0200_0000,
                7,
                null(),
                3,
                0x0220_0000,
                null_mut(),
            )
        };
        let error = unsafe { GetLastError() };
        if handle as isize != -1 {
            drop(Handle(handle));
        }
        assert_eq!(
            handle as isize, -1,
            "The actual competing handle must reproduce the former broad-open failure"
        );
        assert_eq!(error, 32);
    }
    fn kernel_descriptor(handle: &Handle) -> Descriptor {
        let mut storage = vec![0u32; MAX_DESCRIPTOR / 4];
        let mut needed = 0;
        assert_ne!(
            unsafe {
                GetKernelObjectSecurity(
                    handle.0,
                    7,
                    storage.as_mut_ptr().cast(),
                    MAX_DESCRIPTOR as u32,
                    &mut needed,
                )
            },
            0
        );
        assert_ne!(
            unsafe { IsValidSecurityDescriptor(storage.as_mut_ptr().cast()) },
            0
        );
        let length = unsafe { GetSecurityDescriptorLength(storage.as_mut_ptr().cast()) } as usize;
        assert!((20..=MAX_DESCRIPTOR).contains(&length));
        let bytes = unsafe { std::slice::from_raw_parts(storage.as_ptr().cast::<u8>(), length) };
        Descriptor::parse(bytes.to_vec()).unwrap()
    }
    fn verified(result: Preparation) -> Preparation {
        assert!(result.write_result.is_ok(), "{:?}", result.write_result);
        assert!(result.verification.is_ok(), "{:?}", result.verification);
        result
    }
    #[test]
    fn intended_update_preserves_owned_descendants_and_repeats_without_write() {
        let root =
            std::env::temp_dir().join(format!("nemoclaw-metadata-test-{}", std::process::id()));
        assert!(!root.exists());
        std::fs::create_dir_all(root.join("child")).unwrap();
        let _cleanup = Fixture(root.clone());
        std::fs::write(root.join("child/file"), b"owned").unwrap();
        {
            let child = open(root.join("child").as_os_str(), true, READ_CONTROL).unwrap();
            let file = open(root.join("child/file").as_os_str(), false, READ_CONTROL).unwrap();
            let child_before = read(&child).unwrap();
            let kernel_before = kernel_descriptor(&child);
            let file_before = kernel_descriptor(&file);
            {
                // Add a harmless owner-only inheritable metadata ACE without
                // propagating it. The production update must not subsequently
                // walk/rewrite the deliberately unchanged existing descendants.
                let parent = open(root.as_os_str(), true, READ_CONTROL | WRITE_DAC).unwrap();
                let initial = read(&parent).unwrap();
                let owner = initial.owner.as_ref().unwrap();
                let mut extra = vec![0, 3];
                extra.extend_from_slice(&u16::try_from(owner.len() + 8).unwrap().to_le_bytes());
                extra.extend_from_slice(&0x80u32.to_le_bytes());
                extra.extend_from_slice(owner);
                let index = initial
                    .aces
                    .iter()
                    .position(|ace| ace[1] & 0x10 != 0)
                    .unwrap_or(initial.aces.len());
                let offset = 8 + initial.aces[..index].iter().map(Vec::len).sum::<usize>();
                let mut acl = initial.acl.clone();
                let mut expected_aces = initial.aces.clone();
                expected_aces.insert(index, extra.clone());
                acl.splice(offset..offset, extra);
                let size = u16::try_from(acl.len()).unwrap();
                acl[2..4].copy_from_slice(&size.to_le_bytes());
                acl[4..6]
                    .copy_from_slice(&u16::try_from(initial.aces.len() + 1).unwrap().to_le_bytes());
                write(&parent, &acl, initial.control).unwrap();
                let constructed = read(&parent).unwrap();
                assert_eq!(constructed.aces, expected_aces);
                assert_eq!(constructed.owner, initial.owner);
                assert_eq!(constructed.group, initial.group);
                let child_after = read(&child).unwrap();
                let kernel_after = kernel_descriptor(&child);
                eprintln!(
                    "Fixture child controls: getter before=0x{:04x}, after=0x{:04x}; kernel before=0x{:04x}, after=0x{:04x}; kernel bytes unchanged={}",
                    child_before.control,
                    child_after.control,
                    kernel_before.control,
                    kernel_after.control,
                    kernel_before.bytes == kernel_after.bytes
                );
                // GetSecurityInfo may synthesize protection/inheritance flags
                // when a parent's inheritable ACEs diverge. Preserve the actual
                // stored descriptor, without accepting any kernel-byte change.
                assert_eq!(kernel_after.bytes, kernel_before.bytes);
                assert_eq!(kernel_descriptor(&file).bytes, file_before.bytes);
            }
            let parent = open(root.as_os_str(), true, READ_CONTROL).unwrap();
            let parent_before = kernel_descriptor(&parent);
            let parent_plan = parent_before.plan().unwrap();
            let result = verified(prepare_target(root.as_os_str(), true).unwrap());
            assert_eq!(result.additions, 2);
            assert_eq!(result.after.plan().unwrap().additions, 0);
            let parent_after = kernel_descriptor(&parent);
            parent_before.verify(&parent_plan, &parent_after).unwrap();
            assert_eq!(parent_after.control, parent_before.control);
            assert_eq!(kernel_descriptor(&child).bytes, kernel_before.bytes);
            assert_eq!(kernel_descriptor(&file).bytes, file_before.bytes);
            let repeated = verified(prepare_target(root.as_os_str(), true).unwrap());
            assert_eq!(repeated.additions, 0);
            assert_eq!(repeated.write_micros, 0);
            assert_eq!(repeated.before.bytes, repeated.after.bytes);
            assert_eq!(kernel_descriptor(&parent).bytes, parent_after.bytes);
            assert_eq!(kernel_descriptor(&child).bytes, kernel_before.bytes);
            assert_eq!(kernel_descriptor(&file).bytes, file_before.bytes);
        }
    }
    #[test]
    fn prepared_target_is_a_noop_with_a_competing_reader() {
        let root = fixture("prepared-sharing");
        verified(prepare_target(root.0.as_os_str(), true).unwrap());
        let _reader = competing_reader(root.0.as_os_str());
        assert_legacy_sharing_failure(root.0.as_os_str());
        let result = verified(prepare_target(root.0.as_os_str(), true).unwrap());
        assert_eq!(result.additions, 0);
        assert_eq!(result.write_micros, 0);
        assert_eq!(result.before.bytes, result.after.bytes);
    }
    #[test]
    fn missing_metadata_aces_use_only_dacl_rights_despite_competing_reader() {
        let root = fixture("missing-sharing");
        let _reader = competing_reader(root.0.as_os_str());
        assert_legacy_sharing_failure(root.0.as_os_str());
        let result = verified(prepare_target(root.0.as_os_str(), true).unwrap());
        assert_eq!(result.additions, 2);
        assert_eq!(result.before.owner, result.after.owner);
        assert_eq!(result.before.group, result.after.group);
    }
    #[test]
    fn changed_descriptor_is_refused_before_a_stale_write() {
        let root = fixture("descriptor-race");
        let inspected = open(root.0.as_os_str(), true, READ_CONTROL).unwrap();
        let before = read(&inspected).unwrap();
        let concurrent = open(root.0.as_os_str(), true, READ_CONTROL | WRITE_DAC).unwrap();
        write(&concurrent, &before.plan().unwrap().acl, before.control).unwrap();
        let current = read(&concurrent).unwrap();
        let error = open_update(root.0.as_os_str(), true, &inspected, &before)
            .err()
            .unwrap();
        assert_eq!(error, "The metadata descriptor changed before its update.");
        assert_eq!(read(&concurrent).unwrap().bytes, current.bytes);
    }
    #[test]
    fn replaced_path_is_refused_before_any_update() {
        let root = fixture("identity-race");
        let target = root.0.join("target");
        std::fs::create_dir(&target).unwrap();
        let inspected = open(target.as_os_str(), true, READ_CONTROL).unwrap();
        let before = read(&inspected).unwrap();
        std::fs::rename(&target, root.0.join("old-target")).unwrap();
        std::fs::create_dir(&target).unwrap();
        let error = open_update(target.as_os_str(), true, &inspected, &before)
            .err()
            .unwrap();
        assert_eq!(error, "The metadata target changed before its update.");
        assert_eq!(read(&inspected).unwrap().bytes, before.bytes);
        let replacement = open(target.as_os_str(), true, READ_CONTROL).unwrap();
        assert_eq!(read(&replacement).unwrap().plan().unwrap().additions, 2);
    }
    #[test]
    fn inspection_handle_cannot_write_and_reports_the_native_error() {
        let root = fixture("query-only-error");
        let inspected = open(root.0.as_os_str(), true, READ_CONTROL).unwrap();
        let before = read(&inspected).unwrap();
        unsafe {
            SetLastError(1234);
        }
        let error = write(&inspected, &before.plan().unwrap().acl, before.control).unwrap_err();
        assert_eq!(error, "write-metadata-dacl: Win32 error 5");
        assert_eq!(read(&inspected).unwrap().bytes, before.bytes);
    }
}
