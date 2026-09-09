// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Host-only ownership of persistent native console-agent state. The caller keeps
//! stdin open until MXC has stopped and restored its temporary filesystem grant.
//! Releasing a session never removes, migrates, or repairs existing user data.

fn validate_agent(agent: &str) -> Result<(), String> {
    if matches!(agent, "openclaw" | "pi" | "hermes" | "langchain-deepagents-code" | "nemocua" | "inference") {
        Ok(())
    } else {
        Err("The native state agent is invalid.".into())
    }
}

fn state_location(drive: char, sid: &str, agent: &str) -> Result<String, String> {
    validate_agent(agent)?;
    if !drive.is_ascii_alphabetic()
        || !sid.starts_with("S-1-")
        || sid.len() > 184
        || !sid[4..]
            .split('-')
            .all(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit()))
    {
        return Err("The native state identity is invalid.".into());
    }
    Ok(format!(
        "{}:\\NemoClawState-{sid}-{agent}",
        drive.to_ascii_uppercase()
    ))
}

fn readiness(agent: &str, root: &str, created: bool) -> String {
    // Both strings originate from the bounded ASCII validators above.
    format!(
        "{{\"schemaVersion\":1,\"kind\":\"native-state-session\",\"agent\":\"{agent}\",\"stateRoot\":\"{}\",\"created\":{created},\"leaseHeld\":true}}\n",
        root.replace('\\', "\\\\")
    )
}

#[cfg(windows)]
mod native {
    use std::ffi::c_void;
    use std::io::{Read, Write};
    use std::ptr::{null, null_mut};

    type RawHandle = *mut c_void;
    const FILE_ALL_ACCESS: u32 = 0x001f_01ff;
    const MUTEX_ALL_ACCESS: u32 = 0x001f_0001;
    const READ_CONTROL: u32 = 0x0002_0000;
    const FILE_ATTRIBUTE_DIRECTORY: u32 = 0x10;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;

    #[repr(C)]
    struct SecurityAttributes {
        length: u32,
        descriptor: *mut c_void,
        inherit_handle: i32,
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
    struct AttributeTagInfo {
        attributes: u32,
        tag: u32,
    }

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetCurrentProcess() -> RawHandle;
        fn CloseHandle(handle: RawHandle) -> i32;
        fn LocalFree(memory: *mut c_void) -> *mut c_void;
        fn GetWindowsDirectoryW(buffer: *mut u16, size: u32) -> u32;
        fn CreateMutexExW(
            attributes: *const SecurityAttributes,
            name: *const u16,
            flags: u32,
            access: u32,
        ) -> RawHandle;
        fn WaitForSingleObject(handle: RawHandle, milliseconds: u32) -> u32;
        fn ReleaseMutex(handle: RawHandle) -> i32;
        fn CreateDirectoryW(path: *const u16, attributes: *const SecurityAttributes) -> i32;
        fn CreateFileW(
            path: *const u16,
            access: u32,
            share: u32,
            attributes: *const SecurityAttributes,
            disposition: u32,
            flags: u32,
            template: RawHandle,
        ) -> RawHandle;
        fn GetFileInformationByHandleEx(
            handle: RawHandle,
            class: u32,
            information: *mut c_void,
            size: u32,
        ) -> i32;
        fn SetFileInformationByHandle(
            handle: RawHandle,
            class: u32,
            information: *const c_void,
            size: u32,
        ) -> i32;
    }

    #[link(name = "advapi32")]
    unsafe extern "system" {
        fn OpenProcessToken(process: RawHandle, access: u32, token: *mut RawHandle) -> i32;
        fn GetTokenInformation(
            token: RawHandle,
            class: u32,
            information: *mut c_void,
            size: u32,
            required: *mut u32,
        ) -> i32;
        fn ConvertSidToStringSidW(sid: *const c_void, string: *mut *mut u16) -> i32;
        fn ConvertStringSecurityDescriptorToSecurityDescriptorW(
            string: *const u16,
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

    fn wide(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(std::iter::once(0)).collect()
    }

    fn os_error(operation: &str) -> String {
        format!("{operation}: {}", std::io::Error::last_os_error())
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

    struct Lease(Handle);
    impl Drop for Lease {
        fn drop(&mut self) {
            unsafe { ReleaseMutex(self.0.0) };
        }
    }

    // Only accepts SIDs returned within live Windows-owned security descriptors.
    fn sid_string(sid: *const c_void) -> Result<String, String> {
        let mut text = null_mut();
        if sid.is_null() || unsafe { ConvertSidToStringSidW(sid, &mut text) } == 0 {
            return Err(os_error("The Windows account SID is unavailable"));
        }
        let _memory = LocalMemory(text.cast());
        let mut length = 0;
        while length < 184 && unsafe { *text.add(length) } != 0 {
            length += 1;
        }
        if length == 184 {
            return Err("The Windows account SID is too long.".into());
        }
        String::from_utf16(unsafe { std::slice::from_raw_parts(text, length) })
            .map_err(|_| "The Windows account SID is invalid.".into())
    }

    fn current_sid() -> Result<String, String> {
        let mut token = null_mut();
        if unsafe { OpenProcessToken(GetCurrentProcess(), 0x0008, &mut token) } == 0 {
            return Err(os_error("The Windows account token is unavailable"));
        }
        let token = Handle(token);
        let mut required = 0;
        unsafe { GetTokenInformation(token.0, 1, null_mut(), 0, &mut required) };
        if required < std::mem::size_of::<*const c_void>() as u32 || required > 4096 {
            return Err("The Windows account token size is invalid.".into());
        }
        let mut buffer = vec![0u8; required as usize];
        if unsafe {
            GetTokenInformation(
                token.0,
                1,
                buffer.as_mut_ptr().cast(),
                required,
                &mut required,
            )
        } == 0
        {
            return Err(os_error("The Windows account token could not be read"));
        }
        // TOKEN_USER starts with SID_AND_ATTRIBUTES. The byte buffer need not
        // have pointer alignment, so read its SID pointer without that assumption.
        sid_string(unsafe { buffer.as_ptr().cast::<*const c_void>().read_unaligned() })
    }

    fn descriptor(sid: &str, directory: bool) -> Result<LocalMemory, String> {
        let rights = if directory { "OICI;FA" } else { ";0x001f0001" };
        let system = if sid == "S-1-5-18" {
            String::new()
        } else {
            format!("(A;{rights};;;SY)")
        };
        let sddl = wide(&format!("O:{sid}D:P(A;{rights};;;{sid}){system}"));
        let mut descriptor = null_mut();
        if unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                sddl.as_ptr(),
                1,
                &mut descriptor,
                null_mut(),
            )
        } == 0
        {
            return Err(os_error(
                "The private native state permissions could not be created",
            ));
        }
        Ok(LocalMemory(descriptor))
    }

    fn verify_security(handle: &Handle, sid: &str, directory: bool) -> Result<(), String> {
        let mut owner = null_mut();
        let mut dacl = null_mut();
        let mut descriptor = null_mut();
        let result = unsafe {
            GetSecurityInfo(
                handle.0,
                if directory { 1 } else { 6 },
                0x5,
                &mut owner,
                null_mut(),
                &mut dacl,
                null_mut(),
                &mut descriptor,
            )
        };
        if result != 0 {
            return Err(format!(
                "Native state permissions could not be inspected (Windows {result})."
            ));
        }
        let _memory = LocalMemory(descriptor);
        if sid_string(owner)? != sid {
            return Err(
                "The native state path or session object belongs to another Windows account."
                    .into(),
            );
        }
        let mut control = 0;
        let mut revision = 0;
        if unsafe { GetSecurityDescriptorControl(descriptor, &mut control, &mut revision) } == 0 {
            return Err(os_error("Native state permissions could not be inspected"));
        }
        if dacl.is_null() || (directory && control & 0x1000 == 0) {
            return Err("Native state permissions are not private and protected.".into());
        }
        let count = unsafe { (*dacl).count };
        if count != if sid == "S-1-5-18" { 1 } else { 2 } {
            return Err("Native state permissions contain unexpected grants. Stop the prior native session before reopening; existing data was preserved.".into());
        }
        let mut owner_seen = false;
        let mut system_seen = false;
        for index in 0..u32::from(count) {
            let mut ace = null_mut();
            if unsafe { GetAce(dacl, index, &mut ace) } == 0 {
                return Err(os_error("A native state permission could not be read"));
            }
            let header = unsafe { &*ace.cast::<AceHeader>() };
            if header.kind != 0 || header.flags != if directory { 3 } else { 0 } || header.size < 16
            {
                return Err("Native state permissions contain an unexpected access rule.".into());
            }
            let bytes = ace.cast::<u8>();
            let mask = unsafe { bytes.add(4).cast::<u32>().read_unaligned() };
            if mask
                != if directory {
                    FILE_ALL_ACCESS
                } else {
                    MUTEX_ALL_ACCESS
                }
            {
                return Err(
                    "Native state permissions do not grant the required private access.".into(),
                );
            }
            let principal = sid_string(unsafe { bytes.add(8).cast() })?;
            if principal == sid && !owner_seen {
                owner_seen = true;
            } else if principal == "S-1-5-18" && !system_seen {
                system_seen = true;
            } else {
                return Err(
                    "Native state permissions grant access to an unexpected account.".into(),
                );
            }
        }
        if !owner_seen || (sid != "S-1-5-18" && !system_seen) {
            return Err("Native state permissions are missing the owner or SYSTEM rule.".into());
        }
        Ok(())
    }

    fn acquire(sid: &str, agent: &str) -> Result<Lease, String> {
        let security = descriptor(sid, false)?;
        let attributes = SecurityAttributes {
            length: std::mem::size_of::<SecurityAttributes>() as u32,
            descriptor: security.0,
            inherit_handle: 0,
        };
        // Global mutexes coordinate the same Windows account across logon/RDP
        // sessions. Creating a mutex does not need SeCreateGlobalPrivilege.
        let name = wide(&format!("Global\\NemoClaw.NativeState.{sid}.{agent}"));
        let mutex =
            unsafe { CreateMutexExW(&attributes, name.as_ptr(), 0, READ_CONTROL | 0x0010_0001) };
        if mutex.is_null() {
            return Err(os_error(
                "Native state session ownership could not be acquired",
            ));
        }
        let mutex = Handle(mutex);
        verify_security(&mutex, sid, false)?;
        match unsafe { WaitForSingleObject(mutex.0, 0) } {
            0 | 0x80 => Ok(Lease(mutex)),
            0x102 => Err(
                "This agent already has an active native session for this Windows account.".into(),
            ),
            _ => Err(os_error(
                "Native state session ownership could not be acquired",
            )),
        }
    }

    fn state_directory(root: &str, sid: &str) -> Result<(Handle, bool), String> {
        let security = descriptor(sid, true)?;
        let attributes = SecurityAttributes {
            length: std::mem::size_of::<SecurityAttributes>() as u32,
            descriptor: security.0,
            inherit_handle: 0,
        };
        let root = wide(root);
        let created = unsafe { CreateDirectoryW(root.as_ptr(), &attributes) } != 0;
        if !created && std::io::Error::last_os_error().raw_os_error() != Some(183) {
            return Err(os_error(
                "The private native state directory could not be created",
            ));
        }
        // Inspect the directory itself, never a reparse target. Do not share
        // write/delete handles: the root cannot be replaced or turned into a
        // reparse point while the lease is held. Child data IO and WRITE_DAC
        // access for MXC's temporary AppContainer grant remain available.
        let raw = unsafe {
            CreateFileW(
                root.as_ptr(),
                READ_CONTROL | 0x80,
                0x1,
                null(),
                3,
                0x0220_0000,
                null_mut(),
            )
        };
        if raw.is_null() || raw as isize == -1 {
            return Err(os_error(
                "The native state directory could not be opened safely",
            ));
        }
        let handle = Handle(raw);
        let mut attributes = AttributeTagInfo {
            attributes: 0,
            tag: 0,
        };
        if unsafe {
            GetFileInformationByHandleEx(
                handle.0,
                9,
                (&mut attributes as *mut AttributeTagInfo).cast(),
                std::mem::size_of::<AttributeTagInfo>() as u32,
            )
        } == 0
        {
            return Err(os_error(
                "The native state directory type could not be inspected",
            ));
        }
        if attributes.attributes & FILE_ATTRIBUTE_DIRECTORY == 0
            || attributes.attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
        {
            return Err(
                "The native state path must be an ordinary directory, without a reparse point."
                    .into(),
            );
        }
        verify_security(&handle, sid, true)?;
        Ok((handle, created))
    }

    fn windows_drive() -> Result<char, String> {
        let mut windows = [0u16; 32768];
        let length = unsafe { GetWindowsDirectoryW(windows.as_mut_ptr(), windows.len() as u32) };
        if length < 3
            || length as usize >= windows.len()
            || windows[1] != b':' as u16
            || windows[2] != b'\\' as u16
        {
            return Err("The Windows system drive is unavailable.".into());
        }
        char::from_u32(u32::from(windows[0]))
            .filter(char::is_ascii_alphabetic)
            .ok_or_else(|| "The Windows system drive is invalid.".into())
    }

    pub(super) fn run(agent: &str) -> Result<(), String> {
        super::validate_agent(agent)?;
        let sid = current_sid()?;
        let drive = windows_drive()?;
        let root = super::state_location(drive, &sid, agent)?;
        let _lease = acquire(&sid, agent)?;
        let (directory, created) = state_directory(&root, &sid)?;
        let mut stdout = std::io::stdout().lock();
        stdout
            .write_all(super::readiness(agent, &root, created).as_bytes())
            .and_then(|_| stdout.flush())
            .map_err(|_| "The native state readiness receipt could not be written.")?;
        drop(stdout);
        // No commands or unbounded payloads are accepted on this private pipe.
        // EOF is sent by the host only after the sandbox and gateway are stopped.
        let mut byte = [0u8; 1];
        match std::io::stdin().lock().read(&mut byte) {
            Ok(0) => verify_security(&directory, &sid, true),
            Ok(_) => Err("The native state session received unexpected input.".into()),
            Err(_) => Err("The native state session input failed.".into()),
        }
    }

    fn collect_removal_handles(path: &std::path::Path, depth: usize, count: &mut usize, handles: &mut Vec<Handle>, sid: Option<&str>) -> Result<(), String> {
        if depth > 64 || *count >= 16_384 {
            return Err("The selected state exceeds the bounded native removal limit; no data was removed.".into());
        }
        *count += 1;
        use std::os::windows::ffi::OsStrExt;
        let name: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        let raw = unsafe { CreateFileW(name.as_ptr(), READ_CONTROL | 0x80 | 0x0001_0000, 1, null(), 3, 0x0220_0000, null_mut()) };
        if raw.is_null() || raw as isize == -1 {
            return Err(os_error("The selected state contains a file that cannot be held for safe removal"));
        }
        let handle = Handle(raw);
        let mut attributes = AttributeTagInfo { attributes: 0, tag: 0 };
        if unsafe { GetFileInformationByHandleEx(handle.0, 9, (&mut attributes as *mut AttributeTagInfo).cast(), std::mem::size_of::<AttributeTagInfo>() as u32) } == 0 {
            return Err(os_error("The selected state file type could not be inspected"));
        }
        if attributes.attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err("The selected state contains a reparse point; no data was removed.".into());
        }
        if let Some(sid) = sid {
            if attributes.attributes & FILE_ATTRIBUTE_DIRECTORY == 0 {
                return Err("The selected native state root is not a directory.".into());
            }
            verify_security(&handle, sid, true)?;
        }
        if attributes.attributes & FILE_ATTRIBUTE_DIRECTORY != 0 {
            for entry in std::fs::read_dir(path).map_err(|_| "The selected state directory could not be listed safely.")? {
                let entry = entry.map_err(|_| "A selected state entry could not be read safely.")?;
                collect_removal_handles(&entry.path(), depth + 1, count, handles, None)?;
            }
        }
        // Every ancestor and entry remains held without write/delete sharing.
        // The complete tree is validated before marking anything for deletion.
        handles.push(handle);
        Ok(())
    }

    fn remove_owned_tree(root: &str, sid: &str) -> Result<bool, String> {
        let path = std::path::Path::new(root);
        match std::fs::symlink_metadata(path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
            Err(_) => return Err("The selected native state could not be inspected.".into()),
            Ok(_) => (),
        }
        let mut handles = Vec::new();
        collect_removal_handles(path, 0, &mut 0, &mut handles, Some(sid))?;
        // Postorder plus handle-based disposition avoids reopening paths after
        // validation. A junction is never followed, including during deletion.
        for handle in handles {
            // Windows ARM64's supported baseline includes FileDispositionInfoEx.
            // Ignore read-only status only for this opened link; do not rewrite
            // attributes that may be shared with an unrelated hard-link name.
            let delete: u32 = 0x11; // DELETE | IGNORE_READONLY_ATTRIBUTE; no POSIX override
            if unsafe { SetFileInformationByHandle(handle.0, 21, (&delete as *const u32).cast(), 4) } == 0 {
                return Err(os_error("Windows could not remove a selected state entry"));
            }
            drop(handle);
        }
        Ok(true)
    }

    pub(super) fn remove(agent: &str) -> Result<(), String> {
        super::validate_agent(agent)?;
        if agent == "inference" {
            return Err("Agent data removal does not include shared inference state.".into());
        }
        let sid = current_sid()?;
        let root = super::state_location(windows_drive()?, &sid, agent)?;
        let _lease = acquire(&sid, agent)?;
        let removed = remove_owned_tree(&root, &sid)?;
        let receipt = format!("{{\"schemaVersion\":1,\"kind\":\"native-state-remove\",\"agent\":\"{agent}\",\"stateRoot\":\"{}\",\"removed\":{removed},\"leaseHeld\":true}}\n", root.replace('\\', "\\\\"));
        let mut stdout = std::io::stdout().lock();
        stdout.write_all(receipt.as_bytes()).and_then(|_| stdout.flush()).map_err(|_| "The native removal receipt could not be written.")?;
        drop(stdout);
        // The config/credential owner retains this mutex until it finishes its
        // exact metadata deletion. Concurrent agent startup remains excluded.
        let mut byte = [0u8; 1];
        match std::io::stdin().lock().read(&mut byte) {
            Ok(0) => Ok(()),
            _ => Err("The native removal session received unexpected input.".into()),
        }
    }

    #[cfg(test)]
    mod tests {
        include!("state_session_windows_tests.rs");
    }
}

#[cfg(windows)]
pub fn run(agent: &str) -> Result<(), String> {
    native::run(agent)
}

#[cfg(windows)]
pub fn remove(agent: &str) -> Result<(), String> {
    native::remove(agent)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn distinct_accounts_and_agents_keep_stable_drive_root_state() {
        assert_eq!(
            state_location('c', "S-1-5-21-100-200-300-1001", "hermes").unwrap(),
            "C:\\NemoClawState-S-1-5-21-100-200-300-1001-hermes"
        );
        assert_ne!(
            state_location('C', "S-1-5-21-1001", "hermes"),
            state_location('C', "S-1-5-21-1002", "hermes")
        );
        assert_ne!(
            state_location('C', "S-1-5-21-1001", "hermes"),
            state_location('C', "S-1-5-21-1001", "pi")
        );
    }

    #[test]
    fn rejects_path_or_identity_injection() {
        for agent in [
            "",
            "../hermes",
            "hermes\\data",
            "unknown-agent",
            "hermes\"",
            "pi\0",
        ] {
            assert!(state_location('C', "S-1-5-21-1001", agent).is_err());
        }
        for sid in [
            "",
            "S-1-",
            "S-1-5--1",
            "S-1-5-..",
            "S-1-5-1\\data",
            "S-1-5-1\n",
        ] {
            assert!(state_location('C', sid, "hermes").is_err());
        }
        assert!(state_location('\\', "S-1-5-21-1001", "hermes").is_err());
        assert!(state_location('C', &format!("S-1-5-{}", "1".repeat(185)), "hermes").is_err());
    }

    #[test]
    fn readiness_is_one_bounded_json_line_with_escaped_windows_path() {
        let root = state_location('C', "S-1-5-21-1001", "hermes").unwrap();
        let line = readiness("hermes", &root, true);
        assert_eq!(
            line,
            "{\"schemaVersion\":1,\"kind\":\"native-state-session\",\"agent\":\"hermes\",\"stateRoot\":\"C:\\\\NemoClawState-S-1-5-21-1001-hermes\",\"created\":true,\"leaseHeld\":true}\n"
        );
        assert_eq!(line.lines().count(), 1);
        assert!(line.len() < 1024);
    }
}
