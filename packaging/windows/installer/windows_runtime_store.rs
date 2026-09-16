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
use std::ffi::c_void;
use std::fs::OpenOptions;
use std::io::Write;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::ptr::{null, null_mut};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};

const STORAGE_HEADER: &str = "NEMOCLAW_MSI_STORAGE_V1\n";
const EMBEDDED_IMAGE_RUNTIME_ID: Option<&str> = option_env!("NEMOCLAW_RUNTIME_IMAGE_ID");
const EMBEDDED_IMAGE_SHA256: Option<&str> = option_env!("NEMOCLAW_RUNTIME_IMAGE_SHA256");
static LAST_NATIVE_STATUS: AtomicU32 = AtomicU32::new(0);

type RawHandle = *mut c_void;
#[repr(C)]
struct Guid {
    data1: u32,
    data2: u16,
    data3: u16,
    data4: [u8; 8],
}
#[repr(C)]
struct VirtualStorageType {
    device_id: u32,
    vendor_id: Guid,
}
#[repr(C)]
struct OpenVirtualDiskParameters {
    version: u32,
    rw_depth: u32,
}
#[repr(C)]
struct AttachVirtualDiskParameters {
    version: u32,
    reserved: u32,
}
#[repr(C)]
struct AttributeTag {
    attributes: u32,
    tag: u32,
}
#[repr(C)]
#[derive(Clone, Copy, Default)]
struct Luid {
    low: u32,
    high: i32,
}
#[repr(C)]
struct LuidAndAttributes {
    luid: Luid,
    attributes: u32,
}
#[repr(C)]
struct TokenPrivileges {
    count: u32,
    privilege: LuidAndAttributes,
}
#[link(name = "virtdisk")]
unsafe extern "system" {
    fn OpenVirtualDisk(
        storage: *const VirtualStorageType,
        path: *const u16,
        access: u32,
        flags: u32,
        parameters: *const OpenVirtualDiskParameters,
        handle: *mut RawHandle,
    ) -> u32;
    fn AttachVirtualDisk(
        handle: RawHandle,
        security: *const c_void,
        flags: u32,
        provider_flags: u32,
        parameters: *const AttachVirtualDiskParameters,
        overlapped: *mut c_void,
    ) -> u32;
    fn DetachVirtualDisk(handle: RawHandle, flags: u32, provider_flags: u32) -> u32;
}
#[link(name = "kernel32")]
unsafe extern "system" {
    fn CloseHandle(handle: RawHandle) -> i32;
    #[link_name = "CreateFileW"]
    fn StoreCreateFileW(
        path: *const u16,
        access: u32,
        share: u32,
        security: *const c_void,
        disposition: u32,
        flags: u32,
        template: RawHandle,
    ) -> RawHandle;
    fn GetCurrentProcess() -> RawHandle;
    fn GetFileInformationByHandleEx(
        handle: RawHandle,
        class: u32,
        value: *mut c_void,
        size: u32,
    ) -> i32;
    fn GetLastError() -> u32;
    fn LocalFree(memory: *mut c_void) -> *mut c_void;
    fn SetLastError(error: u32);
}
#[link(name = "advapi32")]
unsafe extern "system" {
    fn OpenProcessToken(process: RawHandle, access: u32, token: *mut RawHandle) -> i32;
    fn LookupPrivilegeValueW(system: *const u16, name: *const u16, luid: *mut Luid) -> i32;
    fn AdjustTokenPrivileges(
        token: RawHandle,
        disable_all: i32,
        state: *const TokenPrivileges,
        buffer_length: u32,
        previous: *mut TokenPrivileges,
        return_length: *mut u32,
    ) -> i32;
    fn ConvertStringSecurityDescriptorToSecurityDescriptorW(
        value: *const u16,
        revision: u32,
        descriptor: *mut *mut c_void,
        size: *mut u32,
    ) -> i32;
    fn GetSecurityDescriptorDacl(
        descriptor: *const c_void,
        present: *mut i32,
        dacl: *mut *mut c_void,
        defaulted: *mut i32,
    ) -> i32;
    fn SetSecurityInfo(
        handle: RawHandle,
        kind: u32,
        information: u32,
        owner: *const c_void,
        group: *const c_void,
        dacl: *const c_void,
        sacl: *const c_void,
    ) -> u32;
}
struct Handle(RawHandle);
impl Drop for Handle {
    fn drop(&mut self) {
        unsafe { CloseHandle(self.0) };
    }
}
struct LocalMemory(*mut c_void);
impl Drop for LocalMemory {
    fn drop(&mut self) {
        unsafe { LocalFree(self.0) };
    }
}
struct VirtualDisk(RawHandle);
impl Drop for VirtualDisk {
    fn drop(&mut self) {
        unsafe { CloseHandle(self.0) };
    }
}

fn open_mount_point(path: &Path, access: u32) -> Result<Handle, Error> {
    const DIRECTORY: u32 = 0x10;
    const REPARSE: u32 = 0x400;
    const INVALID: isize = -1;
    let path = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let handle = unsafe {
        StoreCreateFileW(
            path.as_ptr(),
            access | 0x0080,
            7,
            null(),
            3,
            0x0200_0000 | 0x0020_0000,
            null_mut(),
        )
    };
    if handle.is_null() || handle as isize == INVALID {
        LAST_NATIVE_STATUS.store(unsafe { GetLastError() }, Ordering::Relaxed);
        return Err(Error::Native("runtime-image-mount-permissions"));
    }
    let handle = Handle(handle);
    let mut tag = AttributeTag {
        attributes: 0,
        tag: 0,
    };
    if unsafe {
        GetFileInformationByHandleEx(
            handle.0,
            9,
            (&mut tag as *mut AttributeTag).cast(),
            std::mem::size_of::<AttributeTag>() as u32,
        )
    } == 0
        || tag.attributes & DIRECTORY == 0
        || tag.attributes & REPARSE != 0
    {
        LAST_NATIVE_STATUS.store(unsafe { GetLastError() }, Ordering::Relaxed);
        return Err(Error::Native("runtime-image-mount-permissions"));
    }
    Ok(handle)
}

fn authorize_mount_point(path: &Path) -> Result<(), Error> {
    // The immutable volume already grants these package SIDs read/execute on
    // its roots. Grant the same access on the host mount point before it
    // becomes a reparse point, without making any Program Files parent public.
    const SDDL: &str = concat!(
        "D:P",
        "(A;OICI;FA;;;SY)",
        "(A;OICI;FA;;;BA)",
        "(A;OICI;0x1200a9;;;AU)",
        "(A;OICI;0x1200a9;;;AC)",
        "(A;OICI;0x1200a9;;;S-1-15-2-2)"
    );
    let handle = open_mount_point(path, 0x0004_0000)?;
    let value = SDDL
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let mut descriptor = null_mut();
    if unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            value.as_ptr(),
            1,
            &mut descriptor,
            null_mut(),
        )
    } == 0
        || descriptor.is_null()
    {
        LAST_NATIVE_STATUS.store(unsafe { GetLastError() }, Ordering::Relaxed);
        return Err(Error::Native("runtime-image-mount-permissions"));
    }
    let _descriptor = LocalMemory(descriptor);
    let mut present = 0;
    let mut defaulted = 0;
    let mut dacl = null_mut();
    if unsafe {
        GetSecurityDescriptorDacl(descriptor, &mut present, &mut dacl, &mut defaulted)
    } == 0
        || present == 0
        || dacl.is_null()
    {
        LAST_NATIVE_STATUS.store(unsafe { GetLastError() }, Ordering::Relaxed);
        return Err(Error::Native("runtime-image-mount-permissions"));
    }
    let status = unsafe {
        SetSecurityInfo(
            handle.0,
            1,
            0x8000_0004,
            null(),
            null(),
            dacl,
            null(),
        )
    };
    LAST_NATIVE_STATUS.store(status, Ordering::Relaxed);
    if status != 0 {
        return Err(Error::Native("runtime-image-mount-permissions"));
    }
    Ok(())
}

pub(crate) fn diagnostic_status() -> u32 {
    LAST_NATIVE_STATUS.load(Ordering::Relaxed)
}

fn enable_volume_privilege() -> Result<(), Error> {
    const TOKEN_ADJUST_PRIVILEGES: u32 = 0x20;
    const TOKEN_QUERY: u32 = 0x8;
    const SE_PRIVILEGE_ENABLED: u32 = 0x2;
    let mut token = null_mut();
    if unsafe {
        OpenProcessToken(
            GetCurrentProcess(),
            TOKEN_ADJUST_PRIVILEGES | TOKEN_QUERY,
            &mut token,
        )
    } == 0
        || token.is_null()
    {
        let status = unsafe { GetLastError() };
        LAST_NATIVE_STATUS.store(status, Ordering::Relaxed);
        return Err(Error::Native("runtime-image-privilege"));
    }
    let token = VirtualDisk(token);
    let mut name = "SeManageVolumePrivilege".encode_utf16().collect::<Vec<_>>();
    name.push(0);
    let mut luid = Luid::default();
    if unsafe { LookupPrivilegeValueW(null(), name.as_ptr(), &mut luid) } == 0 {
        let status = unsafe { GetLastError() };
        LAST_NATIVE_STATUS.store(status, Ordering::Relaxed);
        return Err(Error::Native("runtime-image-privilege"));
    }
    let privileges = TokenPrivileges {
        count: 1,
        privilege: LuidAndAttributes {
            luid,
            attributes: SE_PRIVILEGE_ENABLED,
        },
    };
    unsafe { SetLastError(0) };
    let adjusted = unsafe {
        AdjustTokenPrivileges(
            token.0,
            0,
            &privileges,
            0,
            null_mut(),
            null_mut(),
        )
    };
    let status = unsafe { GetLastError() };
    LAST_NATIVE_STATUS.store(status, Ordering::Relaxed);
    if adjusted == 0 || status != 0 {
        return Err(Error::Native("runtime-image-privilege"));
    }
    Ok(())
}

fn open_virtual_disk(image: &Path, access: u32) -> Result<VirtualDisk, Error> {
    const VIRTUAL_STORAGE_TYPE_DEVICE_VHDX: u32 = 3;
    const MICROSOFT_VENDOR: Guid = Guid {
        data1: 0xec98_4aec,
        data2: 0xa0f9,
        data3: 0x47e9,
        data4: [0x90, 0x1f, 0x71, 0x41, 0x5a, 0x66, 0x34, 0x5b],
    };
    let storage = VirtualStorageType {
        device_id: VIRTUAL_STORAGE_TYPE_DEVICE_VHDX,
        vendor_id: MICROSOFT_VENDOR,
    };
    let parameters = OpenVirtualDiskParameters {
        version: 1,
        rw_depth: 1,
    };
    let mut handle = null_mut();
    let mut path = image.as_os_str().encode_wide().collect::<Vec<_>>();
    path.push(0);
    let status = unsafe {
        OpenVirtualDisk(&storage, path.as_ptr(), access, 0, &parameters, &mut handle)
    };
    LAST_NATIVE_STATUS.store(status, Ordering::Relaxed);
    if status != 0 || handle.is_null() {
        return Err(Error::Native("runtime-image-open"));
    }
    Ok(VirtualDisk(handle))
}

fn attach_virtual_disk(image: &Path) -> Result<(), Error> {
    const ATTACH_RO: u32 = 0x0001_0000;
    const PARAMETERS: AttachVirtualDiskParameters = AttachVirtualDiskParameters {
        version: 1,
        reserved: 0,
    };
    enable_volume_privilege()?;
    let attributes = std::fs::metadata(image)
        .map_err(|_| Error::Native("runtime-image-open"))?
        .file_attributes();
    if attributes & (0x0800 | 0x4000) != 0 {
        return Err(Error::Native("runtime-image-host-compression"));
    }
    let disk = open_virtual_disk(image, ATTACH_RO)?;
    // Read-only, no automatic drive letter, and persistent beyond this helper
    // handle. The explicit transaction detach remains the sole owner cleanup.
    let status = unsafe { AttachVirtualDisk(disk.0, null(), 0x1 | 0x2 | 0x4, 0, &PARAMETERS, null_mut()) };
    LAST_NATIVE_STATUS.store(status, Ordering::Relaxed);
    if status != 0 {
        return Err(Error::Native("runtime-image-attach"));
    }
    Ok(())
}

fn detach_virtual_disk(image: &Path) -> Result<(), Error> {
    const DETACH: u32 = 0x0004_0000;
    enable_volume_privilege()?;
    let disk = open_virtual_disk(image, DETACH)
        .map_err(|_| Error::Native("runtime-image-detach"))?;
    let status = unsafe { DetachVirtualDisk(disk.0, 0, 0) };
    LAST_NATIVE_STATUS.store(status, Ordering::Relaxed);
    if !matches!(status, 0 | 2 | 1168) {
        return Err(Error::Native("runtime-image-detach"));
    }
    Ok(())
}
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
    fn image_paths(runtime_id: &str) -> Result<(PathBuf, PathBuf), Error> {
        let installation = PathBuf::from(native::installed_path().map_err(native_error)?);
        Ok((
            installation.join("images").join(format!("{runtime_id}.vhdx")),
            installation.join("runtimes").join(runtime_id),
        ))
    }
    fn diskpart(runtime_id: &str, commands: &[String]) -> Result<(), Error> {
        let installation = PathBuf::from(native::installed_path().map_err(native_error)?);
        let script = installation.join(format!("runtime-image-{runtime_id}.txt"));
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&script)
            .map_err(|_| Error::Native("runtime-image-script"))?;
        for command in commands {
            writeln!(file, "{command}").map_err(|_| Error::Native("runtime-image-script"))?;
        }
        file.sync_all()
            .map_err(|_| Error::Native("runtime-image-script"))?;
        drop(file);
        let system_root = std::env::var_os("SystemRoot")
            .map(PathBuf::from)
            .filter(|value| value.is_absolute())
            .ok_or(Error::Native("runtime-image-system-root"))?;
        let status = Command::new(system_root.join("System32").join("diskpart.exe"))
            .args(["/s", script.to_str().ok_or(Error::Identity)?])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map_err(|_| Error::Native("runtime-image-diskpart"));
        let removed = std::fs::remove_file(&script);
        if removed.is_err() {
            return Err(Error::Native("runtime-image-script-cleanup"));
        }
        if !status.map_err(|_| Error::Native("runtime-image-diskpart"))?.success() {
            return Err(Error::Native("runtime-image-diskpart"));
        }
        Ok(())
    }
    fn attach_image(runtime_id: &str) -> Result<(), Error> {
        let (image, mount) = Self::image_paths(runtime_id)?;
        if !image.is_file() || mount.join("runtime.manifest").is_file() {
            return Ok(());
        }
        std::fs::create_dir_all(&mount).map_err(|_| Error::Native("runtime-image-mount"))?;
        authorize_mount_point(&mount)?;
        attach_virtual_disk(&image)?;
        let image_text = image.to_str().ok_or(Error::Identity)?;
        // DiskPart's folder-mount grammar takes the empty directory path itself;
        // a trailing separator makes the quoted `assign mount=` operand invalid.
        let mount = mount
            .to_str()
            .ok_or(Error::Identity)?
            .trim_end_matches('\\')
            .to_owned();
        Self::diskpart(
            runtime_id,
            &[
                format!("select vdisk file=\"{image_text}\""),
                "select partition 1".into(),
                format!("assign mount=\"{mount}\""),
                "exit".into(),
            ],
        )
        .inspect_err(|_| {
            let status = LAST_NATIVE_STATUS.load(Ordering::Relaxed);
            let _ = detach_virtual_disk(&image);
            LAST_NATIVE_STATUS.store(status, Ordering::Relaxed);
        })?;
        if !Path::new(&mount).join("runtime.manifest").is_file() {
            return Err(Error::Native("runtime-image-mount"));
        }
        Ok(())
    }
    fn detach_image(runtime_id: &str) -> Result<(), Error> {
        let (image, mount) = Self::image_paths(runtime_id)?;
        if !image.is_file() {
            return Ok(());
        }
        detach_virtual_disk(&image)?;
        if mount.join("runtime.manifest").exists() {
            return Err(Error::Native("runtime-image-detach"));
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
            .map_err(native_error)?;
        Self::detach_image(&expected.runtime_id)
    }
    fn verify_complete_content(&mut self, expected: &RuntimeIdentity) -> Result<(), Error> {
        expected.validate()?;
        let embedded_image = match (EMBEDDED_IMAGE_RUNTIME_ID, EMBEDDED_IMAGE_SHA256) {
            (Some(id), Some(digest)) if id == expected.runtime_id => {
                if digest.len() != 64
                    || !digest
                        .bytes()
                        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
                {
                    return Err(Error::Identity);
                }
                let mut image = self
                    .directory()?
                    .open_content_file(&format!("images/{}.vhdx", expected.runtime_id))
                    .map_err(native_error)?;
                if hash_file(&mut image)? != digest {
                    return Err(Error::Native("runtime-image-mismatch"));
                }
                true
            }
            (Some(_), Some(_)) => false,
            (None, None) => false,
            _ => return Err(Error::Identity),
        };
        Self::attach_image(&expected.runtime_id)?;
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
        // A package-specific helper pins and hashes the whole VHDX before its
        // read-only attach. Rewalking and hashing tens of thousands of inner
        // files adds no integrity evidence and turns installation into runtime
        // preparation. Loose and previous-version rollback payloads retain the
        // complete manifest walk below.
        if embedded_image {
            return Ok(());
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
        if let Operation::Install(target) = &journal.operation {
            if Some(target) != expected {
                Self::detach_image(&target.runtime_id)?;
            }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[repr(C)]
    struct Acl {
        revision: u8,
        reserved: u8,
        size: u16,
        count: u16,
        reserved2: u16,
    }
    #[repr(C)]
    struct AceHeader {
        kind: u8,
        flags: u8,
        size: u16,
    }
    #[link(name = "advapi32")]
    unsafe extern "system" {
        fn ConvertSidToStringSidW(sid: *const c_void, value: *mut *mut u16) -> i32;
        fn GetAce(acl: *const Acl, index: u32, ace: *mut *mut c_void) -> i32;
        fn GetSecurityDescriptorControl(
            descriptor: *const c_void,
            control: *mut u16,
            revision: *mut u32,
        ) -> i32;
        fn GetSecurityInfo(
            handle: RawHandle,
            kind: u32,
            information: u32,
            owner: *mut *mut c_void,
            group: *mut *mut c_void,
            dacl: *mut *mut Acl,
            sacl: *mut *mut Acl,
            descriptor: *mut *mut c_void,
        ) -> u32;
    }

    fn sid_string(sid: *const c_void) -> String {
        let mut value = null_mut();
        assert!(!sid.is_null());
        assert_ne!(unsafe { ConvertSidToStringSidW(sid, &mut value) }, 0);
        let _memory = LocalMemory(value.cast());
        let mut length = 0;
        while length < 184 && unsafe { *value.add(length) } != 0 {
            length += 1;
        }
        assert!(length < 184);
        String::from_utf16(unsafe { std::slice::from_raw_parts(value, length) }).unwrap()
    }

    #[test]
    fn image_mount_point_grants_only_protected_read_to_appcontainers() {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "nemoclaw-runtime-image-mount-{}-{nonce:x}",
            std::process::id()
        ));
        std::fs::create_dir(&path).unwrap();
        authorize_mount_point(&path).unwrap_or_else(|error| {
            panic!(
                "mount authorization failed: {error:?}; Windows {}",
                diagnostic_status()
            )
        });
        {
            let handle = open_mount_point(&path, 0x0002_0000).unwrap();
            let mut dacl = null_mut();
            let mut descriptor = null_mut();
            assert_eq!(
                unsafe {
                    GetSecurityInfo(
                        handle.0,
                        1,
                        4,
                        null_mut(),
                        null_mut(),
                        &mut dacl,
                        null_mut(),
                        &mut descriptor,
                    )
                },
                0
            );
            let _descriptor = LocalMemory(descriptor);
            assert!(!dacl.is_null());
            let mut control = 0;
            let mut revision = 0;
            assert_ne!(
                unsafe { GetSecurityDescriptorControl(descriptor, &mut control, &mut revision) },
                0
            );
            assert_ne!(control & 0x1000, 0);
            let mut grants = BTreeMap::new();
            for index in 0..u32::from(unsafe { (*dacl).count }) {
                let mut ace = null_mut();
                assert_ne!(unsafe { GetAce(dacl, index, &mut ace) }, 0);
                let header = unsafe { &*ace.cast::<AceHeader>() };
                assert_eq!(header.kind, 0);
                assert_eq!(header.flags & 0x0b, 0x03);
                assert!(header.size >= 16);
                let bytes = ace.cast::<u8>();
                let mask = unsafe { bytes.add(4).cast::<u32>().read_unaligned() };
                let sid = sid_string(unsafe { bytes.add(8).cast() });
                assert!(grants.insert(sid, mask).is_none());
            }
            assert_eq!(
                grants,
                BTreeMap::from([
                    ("S-1-5-18".into(), 0x001f_01ff),
                    ("S-1-5-32-544".into(), 0x001f_01ff),
                    ("S-1-5-11".into(), 0x0012_00a9),
                    ("S-1-15-2-1".into(), 0x0012_00a9),
                    ("S-1-15-2-2".into(), 0x0012_00a9),
                ])
            );
        }
        std::fs::remove_dir(&path).unwrap();
    }
}
