// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! The UI relay's host file authority. Untrusted file names never reach a
//! full-path open: all child IO is relative to a live, non-reparse directory
//! handle. Windows sharing modes prevent replacing those directories while held.

const MAX_CHUNK: usize = 1024 * 1024;
#[cfg(windows)]
const MAX_LINE: usize = 4 * MAX_CHUNK.div_ceil(3) + 128;
const BASE64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

fn stream_name(value: &str) -> bool {
    value.len() == 23
        && value.starts_with("stream-")
        && value[7..]
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn stream_file(value: &str) -> bool {
    if matches!(value, "open" | "host-close" | "sandbox-close") {
        return true;
    }
    let number = value
        .strip_prefix("host-")
        .or_else(|| value.strip_prefix("sandbox-"))
        .and_then(|value| value.strip_suffix(".bin"));
    number.is_some_and(|value| value.len() == 10 && value.bytes().all(|byte| byte.is_ascii_digit()))
}

fn relative_name(value: &str) -> Option<(Option<&str>, &str)> {
    if matches!(value, "ready" | "shutdown") {
        return Some((None, value));
    }
    let (stream, file) = value.split_once('/')?;
    (stream_name(stream) && stream_file(file)).then_some((Some(stream), file))
}

fn encode(bytes: &[u8]) -> String {
    let mut output = String::with_capacity(4 * bytes.len().div_ceil(3));
    for group in bytes.chunks(3) {
        let value = (u32::from(group[0]) << 16)
            | (u32::from(*group.get(1).unwrap_or(&0)) << 8)
            | u32::from(*group.get(2).unwrap_or(&0));
        output.push(BASE64[((value >> 18) & 63) as usize] as char);
        output.push(BASE64[((value >> 12) & 63) as usize] as char);
        output.push(if group.len() > 1 {
            BASE64[((value >> 6) & 63) as usize] as char
        } else {
            '='
        });
        output.push(if group.len() > 2 {
            BASE64[(value & 63) as usize] as char
        } else {
            '='
        });
    }
    output
}

fn decode(text: &str) -> Result<Vec<u8>, &'static str> {
    if text.len() > 4 * MAX_CHUNK.div_ceil(3) || text.len() % 4 != 0 {
        return Err("base64");
    }
    let mut output = Vec::with_capacity(text.len() / 4 * 3);
    for group in text.as_bytes().chunks(4) {
        let mut value = 0u32;
        for &byte in group {
            let digit = match byte {
                b'A'..=b'Z' => u32::from(byte - b'A'),
                b'a'..=b'z' => u32::from(byte - b'a') + 26,
                b'0'..=b'9' => u32::from(byte - b'0') + 52,
                b'+' => 62,
                b'/' => 63,
                b'=' => 0,
                _ => return Err("base64"),
            };
            value = (value << 6) | digit;
        }
        output.push((value >> 16) as u8);
        if group[2] != b'=' {
            output.push((value >> 8) as u8);
        }
        if group[3] != b'=' {
            output.push(value as u8);
        }
    }
    if output.len() > MAX_CHUNK || encode(&output) != text {
        return Err("base64");
    }
    Ok(output)
}

#[cfg(windows)]
mod native {
    use super::*;
    use std::cell::RefCell;
    use std::collections::HashMap;
    use std::ffi::{OsStr, c_void};
    use std::io::{BufRead, Write};
    use std::ptr::{null, null_mut};
    use std::time::Instant;

    type RawHandle = *mut c_void;
    const DIRECTORY: u32 = 0x10;
    const REPARSE: u32 = 0x400;
    const DIRECTORY_ACCESS: u32 = 0x0012_00a1; // synchronize, read-control, attributes, traverse, list
    const READ_ACCESS: u32 = 0x0012_0081;
    const WRITE_ACCESS: u32 = 0x0013_0082; // also DELETE for handle-relative atomic rename

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
    struct StandardInfo {
        allocation: i64,
        size: i64,
        links: u32,
        deleting: u8,
        directory: u8,
    }
    #[repr(C)]
    struct RenameInfo {
        replace: u32,
        root: RawHandle,
        length: u32,
        name: [u16; 1],
    }

    #[cfg(target_pointer_width = "64")]
    const _: () = {
        assert!(std::mem::size_of::<UnicodeString>() == 16);
        assert!(std::mem::size_of::<ObjectAttributes>() == 48);
        assert!(std::mem::size_of::<IoStatus>() == 16);
        assert!(std::mem::size_of::<AttributeTag>() == 8);
        assert!(std::mem::size_of::<StandardInfo>() == 24);
        assert!(std::mem::offset_of!(RenameInfo, root) == 8);
        assert!(std::mem::offset_of!(RenameInfo, name) == 20);
    };

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
        fn GetCurrentProcess() -> RawHandle;
        fn LocalFree(memory: *mut c_void) -> *mut c_void;
        fn GetFileInformationByHandleEx(
            handle: RawHandle,
            class: u32,
            value: *mut c_void,
            size: u32,
        ) -> i32;
        fn SetFileInformationByHandle(
            handle: RawHandle,
            class: u32,
            value: *const c_void,
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
    }
    #[link(name = "advapi32")]
    unsafe extern "system" {
        fn OpenProcessToken(process: RawHandle, access: u32, token: *mut RawHandle) -> i32;
        fn GetTokenInformation(
            token: RawHandle,
            class: u32,
            value: *mut c_void,
            size: u32,
            required: *mut u32,
        ) -> i32;
        fn ConvertSidToStringSidW(sid: *const c_void, value: *mut *mut u16) -> i32;
        fn ConvertStringSecurityDescriptorToSecurityDescriptorW(
            value: *const u16,
            revision: u32,
            descriptor: *mut *mut c_void,
            size: *mut u32,
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
        fn GetSecurityDescriptorControl(
            descriptor: *const c_void,
            control: *mut u16,
            revision: *mut u32,
        ) -> i32;
        fn GetAce(acl: *const Acl, index: u32, ace: *mut *mut c_void) -> i32;
    }

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

    fn sid_string(sid: *const c_void) -> Result<String, &'static str> {
        let mut value = null_mut();
        if sid.is_null() || unsafe { ConvertSidToStringSidW(sid, &mut value) } == 0 {
            return Err("owner");
        }
        let _memory = LocalMemory(value.cast());
        let mut length = 0;
        while length < 184 && unsafe { *value.add(length) } != 0 {
            length += 1;
        }
        if length == 184 {
            return Err("owner");
        }
        String::from_utf16(unsafe { std::slice::from_raw_parts(value, length) })
            .map_err(|_| "owner")
    }

    fn current_sid() -> Result<String, &'static str> {
        let mut token = null_mut();
        if unsafe { OpenProcessToken(GetCurrentProcess(), 8, &mut token) } == 0 {
            return Err("owner");
        }
        let token = Handle(token);
        let mut required = 0;
        unsafe {
            GetTokenInformation(token.0, 1, null_mut(), 0, &mut required);
        }
        if required < std::mem::size_of::<RawHandle>() as u32 || required > 4096 {
            return Err("owner");
        }
        let mut bytes = vec![0u8; required as usize];
        if unsafe {
            GetTokenInformation(
                token.0,
                1,
                bytes.as_mut_ptr().cast(),
                required,
                &mut required,
            )
        } == 0
        {
            return Err("owner");
        }
        sid_string(unsafe { bytes.as_ptr().cast::<*const c_void>().read_unaligned() })
    }

    fn descriptor(sid: &str, private: bool) -> Result<LocalMemory, &'static str> {
        let value = if private {
            let system = if sid == "S-1-5-18" {
                ""
            } else {
                "(A;OICI;FA;;;SY)"
            };
            format!("O:{sid}D:P(A;OICI;FA;;;{sid}){system}")
        } else {
            format!("O:{sid}")
        };
        let wide = value
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect::<Vec<_>>();
        let mut descriptor = null_mut();
        if unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                wide.as_ptr(),
                1,
                &mut descriptor,
                null_mut(),
            )
        } == 0
        {
            return Err("permissions");
        }
        Ok(LocalMemory(descriptor))
    }

    fn open_relative(
        parent: Option<&Handle>,
        name: &str,
        access: u32,
        share: u32,
        disposition: u32,
        directory: bool,
        security: Option<&LocalMemory>,
    ) -> Result<Handle, &'static str> {
        let mut name = name.encode_utf16().collect::<Vec<_>>();
        let length = name
            .len()
            .checked_mul(2)
            .filter(|length| *length <= 32766)
            .ok_or("name")? as u16;
        let mut unicode = UnicodeString {
            length,
            maximum: length,
            buffer: name.as_mut_ptr(),
        };
        let mut attributes = ObjectAttributes {
            length: std::mem::size_of::<ObjectAttributes>() as u32,
            root: parent.map_or(null_mut(), |parent| parent.0),
            name: &mut unicode,
            // The initial volume open resolves the Windows DOS-device mapping.
            // Every filesystem child is then opened relative to a pinned parent
            // with OBJ_DONT_REPARSE, so no filesystem link is followed.
            flags: 0x40 | if parent.is_some() { 0x1000 } else { 0 },
            security: security.map_or(null_mut(), |security| security.0),
            quality: null_mut(),
        };
        let mut status = IoStatus::default();
        let mut handle = null_mut();
        let options = 0x0020_0020
            | if directory && disposition != 1 {
                1
            } else if !directory {
                0x40
            } else {
                0
            };
        let result = unsafe {
            NtCreateFile(
                &mut handle,
                access,
                &mut attributes,
                &mut status,
                null(),
                0x80,
                share,
                disposition,
                options,
                null(),
                0,
            )
        };
        if result < 0 {
            return Err(match unsafe { RtlNtStatusToDosError(result) } {
                2 | 3 => "missing",
                80 | 183 => "exists",
                32 | 33 => "busy",
                5 => "access",
                _ => "unsafe-file",
            });
        }
        if handle.is_null() {
            return Err("io");
        }
        Ok(Handle(handle))
    }

    fn attributes(handle: &Handle) -> Result<AttributeTag, &'static str> {
        let mut information = AttributeTag {
            attributes: 0,
            tag: 0,
        };
        if unsafe {
            GetFileInformationByHandleEx(
                handle.0,
                9,
                (&mut information as *mut AttributeTag).cast(),
                std::mem::size_of::<AttributeTag>() as u32,
            )
        } == 0
        {
            return Err("attributes");
        }
        if information.attributes & REPARSE != 0 {
            return Err("reparse");
        }
        Ok(information)
    }

    fn verify_directory(handle: &Handle, sid: Option<&str>) -> Result<(), &'static str> {
        if attributes(handle)?.attributes & DIRECTORY == 0 {
            return Err("directory");
        }
        if let Some(sid) = sid {
            let mut owner = null_mut();
            let mut descriptor = null_mut();
            if unsafe {
                GetSecurityInfo(
                    handle.0,
                    1,
                    1,
                    &mut owner,
                    null_mut(),
                    null_mut(),
                    null_mut(),
                    &mut descriptor,
                )
            } != 0
            {
                return Err("owner");
            }
            let _memory = LocalMemory(descriptor);
            if sid_string(owner)? != sid {
                return Err("foreign-owner");
            }
        }
        Ok(())
    }

    fn verify_private_root(handle: &Handle, sid: &str) -> Result<(), &'static str> {
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
            return Err("permissions");
        }
        let _memory = LocalMemory(descriptor);
        let mut control = 0;
        let mut revision = 0;
        if sid_string(owner)? != sid
            || dacl.is_null()
            || unsafe { GetSecurityDescriptorControl(descriptor, &mut control, &mut revision) } == 0
            || control & 0x1000 == 0
        {
            return Err("private-permissions");
        }
        let count = unsafe { (*dacl).count };
        if count != if sid == "S-1-5-18" { 1 } else { 2 } {
            return Err("private-permissions");
        }
        let mut owner_seen = false;
        let mut system_seen = false;
        for index in 0..u32::from(count) {
            let mut ace = null_mut();
            if unsafe { GetAce(dacl, index, &mut ace) } == 0 || ace.is_null() {
                return Err("private-permissions");
            }
            let header = unsafe { &*ace.cast::<AceHeader>() };
            if header.kind != 0 || header.flags != 3 || header.size < 16 {
                return Err("private-permissions");
            }
            let bytes = ace.cast::<u8>();
            if unsafe { bytes.add(4).cast::<u32>().read_unaligned() } != 0x001f_01ff {
                return Err("private-permissions");
            }
            let principal = sid_string(unsafe { bytes.add(8).cast() })?;
            if principal == sid && !owner_seen {
                owner_seen = true;
            } else if principal == "S-1-5-18" && !system_seen {
                system_seen = true;
            } else {
                return Err("private-permissions");
            }
        }
        if !owner_seen || (sid != "S-1-5-18" && !system_seen) {
            return Err("private-permissions");
        }
        Ok(())
    }

    fn file_size(handle: &Handle) -> Result<usize, &'static str> {
        if attributes(handle)?.attributes & DIRECTORY != 0 {
            return Err("file-type");
        }
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
        {
            return Err("attributes");
        }
        if info.links != 1 || info.directory != 0 || info.deleting != 0 {
            return Err("file-links");
        }
        if info.size < 0 || info.size as u64 > MAX_CHUNK as u64 {
            return Err("size");
        }
        Ok(info.size as usize)
    }

    fn delete_handle(handle: &Handle) -> Result<(), &'static str> {
        let delete = 1i32;
        if unsafe { SetFileInformationByHandle(handle.0, 4, (&delete as *const i32).cast(), 4) }
            == 0
        {
            return Err("unlink");
        }
        Ok(())
    }

    #[derive(Default)]
    struct Performance {
        read_success: u64,
        read_miss: u64,
        read_bytes: u64,
        write_success: u64,
        write_bytes: u64,
        list_success: u64,
        list_entries: u64,
        flush_calls: u64,
        flush_failed: u64,
        flush_ns: u64,
        flush_max_ns: u64,
        binary_flush_calls: u64,
        binary_flush_ns: u64,
    }

    impl Performance {
        fn json(&self) -> String {
            format!(
                "{{\"schemaVersion\":1,\"read_success\":{},\"read_miss\":{},\"read_bytes\":{},\"write_success\":{},\"write_bytes\":{},\"list_success\":{},\"list_entries\":{},\"flush_calls\":{},\"flush_failed\":{},\"flush_ns\":{},\"flush_max_ns\":{},\"binary_flush_calls\":{},\"binary_flush_ns\":{}}}",
                self.read_success,
                self.read_miss,
                self.read_bytes,
                self.write_success,
                self.write_bytes,
                self.list_success,
                self.list_entries,
                self.flush_calls,
                self.flush_failed,
                self.flush_ns,
                self.flush_max_ns,
                self.binary_flush_calls,
                self.binary_flush_ns
            )
        }
    }

    struct Owner {
        streams: HashMap<String, Handle>,
        _lock: Handle,
        root: Handle,
        _ancestors: Vec<Handle>,
        sid: String,
        inherited_owner: LocalMemory,
        serial: u64,
        performance: RefCell<Option<Performance>>,
    }

    impl Owner {
        fn new(root: &OsStr) -> Result<Self, &'static str> {
            let text = root.to_str().ok_or("root")?;
            let bytes = text.as_bytes();
            if bytes.len() < 4 || !bytes[0].is_ascii_alphabetic() || &bytes[1..3] != b":\\" {
                return Err("root");
            }
            let parts = text[3..].split('\\').collect::<Vec<_>>();
            if parts.len() > 16
                || parts.iter().any(|part| {
                    part.is_empty()
                        || matches!(*part, "." | "..")
                        || part.encode_utf16().count() > 255
                        || part.contains(['/', ':', '\0'])
                        || part.ends_with(['.', ' '])
                })
            {
                return Err("root");
            }
            let sid = current_sid()?;
            let private = descriptor(&sid, true)?;
            let inherited_owner = descriptor(&sid, false)?;
            let volume = open_relative(
                None,
                &format!("\\??\\{}:\\", bytes[0] as char),
                DIRECTORY_ACCESS,
                7,
                1,
                true,
                None,
            )?;
            verify_directory(&volume, None)?;
            let mut ancestors = vec![volume];
            for part in &parts[..parts.len() - 1] {
                let parent = ancestors.last().ok_or("root")?;
                let next = open_relative(Some(parent), part, DIRECTORY_ACCESS, 1, 1, true, None)?;
                verify_directory(&next, None)?;
                ancestors.push(next);
            }
            let parent = ancestors.last().ok_or("root")?;
            let name = parts.last().ok_or("root")?;
            let root = match open_relative(
                Some(parent),
                name,
                DIRECTORY_ACCESS,
                1,
                2,
                true,
                Some(&private),
            ) {
                Ok(root) => root,
                Err("exists") => {
                    open_relative(Some(parent), name, DIRECTORY_ACCESS, 1, 1, true, None)?
                }
                Err(error) => return Err(error),
            };
            verify_directory(&root, Some(&sid))?;
            // Check before publishing any token. MXC may grant the selected
            // container access only after this private host owner is ready.
            verify_private_root(&root, &sid)?;
            // Exclusive open is the per-root owner lease. This private marker is
            // outside the wire-name grammar and never read or removed by RPC.
            let lock = open_relative(
                Some(&root),
                ".native-ui-owner",
                READ_ACCESS | 2,
                0,
                3,
                false,
                Some(&private),
            )?;
            if file_size(&lock)? != 0 {
                return Err("owner-lock");
            }
            Ok(Self {
                streams: HashMap::new(),
                _lock: lock,
                root,
                _ancestors: ancestors,
                sid,
                inherited_owner,
                serial: 0,
                performance: RefCell::new(None),
            })
        }

        fn directory(&self, relative: &str) -> Result<(&Handle, String), &'static str> {
            let (stream, file) = relative_name(relative).ok_or("name")?;
            let parent = match stream {
                Some(stream) => self.streams.get(stream).ok_or("stream-closed")?,
                None => &self.root,
            };
            Ok((parent, file.to_owned()))
        }

        fn mkdir(&mut self, name: &str) -> Result<(), &'static str> {
            if !stream_name(name) {
                return Err("name");
            }
            if self.streams.len() >= 128 {
                return Err("stream-limit");
            }
            if self.streams.contains_key(name) {
                return Err("exists");
            }
            let handle = open_relative(
                Some(&self.root),
                name,
                DIRECTORY_ACCESS,
                1,
                2,
                true,
                Some(&self.inherited_owner),
            )?;
            verify_directory(&handle, Some(&self.sid))?;
            self.streams.insert(name.to_owned(), handle);
            Ok(())
        }

        fn read(&self, relative: &str) -> Result<Option<Vec<u8>>, &'static str> {
            let (parent, file) = self.directory(relative)?;
            let handle = match open_relative(Some(parent), &file, READ_ACCESS, 1, 1, false, None) {
                Ok(handle) => handle,
                Err("missing") | Err("busy") => return Ok(None),
                Err(error) => return Err(error),
            };
            let size = file_size(&handle)?;
            let mut bytes = vec![0u8; size];
            let mut total = 0;
            while total < size {
                let mut read = 0;
                if unsafe {
                    ReadFile(
                        handle.0,
                        bytes[total..].as_mut_ptr().cast(),
                        (size - total) as u32,
                        &mut read,
                        null_mut(),
                    )
                } == 0
                    || read == 0
                {
                    return Err("read");
                }
                total += read as usize;
            }
            if file_size(&handle)? != size {
                return Err("changed");
            }
            Ok(Some(bytes))
        }

        fn write(&mut self, relative: &str, bytes: &[u8]) -> Result<(), &'static str> {
            self.write_then(relative, bytes, || Ok(()))
        }

        fn write_then(
            &mut self,
            relative: &str,
            bytes: &[u8],
            published: impl FnOnce() -> Result<(), &'static str>,
        ) -> Result<(), &'static str> {
            if bytes.len() > MAX_CHUNK {
                return Err("size");
            }
            self.serial = self.serial.checked_add(1).ok_or("limit")?;
            let temporary = format!(
                ".native-ui-write-{}-{:016x}.tmp",
                std::process::id(),
                self.serial
            );
            let (parent, file) = self.directory(relative)?;
            let handle = open_relative(
                Some(parent),
                &temporary,
                WRITE_ACCESS,
                1, // allow Node readers immediately after publication; deny write/delete
                2,
                false,
                Some(&self.inherited_owner),
            )?;
            let result = (|| {
                let mut total = 0;
                while total < bytes.len() {
                    let mut written = 0;
                    if unsafe {
                        WriteFile(
                            handle.0,
                            bytes[total..].as_ptr().cast(),
                            (bytes.len() - total) as u32,
                            &mut written,
                            null_mut(),
                        )
                    } == 0
                        || written == 0
                    {
                        return Err("write");
                    }
                    total += written as usize;
                }
                let measured = self.performance.borrow().is_some().then(Instant::now);
                let flushed = unsafe { FlushFileBuffers(handle.0) };
                if let Some(started) = measured {
                    let elapsed = started.elapsed().as_nanos().min(u128::from(u64::MAX)) as u64;
                    if let Some(counters) = self.performance.borrow_mut().as_mut() {
                        counters.flush_calls = counters.flush_calls.saturating_add(1);
                        counters.flush_failed = counters
                            .flush_failed
                            .saturating_add(u64::from(flushed == 0));
                        counters.flush_ns = counters.flush_ns.saturating_add(elapsed);
                        counters.flush_max_ns = counters.flush_max_ns.max(elapsed);
                        if relative.ends_with(".bin") {
                            counters.binary_flush_calls =
                                counters.binary_flush_calls.saturating_add(1);
                            counters.binary_flush_ns =
                                counters.binary_flush_ns.saturating_add(elapsed);
                        }
                    }
                }
                if flushed == 0 {
                    return Err("flush");
                }
                let name = file.encode_utf16().collect::<Vec<_>>();
                let offset = std::mem::offset_of!(RenameInfo, name);
                let size = std::mem::size_of::<RenameInfo>() + name.len() * 2;
                let mut buffer = vec![0u64; size.div_ceil(8)];
                let info = buffer.as_mut_ptr().cast::<RenameInfo>();
                unsafe {
                    (*info).replace = 0;
                    // Native same-directory rename uses the opened source's
                    // parent. Supplying RootDirectory would reopen that directory
                    // for write and conflict with its held no-write-share guard.
                    // The name is one allowlisted leaf, never a CWD-relative path.
                    (*info).root = null_mut();
                    (*info).length = (name.len() * 2) as u32;
                    std::ptr::copy_nonoverlapping(
                        name.as_ptr(),
                        buffer.as_mut_ptr().cast::<u8>().add(offset).cast(),
                        name.len(),
                    );
                }
                let mut status = IoStatus::default();
                if unsafe {
                    NtSetInformationFile(
                        handle.0,
                        &mut status,
                        buffer.as_ptr().cast(),
                        size as u32,
                        10,
                    )
                } < 0
                {
                    return Err("publish");
                }
                published()
            })();
            if result.is_err() {
                let _ = delete_handle(&handle);
            }
            result
        }

        fn unlink(&self, relative: &str) -> Result<(), &'static str> {
            let (parent, file) = self.directory(relative)?;
            let handle = match open_relative(
                Some(parent),
                &file,
                READ_ACCESS | 0x10000,
                1,
                1,
                false,
                None,
            ) {
                Ok(handle) => handle,
                Err("missing") => return Ok(()),
                Err(error) => return Err(error),
            };
            file_size(&handle)?;
            delete_handle(&handle)
        }

        fn list(&self, name: &str) -> Result<Vec<String>, &'static str> {
            if !stream_name(name) {
                return Err("name");
            }
            let directory = self.streams.get(name).ok_or("stream-closed")?;
            let mut names = Vec::new();
            let mut seen = 0;
            let mut restart = true;
            loop {
                let mut buffer = vec![0u64; 8192];
                if unsafe {
                    GetFileInformationByHandleEx(
                        directory.0,
                        if restart { 15 } else { 14 },
                        buffer.as_mut_ptr().cast(),
                        65536,
                    )
                } == 0
                {
                    if std::io::Error::last_os_error().raw_os_error() == Some(18) {
                        break;
                    }
                    return Err("list");
                }
                restart = false;
                let bytes =
                    unsafe { std::slice::from_raw_parts(buffer.as_ptr().cast::<u8>(), 65536) };
                let mut offset = 0;
                loop {
                    if offset + 68 > bytes.len() {
                        return Err("list");
                    }
                    let number = |position: usize| {
                        u32::from_le_bytes(bytes[position..position + 4].try_into().unwrap())
                    };
                    let next = number(offset) as usize;
                    let flags = number(offset + 56);
                    let length = number(offset + 60) as usize;
                    if length % 2 != 0 || offset + 68 + length > bytes.len() {
                        return Err("list");
                    }
                    let wide = bytes[offset + 68..offset + 68 + length]
                        .chunks_exact(2)
                        .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
                        .collect::<Vec<_>>();
                    let file = String::from_utf16(&wide).map_err(|_| "name")?;
                    seen += 1;
                    if seen > 4096 {
                        return Err("list-limit");
                    }
                    if stream_file(&file) {
                        if flags & (REPARSE | DIRECTORY) != 0 {
                            return Err("reparse");
                        }
                        names.push(file);
                    }
                    if next == 0 {
                        break;
                    }
                    if next < 68 || offset + next >= bytes.len() {
                        return Err("list");
                    }
                    offset += next;
                }
            }
            names.sort();
            Ok(names)
        }

        fn command(&mut self, line: &str) -> Result<String, &'static str> {
            let fields = line.split('\t').collect::<Vec<_>>();
            match fields.as_slice() {
                ["mkdir", name] => {
                    self.mkdir(name)?;
                    Ok("OK".into())
                }
                ["read", name] => {
                    let result = self.read(name)?;
                    if let Some(counters) = self.performance.borrow_mut().as_mut() {
                        if let Some(bytes) = &result {
                            counters.read_success = counters.read_success.saturating_add(1);
                            counters.read_bytes =
                                counters.read_bytes.saturating_add(bytes.len() as u64);
                        } else {
                            counters.read_miss = counters.read_miss.saturating_add(1);
                        }
                    }
                    Ok(match result {
                        Some(bytes) => format!("OK\t{}", encode(&bytes)),
                        None => "MISS".into(),
                    })
                }
                ["write", name, value] => {
                    let bytes = decode(value)?;
                    self.write(name, &bytes)?;
                    if let Some(counters) = self.performance.borrow_mut().as_mut() {
                        counters.write_success = counters.write_success.saturating_add(1);
                        counters.write_bytes =
                            counters.write_bytes.saturating_add(bytes.len() as u64);
                    }
                    Ok("OK".into())
                }
                ["list", name] => {
                    let names = self.list(name)?;
                    if let Some(counters) = self.performance.borrow_mut().as_mut() {
                        counters.list_success = counters.list_success.saturating_add(1);
                        counters.list_entries =
                            counters.list_entries.saturating_add(names.len() as u64);
                    }
                    Ok(format!("OK\t{}", names.join(",")))
                }
                ["performance", "enable"] => {
                    let mut counters = self.performance.borrow_mut();
                    if counters.is_some() {
                        return Err("performance-enabled");
                    }
                    *counters = Some(Performance::default());
                    Ok("OK".into())
                }
                ["performance"] => {
                    let counters = self.performance.borrow();
                    Ok(format!(
                        "OK\t{}",
                        counters.as_ref().ok_or("performance-disabled")?.json()
                    ))
                }
                ["unlink", name] => {
                    self.unlink(name)?;
                    Ok("OK".into())
                }
                ["release", name] if stream_name(name) => {
                    self.streams.remove(*name).ok_or("stream-closed")?;
                    Ok("OK".into())
                }
                ["close"] => Ok("OK".into()),
                _ => Err("command"),
            }
        }
    }

    pub(super) fn run(root: &OsStr) -> Result<(), &'static str> {
        let mut owner = Owner::new(root)?;
        let mut output = std::io::stdout().lock();
        output
            .write_all(b"READY\n")
            .and_then(|_| output.flush())
            .map_err(|_| "output")?;
        let input = std::io::stdin();
        let mut input = input.lock();
        loop {
            let mut line = Vec::new();
            let read = std::io::Read::take(&mut input, (MAX_LINE + 1) as u64)
                .read_until(b'\n', &mut line)
                .map_err(|_| "input")?;
            if read == 0 {
                return Ok(());
            }
            if line.len() > MAX_LINE || line.last() != Some(&b'\n') || !line.is_ascii() {
                return Err("input-limit");
            }
            line.pop();
            let text = std::str::from_utf8(&line).map_err(|_| "input")?;
            let result = owner.command(text);
            let response = match result {
                Ok(response) => response,
                Err(code) => format!("ERR\t{code}"),
            };
            output
                .write_all(response.as_bytes())
                .and_then(|_| output.write_all(b"\n"))
                .and_then(|_| output.flush())
                .map_err(|_| "output")?;
            if text == "close" {
                return Ok(());
            }
        }
    }

    #[cfg(test)]
    mod tests {
        include!("native_ui_file_owner_windows_tests.rs");
    }
}

#[cfg(windows)]
pub fn run(root: &std::ffi::OsStr) -> Result<(), String> {
    native::run(root).map_err(|code| format!("The native UI file owner failed: {code}."))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn wire_names_never_address_host_paths_or_arbitrary_files() {
        assert_eq!(relative_name("ready"), Some((None, "ready")));
        assert!(relative_name("stream-0123456789abcdef/sandbox-0000000001.bin").is_some());
        for name in [
            "../native-windows.json",
            "C:\\Users\\config",
            "stream-0123456789abcdef/../ready",
            "stream-0123456789abcdef/open:secret",
            "stream-0123456789abcdef/host-1.bin",
            "stream-0123456789abcdef/open/child",
            "stream-0123456789ABCDEf/open",
        ] {
            assert!(relative_name(name).is_none(), "{name}");
        }
    }
    #[test]
    fn base64_round_trip_is_canonical_and_bounded() {
        for bytes in [
            Vec::new(),
            vec![0],
            vec![0, 255],
            (0..=255).collect::<Vec<u8>>(),
            vec![42; MAX_CHUNK],
        ] {
            assert_eq!(decode(&encode(&bytes)).unwrap(), bytes);
        }
        for value in ["A", "AA=A", "A===", "AAAA====", "AB==", "AAAA\n", "____"] {
            assert!(decode(value).is_err(), "{value}");
        }
        assert!(decode(&encode(&vec![42; MAX_CHUNK + 1])).is_err());
    }
}
