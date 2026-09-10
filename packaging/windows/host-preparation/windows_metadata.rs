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

fn open(path: &OsStr, directory: bool) -> Result<Handle, String> {
    let name = wide(path);
    let raw = unsafe {
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
    if raw as isize == -1 {
        return Err(api_error("open-metadata-target"));
    }
    let handle = Handle(raw);
    let mut info = FileInformation::default();
    if unsafe { GetFileInformationByHandle(handle.0, &mut info) } == 0 {
        return Err(api_error("metadata-target-identity"));
    }
    if info.attributes & 0x400 != 0 || (directory && info.attributes & 0x10 == 0) {
        return Err("The metadata target is redirected or is not a directory.".into());
    }
    Ok(handle)
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

fn write(handle: &Handle, acl: &[u8]) -> Result<(), String> {
    // Keep an explicitly aligned buffer for the Windows ACL pointer. The call
    // changes DACL only: no owner/group/SACL or protection flag is requested.
    let mut aligned = vec![0u32; acl.len().div_ceil(4)];
    unsafe {
        std::ptr::copy_nonoverlapping(acl.as_ptr(), aligned.as_mut_ptr().cast::<u8>(), acl.len());
    }
    let status = unsafe {
        SetSecurityInfo(
            handle.0,
            1,
            4,
            null_mut(),
            null_mut(),
            aligned.as_mut_ptr().cast(),
            null_mut(),
        )
    };
    if status != 0 {
        return Err(format!("write-metadata-dacl: Win32 error {status}"));
    }
    Ok(())
}

pub fn prepare_system_drive() -> Result<(), String> {
    let root = system_drive()?;
    let handle = open(OsStr::new(&root), true)?;
    let before = read(&handle)?;
    let plan = before.plan().map_err(str::to_owned)?;
    let timer = Instant::now();
    let write_result = if plan.additions == 0 {
        Ok(())
    } else {
        write(&handle, &plan.acl)
    };
    let write_micros = if plan.additions == 0 {
        0
    } else {
        timer.elapsed().as_micros()
    };
    // Retain post-write data even if the native setter reported a failure.
    let after = read(&handle)?;
    let verification = before.verify(&plan, &after).map_err(str::to_owned);
    println!(
        r#"{{"schemaVersion":1,"classification":"nemoclaw-system-drive-metadata","systemDriveRoot":"{}:\\","addedAces":{},"writeCalls":{},"writeMicroseconds":{},"beforeControl":{},"afterControl":{},"beforeDescriptorHex":"{}","afterDescriptorHex":"{}","verified":{},"saclWriteRequested":false,"customerPathRegistryChanged":false}}"#,
        root.as_bytes()[0] as char,
        plan.additions,
        usize::from(plan.additions != 0),
        write_micros,
        before.control,
        after.control,
        hex(&before.bytes),
        hex(&after.bytes),
        write_result.is_ok() && verification.is_ok()
    );
    write_result?;
    verification
}

#[link(name = "kernel32")]
unsafe extern "system" {
    fn GetLastError() -> u32;
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
    fn SetSecurityInfo(
        handle: RawHandle,
        kind: i32,
        information: u32,
        owner: *mut c_void,
        group: *mut c_void,
        dacl: *mut c_void,
        sacl: *mut c_void,
    ) -> u32;
    fn GetSecurityDescriptorLength(descriptor: *mut c_void) -> u32;
    fn IsValidSecurityDescriptor(descriptor: *mut c_void) -> i32;
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
    #[test]
    fn intended_update_preserves_owned_descendants_and_repeats_without_write() {
        let root =
            std::env::temp_dir().join(format!("nemoclaw-metadata-test-{}", std::process::id()));
        assert!(!root.exists());
        std::fs::create_dir_all(root.join("child")).unwrap();
        let _cleanup = Fixture(root.clone());
        std::fs::write(root.join("child/file"), b"owned").unwrap();
        {
            let child = open(root.join("child").as_os_str(), true).unwrap();
            let file = open(root.join("child/file").as_os_str(), false).unwrap();
            let child_before = read(&child).unwrap();
            let file_before = read(&file).unwrap();
            let parent = open(root.as_os_str(), true).unwrap();
            let before = read(&parent).unwrap();
            let plan = before.plan().unwrap();
            assert_eq!(plan.additions, 2);
            write(&parent, &plan.acl).unwrap();
            let after = read(&parent).unwrap();
            before.verify(&plan, &after).unwrap();
            assert_eq!(after.plan().unwrap().additions, 0);
            assert_eq!(read(&child).unwrap().bytes, child_before.bytes);
            assert_eq!(read(&file).unwrap().bytes, file_before.bytes);
        }
    }
}
