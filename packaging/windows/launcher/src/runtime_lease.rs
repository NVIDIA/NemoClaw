// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Dormant immutable-runtime admission protocol. Installation seals content once;
//! launch reads only protected descriptors and holds an OS lease, never hashing
//! or copying runtime trees. Product caller activation is a separate change.

const MAX_DESCRIPTOR: usize = 512;
const HEADER: &str = "NEMOCLAW_RUNTIME_V1";

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Descriptor {
    pub(crate) runtime_id: String,
    pub(crate) manifest_sha256: String,
    pub(crate) source_revision: String,
    pub(crate) node_sha256: String,
    pub(crate) node_version: String,
}

fn lower_hex(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

impl Descriptor {
    pub(crate) fn parse(bytes: &[u8]) -> Result<Self, &'static str> {
        if bytes.len() > MAX_DESCRIPTOR || !bytes.ends_with(b"\n") {
            return Err("runtime-descriptor");
        }
        let text = std::str::from_utf8(bytes).map_err(|_| "runtime-descriptor")?;
        let parts = text.split('\n').collect::<Vec<_>>();
        if parts.len() != 7
            || parts[0] != HEADER
            || !parts[6].is_empty()
            || !lower_hex(parts[1], 64)
            || !lower_hex(parts[2], 64)
            || !lower_hex(parts[3], 40)
            || !lower_hex(parts[4], 64)
            || !node_version(parts[5])
        {
            return Err("runtime-descriptor");
        }
        Ok(Self {
            runtime_id: parts[1].into(),
            manifest_sha256: parts[2].into(),
            source_revision: parts[3].into(),
            node_sha256: parts[4].into(),
            node_version: parts[5].into(),
        })
    }

    pub(crate) fn bytes(&self) -> Vec<u8> {
        format!(
            "{HEADER}\n{}\n{}\n{}\n{}\n{}\n",
            self.runtime_id,
            self.manifest_sha256,
            self.source_revision,
            self.node_sha256,
            self.node_version
        )
        .into_bytes()
    }

    fn matches(&self, id: &str, digest: &str) -> bool {
        lower_hex(id, 64)
            && lower_hex(digest, 64)
            && self.runtime_id == id
            && self.manifest_sha256 == digest
    }
}

fn node_version(value: &str) -> bool {
    let parts = value.split('.').collect::<Vec<_>>();
    parts.len() == 3
        && parts.iter().all(|part| {
            !part.is_empty()
                && part.len() <= 5
                && (part.len() == 1 || !part.starts_with('0'))
                && part.bytes().all(|byte| byte.is_ascii_digit())
        })
}

fn valid_agent(agent: &str) -> bool {
    matches!(
        agent,
        "openclaw"
            | "hermes"
            | "pi"
            | "langchain-deepagents-code"
            | "nemocua"
            | "inference"
            | "host"
    )
}

fn installer_principal(sid: &str) -> bool {
    matches!(
        sid,
        "S-1-5-18"
            | "S-1-5-32-544"
            | "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464"
    )
}

fn grants_untrusted_write(sid: &str, mask: u32, inherit_only: bool) -> bool {
    // write/append data, write EA/attributes, delete-child/delete, DACL/owner,
    // GENERIC_WRITE and GENERIC_ALL. Only the standard inherit-only CREATOR
    // OWNER template is exempt; a public write grant for children is unsafe.
    const MUTATION: u32 = 0x500d_0156;
    (mask & MUTATION != 0) && !installer_principal(sid) && !(inherit_only && sid == "S-1-3-0")
}

fn json_string(value: &str) -> String {
    let mut output = String::from("\"");
    for ch in value.chars() {
        match ch {
            '\\' => output.push_str("\\\\"),
            '"' => output.push_str("\\\""),
            ch if ch < ' ' => output.push_str(&format!("\\u{:04x}", ch as u32)),
            ch => output.push(ch),
        }
    }
    output.push('"');
    output
}

fn readiness(agent: &str, root: &str, descriptor: &Descriptor) -> Result<String, &'static str> {
    if !valid_agent(agent) {
        return Err("runtime-agent");
    }
    Ok(format!(
        "{{\"schemaVersion\":1,\"kind\":\"native-runtime-session\",\"agent\":{},\"runtimeRoot\":{},\"runtimeId\":\"{}\",\"manifestSha256\":\"{}\",\"sourceRevision\":\"{}\",\"nodeSha256\":\"{}\",\"nodeVersion\":\"{}\",\"integrity\":\"installer-sealed-content\",\"leaseHeld\":true}}\n",
        json_string(agent),
        json_string(root),
        descriptor.runtime_id,
        descriptor.manifest_sha256,
        descriptor.source_revision,
        descriptor.node_sha256,
        descriptor.node_version
    ))
}

#[cfg(windows)]
pub(crate) mod native {
    use super::*;
    use std::ffi::c_void;
    use std::io::{Read, Write};
    use std::ptr::{null, null_mut};
    type RawHandle = *mut c_void;
    const DIR_ACCESS: u32 = 0x0012_00a1;
    const READ_ACCESS: u32 = 0x0012_0081;
    const DELETE_ACCESS: u32 = READ_ACCESS | 0x0001_0000;
    const DIRECTORY: u32 = 0x10;
    const REPARSE: u32 = 0x400;

    #[repr(C)]
    struct Guid {
        a: u32,
        b: u16,
        c: u16,
        d: [u8; 8],
    }
    #[repr(C)]
    struct UnicodeString {
        length: u16,
        maximum: u16,
        buffer: *mut u16,
    }
    #[repr(C)]
    struct ObjectAttributes {
        length: u32,
        root: RawHandle,
        name: *mut UnicodeString,
        flags: u32,
        security: *mut c_void,
        quality: *mut c_void,
    }
    #[repr(C)]
    #[derive(Default)]
    struct IoStatus {
        status: usize,
        information: usize,
    }
    #[repr(C)]
    struct AttributeTag {
        attributes: u32,
        tag: u32,
    }
    #[repr(C)]
    struct StandardInfo {
        allocation: i64,
        size: i64,
        links: u32,
        deleting: u8,
        directory: u8,
    }
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
    #[repr(C)]
    struct RenameInfo {
        replace: u32,
        root: RawHandle,
        length: u32,
        name: [u16; 1],
    }

    #[link(name = "shell32")]
    unsafe extern "system" {
        fn SHGetKnownFolderPath(
            folder: *const Guid,
            flags: u32,
            token: RawHandle,
            path: *mut *mut u16,
        ) -> i32;
    }
    #[link(name = "ole32")]
    unsafe extern "system" {
        fn CoTaskMemFree(memory: *mut c_void);
    }
    #[link(name = "ntdll")]
    unsafe extern "system" {
        fn NtCreateFile(
            handle: *mut RawHandle,
            access: u32,
            attributes: *mut ObjectAttributes,
            status: *mut IoStatus,
            allocation: *const i64,
            file_attributes: u32,
            share: u32,
            disposition: u32,
            options: u32,
            ea: *const c_void,
            ea_length: u32,
        ) -> i32;
        fn RtlNtStatusToDosError(status: i32) -> u32;
        fn NtSetInformationFile(
            handle: RawHandle,
            status: *mut IoStatus,
            information: *const c_void,
            length: u32,
            class: u32,
        ) -> i32;
    }
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn CloseHandle(handle: RawHandle) -> i32;
        fn LocalFree(memory: *mut c_void) -> *mut c_void;
        fn GetLastError() -> u32;
        fn GetFileInformationByHandleEx(
            handle: RawHandle,
            class: u32,
            value: *mut c_void,
            size: u32,
        ) -> i32;
        fn ReadFile(
            handle: RawHandle,
            buffer: *mut c_void,
            size: u32,
            read: *mut u32,
            overlapped: *mut c_void,
        ) -> i32;
        fn WriteFile(
            handle: RawHandle,
            buffer: *const c_void,
            size: u32,
            written: *mut u32,
            overlapped: *mut c_void,
        ) -> i32;
        fn FlushFileBuffers(handle: RawHandle) -> i32;
        fn SetFileInformationByHandle(
            handle: RawHandle,
            class: u32,
            buffer: *const c_void,
            size: u32,
        ) -> i32;
    }
    #[link(name = "advapi32")]
    unsafe extern "system" {
        fn ConvertSidToStringSidW(sid: *const c_void, value: *mut *mut u16) -> i32;
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
        fn GetAce(acl: *const Acl, index: u32, ace: *mut *mut c_void) -> i32;
    }

    #[cfg(target_pointer_width = "64")]
    const _: () = {
        assert!(std::mem::size_of::<ObjectAttributes>() == 48);
        assert!(std::mem::size_of::<StandardInfo>() == 24);
        assert!(std::mem::offset_of!(RenameInfo, name) == 20);
    };

    struct Handle(RawHandle);
    impl Drop for Handle {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
    struct LocalMemory(*mut c_void);
    impl Drop for LocalMemory {
        fn drop(&mut self) {
            unsafe {
                LocalFree(self.0);
            }
        }
    }

    fn error(status: i32) -> &'static str {
        match unsafe { RtlNtStatusToDosError(status) } {
            2 | 3 => "runtime-unavailable",
            32 | 33 => "runtime-busy",
            80 | 183 => "runtime-marker-exists",
            5 => "runtime-access",
            _ => "runtime-file",
        }
    }

    fn open(
        parent: Option<&Handle>,
        name: &str,
        directory: bool,
        access: u32,
        share: u32,
    ) -> Result<Handle, &'static str> {
        open_mode(parent, name, directory, access, share, 1)
    }
    fn open_mode(
        parent: Option<&Handle>,
        name: &str,
        directory: bool,
        access: u32,
        share: u32,
        disposition: u32,
    ) -> Result<Handle, &'static str> {
        let mut wide = name.encode_utf16().collect::<Vec<_>>();
        if wide.is_empty() || wide.len() > 16000 {
            return Err("runtime-path");
        }
        let mut unicode = UnicodeString {
            length: (wide.len() * 2) as u16,
            maximum: (wide.len() * 2) as u16,
            buffer: wide.as_mut_ptr(),
        };
        let mut attributes = ObjectAttributes {
            length: std::mem::size_of::<ObjectAttributes>() as u32,
            root: parent.map_or(null_mut(), |v| v.0),
            name: &mut unicode,
            flags: 0x40 | if parent.is_some() { 0x1000 } else { 0 },
            security: null_mut(),
            quality: null_mut(),
        };
        let mut handle = null_mut();
        let mut status = IoStatus::default();
        let result = unsafe {
            NtCreateFile(
                &mut handle,
                access,
                &mut attributes,
                &mut status,
                null(),
                0,
                share,
                disposition,
                0x0020_0020 | if directory { 1 } else { 0x40 },
                null(),
                0,
            )
        };
        if result < 0 {
            return Err(error(result));
        }
        if handle.is_null() {
            return Err("runtime-file");
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
            || tag.attributes & REPARSE != 0
            || (tag.attributes & DIRECTORY != 0) != directory
        {
            return Err("runtime-reparse");
        }
        Ok(handle)
    }

    fn sid_string(sid: *const c_void) -> Result<String, &'static str> {
        let mut text = null_mut();
        if sid.is_null() || unsafe { ConvertSidToStringSidW(sid, &mut text) } == 0 {
            return Err("runtime-owner");
        }
        let _memory = LocalMemory(text.cast());
        let mut length = 0;
        while length < 184 && unsafe { *text.add(length) } != 0 {
            length += 1;
        }
        if length == 184 {
            return Err("runtime-owner");
        }
        String::from_utf16(unsafe { std::slice::from_raw_parts(text, length) })
            .map_err(|_| "runtime-owner")
    }

    fn verify_security(handle: &Handle) -> Result<(), &'static str> {
        let mut owner = null_mut();
        let mut dacl = null_mut();
        let mut descriptor = null_mut();
        if unsafe {
            GetSecurityInfo(
                handle.0,
                1,
                5,
                &mut owner,
                null_mut(),
                &mut dacl,
                null_mut(),
                &mut descriptor,
            )
        } != 0
        {
            return Err("runtime-permissions");
        }
        let _memory = LocalMemory(descriptor);
        if !installer_principal(&sid_string(owner)?) || dacl.is_null() {
            return Err("runtime-owner");
        }
        if unsafe { (*dacl).count } > 128 {
            return Err("runtime-permissions");
        }
        for index in 0..u32::from(unsafe { (*dacl).count }) {
            let mut ace = null_mut();
            if unsafe { GetAce(dacl, index, &mut ace) } == 0 {
                return Err("runtime-permissions");
            }
            let header = unsafe { &*ace.cast::<AceHeader>() };
            if header.size < 16 || header.kind > 1 {
                return Err("runtime-permissions");
            }
            if header.kind == 1 {
                continue;
            }
            let bytes = ace.cast::<u8>();
            let mask = unsafe { bytes.add(4).cast::<u32>().read_unaligned() };
            let principal = sid_string(unsafe { bytes.add(8).cast() })?;
            if grants_untrusted_write(&principal, mask, header.flags & 8 != 0) {
                return Err("runtime-writable");
            }
        }
        Ok(())
    }

    fn descriptor(handle: &Handle) -> Result<Descriptor, &'static str> {
        verify_security(handle)?;
        let mut info = StandardInfo {
            allocation: 0,
            size: 0,
            links: 0,
            deleting: 0,
            directory: 0,
        };
        if unsafe {
            GetFileInformationByHandleEx(
                handle.0,
                1,
                (&mut info as *mut StandardInfo).cast(),
                std::mem::size_of::<StandardInfo>() as u32,
            )
        } == 0
            || info.links != 1
            || info.deleting != 0
            || info.directory != 0
            || info.size < 0
            || info.size > MAX_DESCRIPTOR as i64
        {
            return Err("runtime-descriptor");
        }
        let mut bytes = [0u8; MAX_DESCRIPTOR + 1];
        let mut count = 0;
        while count < bytes.len() {
            let mut read = 0;
            if unsafe {
                ReadFile(
                    handle.0,
                    bytes[count..].as_mut_ptr().cast(),
                    (bytes.len() - count) as u32,
                    &mut read,
                    null_mut(),
                )
            } == 0
            {
                return Err("runtime-descriptor");
            }
            if read == 0 {
                break;
            }
            count += read as usize;
        }
        Descriptor::parse(&bytes[..count])
    }

    pub(crate) fn installed_path() -> Result<String, &'static str> {
        let folder = Guid {
            a: 0x905e63b6,
            b: 0xc1bf,
            c: 0x494e,
            d: [0xb2, 0x9c, 0x65, 0xb7, 0x32, 0xd3, 0xd2, 0x1a],
        };
        let mut text = null_mut();
        if unsafe { SHGetKnownFolderPath(&folder, 0, null_mut(), &mut text) } < 0 || text.is_null()
        {
            return Err("runtime-installation");
        }
        let result = (|| {
            let mut length = 0;
            while length < 16000 && unsafe { *text.add(length) } != 0 {
                length += 1;
            }
            if length == 16000 {
                return Err("runtime-installation");
            }
            let value = String::from_utf16(unsafe { std::slice::from_raw_parts(text, length) })
                .map_err(|_| "runtime-installation")?;
            Ok(format!("{value}\\NVIDIA\\NemoClaw"))
        })();
        unsafe { CoTaskMemFree(text.cast()) };
        result
    }

    fn open_installation(path: &str) -> Result<Vec<Handle>, &'static str> {
        let bytes = path.as_bytes();
        if bytes.len() < 4
            || !bytes[0].is_ascii_alphabetic()
            || &bytes[1..3] != b":\\"
            || path.contains('/')
            || path.chars().any(|v| v < ' ')
        {
            return Err("runtime-installation");
        }
        let mut handles = vec![open(
            None,
            &format!("\\??\\{}", &path[..3]),
            true,
            DIR_ACCESS,
            7,
        )?];
        for component in path[3..].split('\\') {
            if component.is_empty() || matches!(component, "." | "..") || component.contains(':') {
                return Err("runtime-installation");
            }
            let handle = open(handles.last(), component, true, DIR_ACCESS, 3)?;
            verify_security(&handle)?;
            handles.push(handle);
        }
        Ok(handles)
    }

    struct Runtime {
        path: String,
        handles: Vec<Handle>,
    }
    impl Runtime {
        fn open(installation: &str, id: &str) -> Result<Self, &'static str> {
            if !lower_hex(id, 64) {
                return Err("runtime-identity");
            }
            let mut handles = open_installation(installation)?;
            for component in ["runtimes", id] {
                let handle = open(handles.last(), component, true, DIR_ACCESS, 3)?;
                verify_security(&handle)?;
                handles.push(handle);
            }
            Ok(Self {
                path: format!("{installation}\\runtimes\\{id}"),
                handles,
            })
        }
        fn marker(&self, name: &str, access: u32, share: u32) -> Result<Handle, &'static str> {
            open(self.handles.last(), name, false, access, share)
        }
    }

    fn rename(handle: &Handle, name: &str) -> Result<(), &'static str> {
        rename_mode(handle, name, false)
    }
    fn rename_mode(handle: &Handle, name: &str, replace: bool) -> Result<(), &'static str> {
        let wide = name.encode_utf16().collect::<Vec<_>>();
        let offset = std::mem::offset_of!(RenameInfo, name);
        let size = offset + wide.len() * 2;
        let mut memory = vec![0usize; size.div_ceil(std::mem::size_of::<usize>())];
        let raw = memory.as_mut_ptr().cast::<RenameInfo>();
        unsafe {
            (*raw).replace = u32::from(replace);
            (*raw).root = null_mut();
            (*raw).length = (wide.len() * 2) as u32;
            std::ptr::copy_nonoverlapping(
                wide.as_ptr(),
                memory.as_mut_ptr().cast::<u8>().add(offset).cast::<u16>(),
                wide.len(),
            );
        }
        let mut status = IoStatus::default();
        let result =
            unsafe { NtSetInformationFile(handle.0, &mut status, raw.cast(), size as u32, 10) };
        if result < 0 {
            Err(error(result))
        } else {
            Ok(())
        }
    }

    pub(crate) struct PackageLease {
        _control: ControlDirectory,
        package: Handle,
        runtime: Runtime,
        version: Handle,
        _bin: Handle,
        node: Handle,
        selected: Descriptor,
    }
    impl PackageLease {
        pub(crate) fn runtime_path(&self) -> &str {
            &self.runtime.path
        }
        pub(crate) fn inherited_handle(&self) -> *mut c_void {
            self.package.0
        }
        pub(crate) fn acquire(agent: &str) -> Result<Self, &'static str> {
            Self::acquire_at(&installed_path()?, agent)
        }
        fn acquire_at(installation: &str, agent: &str) -> Result<Self, &'static str> {
            if !valid_agent(agent) {
                return Err("runtime-agent");
            }
            let control = ControlDirectory::at(installation)?;
            if control.read(ControlFile::Maintenance)?.is_some() {
                return Err("runtime-maintenance");
            }
            let package_lease = open(
                control.handles.last(),
                "runtime-current",
                false,
                READ_ACCESS,
                1,
            )?;
            let selected = descriptor(&package_lease)?;
            let runtime = Runtime::open(installation, &selected.runtime_id)?;
            let lease = runtime.marker("runtime.ready", READ_ACCESS, 1)?;
            if descriptor(&lease)? != selected {
                return Err("runtime-identity");
            }
            let bin = open(control.handles.last(), "bin", true, DIR_ACCESS, 3)?;
            verify_security(&bin)?;
            let node = open(Some(&bin), "node.exe", false, READ_ACCESS, 1)?;
            verify_security(&node)?;
            if control.read(ControlFile::Maintenance)?.is_some() {
                return Err("runtime-maintenance");
            }
            Ok(Self {
                _control: control,
                package: package_lease,
                runtime,
                version: lease,
                _bin: bin,
                node,
                selected,
            })
        }
        pub(crate) fn validate(&self) -> Result<(), &'static str> {
            verify_security(&self.package)?;
            verify_security(&self.version)?;
            verify_security(&self.node)?;
            for parent in &self.runtime.handles[1..] {
                verify_security(parent)?;
            }
            verify_security(&self._bin)?;
            Ok(())
        }
    }
    pub fn run(agent: &str) -> Result<(), &'static str> {
        let lease = PackageLease::acquire(agent)?;
        std::io::stdout()
            .write_all(readiness(agent, &lease.runtime.path, &lease.selected)?.as_bytes())
            .and_then(|_| std::io::stdout().flush())
            .map_err(|_| "runtime-channel")?;
        let mut release = Vec::new();
        std::io::stdin()
            .take(9)
            .read_to_end(&mut release)
            .map_err(|_| "runtime-channel")?;
        if release != b"release\n" {
            return Err("runtime-interrupted");
        }
        lease.validate()
    }

    fn transition_at(
        installation: &str,
        id: &str,
        digest: &str,
        restore: bool,
    ) -> Result<(), &'static str> {
        if !lower_hex(id, 64) || !lower_hex(digest, 64) {
            return Err("runtime-identity");
        }
        let control = ControlDirectory::at(installation)?;
        if restore {
            let retired = match open(
                control.handles.last(),
                "runtime-retired",
                false,
                DELETE_ACCESS,
                3,
            ) {
                Ok(handle) => handle,
                Err("runtime-unavailable") => {
                    let ready = open(
                        control.handles.last(),
                        "runtime-current",
                        false,
                        READ_ACCESS,
                        7,
                    )?;
                    return if descriptor(&ready)?.matches(id, digest) {
                        Ok(())
                    } else {
                        Err("runtime-identity")
                    };
                }
                Err(error) => return Err(error),
            };
            if !descriptor(&retired)?.matches(id, digest) {
                return Err("runtime-identity");
            }
            rename(&retired, "runtime-current")
        } else {
            let marker = open(
                control.handles.last(),
                "runtime-current",
                false,
                DELETE_ACCESS,
                3,
            )?;
            if !descriptor(&marker)?.matches(id, digest) {
                return Err("runtime-identity");
            }
            rename(&marker, "runtime-retired")
        }
    }
    pub fn transition(id: &str, digest: &str, restore: bool) -> Result<(), &'static str> {
        transition_at(&installed_path()?, id, digest, restore)
    }

    #[derive(Clone, Copy)]
    pub(crate) enum ControlFile {
        Current,
        Retired,
        Maintenance,
    }
    impl ControlFile {
        fn name(self) -> &'static str {
            match self {
                Self::Current => "runtime-current",
                Self::Retired => "runtime-retired",
                Self::Maintenance => "runtime-maintenance",
            }
        }
    }
    #[derive(Clone, Copy, Default)]
    pub(crate) struct CreatedDirectories {
        pub(crate) vendor: bool,
        pub(crate) application: bool,
    }
    pub(crate) struct ContentDirectory<'a> {
        _root: &'a ControlDirectory,
        _parents: Vec<Handle>,
    }
    pub(crate) struct ContentFile<'a> {
        _root: &'a ControlDirectory,
        _parents: Vec<Handle>,
        file: Handle,
        size: u64,
    }
    impl ContentFile<'_> {
        pub(crate) fn size(&self) -> u64 {
            self.size
        }
        pub(crate) fn read_chunk(&mut self, bytes: &mut [u8]) -> Result<usize, &'static str> {
            if bytes.len() > 1024 * 1024 {
                return Err("runtime-read-bound");
            }
            let mut read = 0;
            if unsafe {
                ReadFile(
                    self.file.0,
                    bytes.as_mut_ptr().cast(),
                    bytes.len() as u32,
                    &mut read,
                    null_mut(),
                )
            } == 0
            {
                return Err("runtime-content-read");
            }
            Ok(read as usize)
        }
    }
    fn content_components(relative: &str) -> Result<Vec<&str>, &'static str> {
        if relative.is_empty() || relative.len() > 16000 || relative.contains('\\') {
            return Err("runtime-content-path");
        }
        let parts = relative.split('/').collect::<Vec<_>>();
        if parts.len() > 128 {
            return Err("runtime-content-path");
        }
        for part in &parts {
            let stem = part.split('.').next().unwrap_or("").to_ascii_uppercase();
            if part.is_empty()
                || matches!(*part, "." | "..")
                || part.ends_with(['.', ' '])
                || part
                    .chars()
                    .any(|c| c < ' ' || matches!(c, ':' | '"' | '<' | '>' | '|' | '?' | '*'))
                || matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
                || ((stem.starts_with("COM") || stem.starts_with("LPT"))
                    && stem.len() == 4
                    && matches!(stem.as_bytes()[3], b'1'..=b'9'))
            {
                return Err("runtime-content-path");
            }
        }
        Ok(parts)
    }
    pub(crate) struct ControlDirectory {
        handles: Vec<Handle>,
    }
    impl ControlDirectory {
        pub(crate) fn open_content_directory<'a>(
            &'a self,
            relative: &str,
        ) -> Result<ContentDirectory<'a>, &'static str> {
            let parts = if relative.is_empty() {
                Vec::new()
            } else {
                content_components(relative)?
            };
            let mut parents = Vec::new();
            for part in parts {
                let handle = open(
                    parents.last().or_else(|| self.handles.last()),
                    part,
                    true,
                    DIR_ACCESS,
                    3,
                )?;
                verify_security(&handle)?;
                parents.push(handle);
            }
            Ok(ContentDirectory {
                _root: self,
                _parents: parents,
            })
        }
        pub(crate) fn open_content_file<'a>(
            &'a self,
            relative: &str,
        ) -> Result<ContentFile<'a>, &'static str> {
            let parts = content_components(relative)?;
            let mut parents = Vec::new();
            for part in &parts[..parts.len() - 1] {
                let parent = parents.last().or_else(|| self.handles.last());
                let handle = open(parent, part, true, DIR_ACCESS, 3)?;
                verify_security(&handle)?;
                parents.push(handle);
            }
            let file = open(
                parents.last().or_else(|| self.handles.last()),
                parts.last().unwrap(),
                false,
                READ_ACCESS,
                1,
            )?;
            verify_security(&file)?;
            let mut info = StandardInfo {
                allocation: 0,
                size: 0,
                links: 0,
                deleting: 0,
                directory: 0,
            };
            if unsafe {
                GetFileInformationByHandleEx(
                    file.0,
                    1,
                    (&mut info as *mut StandardInfo).cast(),
                    std::mem::size_of::<StandardInfo>() as u32,
                )
            } == 0
                || info.links != 1
                || info.directory != 0
                || info.deleting != 0
                || info.size < 0
            {
                return Err("runtime-content-file");
            }
            Ok(ContentFile {
                _root: self,
                _parents: parents,
                file,
                size: info.size as u64,
            })
        }
        pub(crate) fn open() -> Result<Self, &'static str> {
            Self::at(&installed_path()?)
        }
        fn at(installation: &str) -> Result<Self, &'static str> {
            Ok(Self {
                handles: open_installation(installation)?,
            })
        }
        pub(crate) fn open_or_create() -> Result<(Self, CreatedDirectories), &'static str> {
            let installation = installed_path()?;
            let program_files = installation
                .strip_suffix("\\NVIDIA\\NemoClaw")
                .ok_or("runtime-installation")?;
            let mut handles = open_installation(program_files)?;
            let mut created = CreatedDirectories::default();
            for (name, flag) in [
                ("NVIDIA", &mut created.vendor),
                ("NemoClaw", &mut created.application),
            ] {
                let handle = match open(handles.last(), name, true, DIR_ACCESS, 3) {
                    Ok(v) => v,
                    Err("runtime-unavailable") => {
                        match open_mode(handles.last(), name, true, DIR_ACCESS, 3, 2) {
                            Ok(v) => {
                                *flag = true;
                                v
                            }
                            Err("runtime-marker-exists") => {
                                open(handles.last(), name, true, DIR_ACCESS, 3)?
                            }
                            Err(e) => return Err(e),
                        }
                    }
                    Err(e) => return Err(e),
                };
                verify_security(&handle)?;
                handles.push(handle);
            }
            Ok((Self { handles }, created))
        }
        pub(crate) fn cleanup_created(created: CreatedDirectories) -> Result<(), &'static str> {
            let installation = installed_path()?;
            let program_files = installation
                .strip_suffix("\\NVIDIA\\NemoClaw")
                .ok_or("runtime-installation")?;
            for (selected, name, parent) in [
                (
                    created.application,
                    "NemoClaw",
                    format!("{program_files}\\NVIDIA"),
                ),
                (created.vendor, "NVIDIA", program_files.to_owned()),
            ] {
                if !selected {
                    continue;
                }
                let parents = match open_installation(&parent) {
                    Ok(v) => v,
                    Err("runtime-unavailable") => continue,
                    Err(e) => return Err(e),
                };
                let target = match open(parents.last(), name, true, DIR_ACCESS | 0x10000, 3) {
                    Ok(v) => v,
                    Err("runtime-unavailable") => continue,
                    Err(e) => return Err(e),
                };
                verify_security(&target)?;
                let flags = 0x11u32;
                if unsafe {
                    SetFileInformationByHandle(target.0, 21, (&flags as *const u32).cast(), 4)
                } == 0
                    && unsafe { GetLastError() } != 145
                {
                    return Err("runtime-directory-cleanup");
                }
            }
            Ok(())
        }
        pub(crate) fn read(&self, name: ControlFile) -> Result<Option<Vec<u8>>, &'static str> {
            let file = match open(self.handles.last(), name.name(), false, READ_ACCESS, 7) {
                Ok(v) => v,
                Err("runtime-unavailable") => return Ok(None),
                Err(e) => return Err(e),
            };
            verify_security(&file)?;
            let mut info = StandardInfo {
                allocation: 0,
                size: 0,
                links: 0,
                deleting: 0,
                directory: 0,
            };
            if unsafe {
                GetFileInformationByHandleEx(
                    file.0,
                    1,
                    (&mut info as *mut StandardInfo).cast(),
                    std::mem::size_of::<StandardInfo>() as u32,
                )
            } == 0
                || info.links != 1
                || info.directory != 0
                || info.deleting != 0
                || info.size < 0
                || info.size > 16 * 1024
            {
                return Err("runtime-control-file");
            }
            let mut bytes = vec![0u8; 16 * 1024 + 1];
            let mut count = 0;
            while count < bytes.len() {
                let mut read = 0;
                if unsafe {
                    ReadFile(
                        file.0,
                        bytes[count..].as_mut_ptr().cast(),
                        (bytes.len() - count) as u32,
                        &mut read,
                        null_mut(),
                    )
                } == 0
                {
                    return Err("runtime-control-file");
                }
                if read == 0 {
                    break;
                }
                count += read as usize;
            }
            if count > 16 * 1024 {
                return Err("runtime-control-file");
            }
            bytes.truncate(count);
            Ok(Some(bytes))
        }
        pub(crate) fn write_new(
            &self,
            name: ControlFile,
            bytes: &[u8],
        ) -> Result<(), &'static str> {
            if bytes.len() > 16 * 1024 {
                return Err("runtime-control-file");
            }
            let file = open_mode(self.handles.last(), name.name(), false, 0x0012_0082, 0, 2)?;
            verify_security(&file)?;
            let mut written = 0;
            if unsafe {
                WriteFile(
                    file.0,
                    bytes.as_ptr().cast(),
                    bytes.len() as u32,
                    &mut written,
                    null_mut(),
                )
            } == 0
                || written as usize != bytes.len()
                || unsafe { FlushFileBuffers(file.0) } == 0
            {
                return Err("runtime-control-write");
            }
            Ok(())
        }
        pub(crate) fn replace_exact(
            &self,
            name: ControlFile,
            expected: &[u8],
            next: &[u8],
        ) -> Result<(), &'static str> {
            if expected.len() > 16 * 1024 || next.len() > 16 * 1024 {
                return Err("runtime-control-file");
            }
            // The exclusive fixed temporary is the update interlock. Maintenance
            // remains present throughout replacement; there is no unlink gap.
            let temporary = open_mode(
                self.handles.last(),
                "runtime-control-next",
                false,
                0x0013_0083,
                0,
                2,
            )?;
            let result = (|| {
                verify_security(&temporary)?;
                if self.read(name)?.as_deref() != Some(expected) {
                    return Err("runtime-control-changed");
                }
                let mut written = 0;
                if unsafe {
                    WriteFile(
                        temporary.0,
                        next.as_ptr().cast(),
                        next.len() as u32,
                        &mut written,
                        null_mut(),
                    )
                } == 0
                    || written as usize != next.len()
                    || unsafe { FlushFileBuffers(temporary.0) } == 0
                {
                    return Err("runtime-control-write");
                }
                rename_mode(&temporary, name.name(), true)
            })();
            if result.is_err() {
                let flags = 0x11u32;
                let _ = unsafe {
                    SetFileInformationByHandle(temporary.0, 21, (&flags as *const u32).cast(), 4)
                };
            }
            result
        }
        // Call only after validating the transaction journal during recovery.
        // A live updater holds the temporary with share=0, so this cannot steal
        // an in-progress update; only this fixed, protected staging name is used.
        pub(crate) fn discard_orphan_next(&self) -> Result<(), &'static str> {
            let file = match open(
                self.handles.last(),
                "runtime-control-next",
                false,
                DELETE_ACCESS,
                3,
            ) {
                Ok(v) => v,
                Err("runtime-unavailable") => return Ok(()),
                Err(e) => return Err(e),
            };
            verify_security(&file)?;
            let flags = 0x11u32;
            if unsafe { SetFileInformationByHandle(file.0, 21, (&flags as *const u32).cast(), 4) }
                == 0
            {
                return Err("runtime-control-remove");
            }
            Ok(())
        }
        pub(crate) fn remove(&self, name: ControlFile) -> Result<(), &'static str> {
            match open(
                self.handles.last(),
                "runtime-control-next",
                false,
                READ_ACCESS,
                7,
            ) {
                Ok(_) => return Err("runtime-control-busy"),
                Err("runtime-unavailable") => {}
                Err(e) => return Err(e),
            }
            let file = match open(self.handles.last(), name.name(), false, DELETE_ACCESS, 3) {
                Ok(v) => v,
                Err("runtime-unavailable") => return Ok(()),
                Err(e) => return Err(e),
            };
            verify_security(&file)?;
            let flags = 0x11u32;
            if unsafe { SetFileInformationByHandle(file.0, 21, (&flags as *const u32).cast(), 4) }
                == 0
            {
                return Err("runtime-control-remove");
            }
            Ok(())
        }
    }
    pub(crate) fn current_descriptor() -> Result<Option<Descriptor>, &'static str> {
        let control = match ControlDirectory::open() {
            Ok(v) => v,
            Err("runtime-unavailable") => return Ok(None),
            Err(e) => return Err(e),
        };
        control
            .read(ControlFile::Current)?
            .map(|v| Descriptor::parse(&v))
            .transpose()
    }
    #[cfg(test)]
    mod windows_tests {
        include!("runtime_lease_windows_tests.rs");
    }
}

#[cfg(windows)]
pub fn run(agent: &str) -> Result<(), String> {
    native::run(agent).map_err(str::to_owned)
}
#[cfg(windows)]
pub fn transition(id: &str, digest: &str, restore: bool) -> Result<(), String> {
    native::transition(id, digest, restore).map_err(str::to_owned)
}

#[cfg(windows)]
pub fn describe() -> Result<(), String> {
    use std::io::Write;
    let value = native::current_descriptor().map_err(str::to_owned)?;
    let record = match value {
        None => "{\"schemaVersion\":1,\"kind\":\"native-runtime-current\",\"present\":false}\n"
            .to_owned(),
        Some(value) => format!(
            "{{\"schemaVersion\":1,\"kind\":\"native-runtime-current\",\"present\":true,\"runtimeId\":\"{}\",\"manifestSha256\":\"{}\",\"sourceRevision\":\"{}\",\"nodeSha256\":\"{}\",\"nodeVersion\":\"{}\"}}\n",
            value.runtime_id,
            value.manifest_sha256,
            value.source_revision,
            value.node_sha256,
            value.node_version
        ),
    };
    std::io::stdout()
        .write_all(record.as_bytes())
        .and_then(|_| std::io::stdout().flush())
        .map_err(|_| "runtime-channel".to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn descriptor() -> Descriptor {
        Descriptor {
            runtime_id: "a".repeat(64),
            manifest_sha256: "b".repeat(64),
            source_revision: "c".repeat(40),
            node_sha256: "d".repeat(64),
            node_version: "22.23.2".into(),
        }
    }
    #[test]
    fn exact_descriptor_round_trip() {
        let value = descriptor();
        assert_eq!(Descriptor::parse(&value.bytes()), Ok(value));
    }
    #[test]
    fn truncated_and_extra_descriptor_records_fail() {
        let mut value = descriptor().bytes();
        value.pop();
        assert!(Descriptor::parse(&value).is_err());
        value.extend_from_slice(b"\nextra\n");
        assert!(Descriptor::parse(&value).is_err());
    }
    #[test]
    fn mismatched_version_and_digest_fail() {
        let value = descriptor();
        assert!(!value.matches(&"d".repeat(64), &value.manifest_sha256));
        assert!(!value.matches(&value.runtime_id, &"d".repeat(64)));
    }
    #[test]
    fn user_and_appcontainer_mutation_grants_are_rejected() {
        assert!(grants_untrusted_write("S-1-5-32-545", 0x001f01ff, false));
        assert!(grants_untrusted_write("S-1-15-2-1", 2, false));
        assert!(!grants_untrusted_write("S-1-15-2-1", 0x001200a9, false));
        assert!(!grants_untrusted_write("S-1-3-0", 0x10000000, true));
        assert!(grants_untrusted_write("S-1-5-32-545", 0x40000000, true));
    }
    #[test]
    fn installer_owners_are_explicit() {
        assert!(installer_principal("S-1-5-18"));
        assert!(installer_principal("S-1-5-32-544"));
        assert!(!installer_principal("S-1-5-21-1-2-3-1001"));
    }
    #[test]
    fn all_five_agents_and_host_inference_have_bounded_receipts() {
        for agent in [
            "openclaw",
            "hermes",
            "pi",
            "langchain-deepagents-code",
            "nemocua",
            "inference",
        ] {
            let value = readiness(
                agent,
                "C:\\Program Files\\NVIDIA\\NemoClaw\\runtimes\\fixture",
                &descriptor(),
            )
            .unwrap();
            assert!(value.contains("\"leaseHeld\":true"));
            assert!(value.len() < 1024);
        }
        assert!(readiness("../other", "", &descriptor()).is_err());
    }
}
