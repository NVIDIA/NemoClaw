// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]

#[cfg(not(target_os = "windows"))]
compile_error!("The NemoClaw launcher is Windows-only.");

use std::env;
use std::ffi::OsStr;
use std::ffi::c_void;
use std::io::{Read, Write};
use std::iter;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::process::CommandExt;
use std::path::PathBuf;
use std::process::{Command, exit};
use std::ptr;

const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const DETACHED_PROCESS: u32 = 0x0000_0008;
const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;
const CRED_TYPE_GENERIC: u32 = 1;
const CRED_PERSIST_LOCAL_MACHINE: u32 = 2;
const MAX_CREDENTIAL_BYTES: usize = 2048;

#[repr(C)]
struct FileTime {
    low_date_time: u32,
    high_date_time: u32,
}

#[repr(C)]
struct CredentialW {
    flags: u32,
    credential_type: u32,
    target_name: *mut u16,
    comment: *mut u16,
    last_written: FileTime,
    credential_blob_size: u32,
    credential_blob: *mut u8,
    persist: u32,
    attribute_count: u32,
    attributes: *mut c_void,
    target_alias: *mut u16,
    user_name: *mut u16,
}

#[link(name = "user32")]
unsafe extern "system" {
    fn MessageBoxW(window: isize, text: *const u16, caption: *const u16, kind: u32) -> i32;
}

#[link(name = "advapi32")]
unsafe extern "system" {
    fn CredWriteW(credential: *const CredentialW, flags: u32) -> i32;
    fn CredReadW(
        target: *const u16,
        credential_type: u32,
        flags: u32,
        credential: *mut *mut CredentialW,
    ) -> i32;
    fn CredDeleteW(target: *const u16, credential_type: u32, flags: u32) -> i32;
    fn CredFree(buffer: *mut c_void);
}

fn wide(value: &str) -> Vec<u16> {
    OsStr::new(value)
        .encode_wide()
        .chain(iter::once(0))
        .collect()
}

fn fail(message: &str) -> ! {
    let text = wide(message);
    let caption = wide("NemoClaw could not start");
    unsafe {
        MessageBoxW(0, text.as_ptr(), caption.as_ptr(), 0x10);
    }
    exit(1);
}

fn credential_target(provider: &str) -> Option<&'static str> {
    match provider {
        "nvidia" => Some("NVIDIA/NemoClaw/inference/nvidia"),
        "openrouter" => Some("NVIDIA/NemoClaw/inference/openrouter"),
        "compatible" => Some("NVIDIA/NemoClaw/inference/compatible"),
        "local" => Some("NVIDIA/NemoClaw/inference/local"),
        _ => None,
    }
}

fn credential_error(message: &str) -> ! {
    let _ = writeln!(std::io::stderr(), "{message}");
    exit(2);
}

fn credential_write(provider: &str) {
    let target = credential_target(provider)
        .unwrap_or_else(|| credential_error("The credential provider is invalid."));
    let mut secret = Vec::new();
    std::io::stdin()
        .take((MAX_CREDENTIAL_BYTES + 1) as u64)
        .read_to_end(&mut secret)
        .unwrap_or_else(|_| credential_error("The credential could not be read."));
    if secret.is_empty() || secret.len() > MAX_CREDENTIAL_BYTES || secret.contains(&0) {
        credential_error("The credential length is invalid.");
    }
    let mut target_wide = wide(target);
    let mut username = wide("NemoClaw inference");
    let credential = CredentialW {
        flags: 0,
        credential_type: CRED_TYPE_GENERIC,
        target_name: target_wide.as_mut_ptr(),
        comment: ptr::null_mut(),
        last_written: FileTime {
            low_date_time: 0,
            high_date_time: 0,
        },
        credential_blob_size: secret.len() as u32,
        credential_blob: secret.as_mut_ptr(),
        persist: CRED_PERSIST_LOCAL_MACHINE,
        attribute_count: 0,
        attributes: ptr::null_mut(),
        target_alias: ptr::null_mut(),
        user_name: username.as_mut_ptr(),
    };
    let written = unsafe { CredWriteW(&credential, 0) };
    secret.fill(0);
    if written == 0 {
        credential_error("Windows Credential Manager rejected the credential.");
    }
}

fn credential_read(provider: &str) {
    let target = credential_target(provider)
        .unwrap_or_else(|| credential_error("The credential provider is invalid."));
    let target_wide = wide(target);
    let mut credential = ptr::null_mut();
    let found = unsafe { CredReadW(target_wide.as_ptr(), CRED_TYPE_GENERIC, 0, &mut credential) };
    if found == 0 || credential.is_null() {
        credential_error("No credential is stored for this provider.");
    }
    let bytes = unsafe {
        let value = &*credential;
        std::slice::from_raw_parts(value.credential_blob, value.credential_blob_size as usize)
    };
    let write_result = std::io::stdout().write_all(bytes);
    unsafe { CredFree(credential.cast()) };
    if write_result.is_err() {
        credential_error("The credential could not be returned.");
    }
}

fn credential_delete(provider: &str) {
    let target = credential_target(provider)
        .unwrap_or_else(|| credential_error("The credential provider is invalid."));
    let target_wide = wide(target);
    let _ = unsafe { CredDeleteW(target_wide.as_ptr(), CRED_TYPE_GENERIC, 0) };
}

fn main() {
    let executable =
        env::current_exe().unwrap_or_else(|_| fail("The launcher path is unavailable."));
    let bin = executable
        .parent()
        .map(PathBuf::from)
        .unwrap_or_else(|| fail("The NemoClaw bin directory is unavailable."));
    let install = bin
        .parent()
        .map(PathBuf::from)
        .unwrap_or_else(|| fail("The NemoClaw installation directory is unavailable."));
    let node = bin.join("node.exe");
    let mut forwarded = env::args_os().skip(1).collect::<Vec<_>>();
    if forwarded
        .first()
        .is_some_and(|value| value == "--credential-write")
    {
        let provider = forwarded
            .get(1)
            .and_then(|value| value.to_str())
            .unwrap_or_else(|| credential_error("A credential provider is required."));
        credential_write(provider);
        return;
    }
    if forwarded
        .first()
        .is_some_and(|value| value == "--credential-read")
    {
        let provider = forwarded
            .get(1)
            .and_then(|value| value.to_str())
            .unwrap_or_else(|| credential_error("A credential provider is required."));
        credential_read(provider);
        return;
    }
    if forwarded
        .first()
        .is_some_and(|value| value == "--credential-delete")
    {
        let provider = forwarded
            .get(1)
            .and_then(|value| value.to_str())
            .unwrap_or_else(|| credential_error("A credential provider is required."));
        credential_delete(provider);
        return;
    }
    let new_console = forwarded.first().is_some_and(|value| value == "--console");
    if new_console {
        forwarded.remove(0);
    }
    let configured = forwarded.iter().any(|value| value == "--configured");
    let configured_nemocua = configured
        && forwarded
            .windows(2)
            .any(|values| values[0] == "--agent" && values[1] == "nemocua");
    let configured_openclaw = configured
        && forwarded
            .windows(2)
            .any(|values| values[0] == "--agent" && values[1] == "openclaw");
    let entry = install.join("qualification").join(if configured_nemocua {
        "run-installed-native-nemocua.mts"
    } else if configured_openclaw {
        "run-installed-native-web-ui.mts"
    } else if new_console {
        "run-installed-native-console-agent.mts"
    } else {
        "run-installed-native-web-ui.mts"
    });
    if !node.is_file() || !entry.is_file() {
        fail(
            "The installed NemoClaw runtime is incomplete. Run Repair from Apps > Installed apps.",
        );
    }
    let wait = forwarded.first().is_some_and(|value| value == "--wait");
    if wait {
        forwarded.remove(0);
    }
    let mut command = Command::new(node);
    command
        .arg("--experimental-strip-types")
        .arg("--no-warnings")
        .arg(entry)
        .args(forwarded)
        .current_dir(&install)
        .env("NEMOCLAW_NATIVE_INSTALL_ROOT", &install);
    command.creation_flags(if new_console {
        CREATE_NEW_CONSOLE
    } else if wait {
        CREATE_NO_WINDOW
    } else {
        CREATE_NO_WINDOW | DETACHED_PROCESS
    });

    if wait {
        let status = command
            .status()
            .unwrap_or_else(|_| fail("The installed NemoClaw runtime could not be started."));
        exit(status.code().unwrap_or(1));
    }
    command
        .spawn()
        .unwrap_or_else(|_| fail("The installed NemoClaw runtime could not be started."));
}
