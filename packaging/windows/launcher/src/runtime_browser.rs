// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Fixed dashboard activation in the guardian, outside its private runtime job.
//! No command, executable, browser argument, file path or non-loopback URL API.
use super::{Handle, RawHandle, wide};
use std::ffi::{OsStr, c_void};
use std::io::{Read, Write};
use std::ptr::{null, null_mut};

#[repr(C)]
struct ShellExecuteInfo {
    size: u32,
    mask: u32,
    window: RawHandle,
    verb: *const u16,
    file: *const u16,
    parameters: *const u16,
    directory: *const u16,
    show: i32,
    instance: RawHandle,
    id_list: *mut c_void,
    class: *const u16,
    class_key: RawHandle,
    hot_key: u32,
    icon_or_monitor: RawHandle,
    process: RawHandle,
}
#[link(name = "shell32")]
unsafe extern "system" {
    fn ShellExecuteExW(info: *mut ShellExecuteInfo) -> i32;
}
#[link(name = "ole32")]
unsafe extern "system" {
    fn CoInitializeEx(reserved: *mut c_void, flags: u32) -> i32;
    fn CoUninitialize();
}
struct Apartment;
impl Apartment {
    fn new() -> Result<Self, &'static str> {
        // COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE, on the dedicated worker.
        if unsafe { CoInitializeEx(null_mut(), 2 | 4) } < 0 {
            return Err("runtime-browser-apartment");
        }
        Ok(Self)
    }
}
impl Drop for Apartment {
    fn drop(&mut self) {
        unsafe { CoUninitialize() };
    }
}

pub(super) fn valid_origin(value: &str) -> bool {
    let Some(port) = value.strip_prefix("http://127.0.0.1:") else {
        return false;
    };
    !port.is_empty()
        && port.len() <= 5
        && !port.starts_with('0')
        && port.bytes().all(|byte| byte.is_ascii_digit())
        && port.parse::<u16>().is_ok_and(|port| port != 0)
}
fn read_line(file: &mut std::fs::File) -> Result<String, &'static str> {
    let mut bytes = Vec::new();
    for _ in 0..64 {
        let mut byte = [0u8];
        if file
            .read(&mut byte)
            .map_err(|_| "runtime-service-channel")?
            != 1
        {
            return Err("runtime-service-channel");
        }
        if byte[0] == b'\n' {
            return String::from_utf8(bytes).map_err(|_| "runtime-browser-request");
        }
        if !byte[0].is_ascii() || byte[0].is_ascii_control() {
            return Err("runtime-browser-request");
        }
        bytes.push(byte[0]);
    }
    Err("runtime-browser-request")
}
fn reply(file: &mut std::fs::File, value: &[u8]) -> Result<(), &'static str> {
    file.write_all(value).map_err(|_| "runtime-service-channel")
}

// The creator is the guardian. Shell activation cannot inherit the runtime job
// from this process; the job remains private and never permits breakaway.
fn activate(origin: &str, runtime_job: RawHandle) -> Result<(), &'static str> {
    if !valid_origin(origin) {
        return Err("runtime-browser-address");
    }
    let mut in_job = 0;
    if unsafe { super::IsProcessInJob(super::GetCurrentProcess(), runtime_job, &mut in_job) } == 0
        || in_job != 0
    {
        return Err("runtime-browser-owner-job");
    }
    let address = wide(OsStr::new(origin))?;
    let verb = wide(OsStr::new("open"))?;
    let mut info = ShellExecuteInfo {
        size: std::mem::size_of::<ShellExecuteInfo>() as u32,
        // NOCLOSEPROCESS | NOASYNC | FLAG_NO_UI. No executable arguments or env expansion.
        mask: 0x40 | 0x100 | 0x400,
        window: null_mut(),
        verb: verb.as_ptr(),
        file: address.as_ptr(),
        parameters: null(),
        directory: null(),
        show: 1,
        instance: null_mut(),
        id_list: null_mut(),
        class: null(),
        class_key: null_mut(),
        hot_key: 0,
        icon_or_monitor: null_mut(),
        process: null_mut(),
    };
    if unsafe { ShellExecuteExW(&mut info) } == 0 {
        return Err("runtime-browser-activation");
    }
    if !info.process.is_null() {
        let browser = Handle(info.process);
        if unsafe { super::IsProcessInJob(browser.0, runtime_job, &mut in_job) } == 0 || in_job != 0
        {
            return Err("runtime-browser-result-job");
        }
        // The test retains this exact handle only to prove survival after job close.
        #[cfg(test)]
        if std::env::var("NEMOCLAW_BROWSER_PROOF").as_deref() == Ok("1") {
            *PROOF.lock().map_err(|_| "runtime-browser-proof-lock")? =
                Some(BrowserProof { process: browser });
        }
        // Production closes only the observation handle. Windows owns browsers.
    }
    Ok(())
}

pub(super) fn serve(
    mut file: std::fs::File,
    live: impl Fn() -> bool,
    runtime_job: RawHandle,
) -> Result<(), &'static str> {
    let _apartment = Apartment::new()?;
    let bind = read_line(&mut file)?;
    let origin = bind
        .strip_prefix("bind ")
        .ok_or("runtime-browser-request")?;
    if !valid_origin(origin) || !live() {
        return Err("runtime-browser-address");
    }
    reply(&mut file, b"bound\n")?;
    for _ in 0..128 {
        let action = read_line(&mut file)?;
        if !live() {
            return Ok(());
        }
        match action.as_str() {
            "open" => {
                let result = activate(origin, runtime_job);
                reply(
                    &mut file,
                    if result.is_ok() {
                        b"opened\n"
                    } else {
                        b"failed\n"
                    },
                )?;
            }
            "close" => {
                reply(&mut file, b"closed\n")?;
                return Ok(());
            }
            _ => return Err("runtime-browser-request"),
        }
    }
    Err("runtime-browser-request-limit")
}

#[cfg(test)]
pub(super) struct BrowserProof {
    pub process: Handle,
}
#[cfg(test)]
unsafe impl Send for BrowserProof {}
#[cfg(test)]
pub(super) static PROOF: std::sync::Mutex<Option<BrowserProof>> = std::sync::Mutex::new(None);

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_canonical_numeric_loopback_origins_are_admitted() {
        assert!(valid_origin("http://127.0.0.1:65535"));
        for value in [
            "http://127.0.0.1:0",
            "http://127.0.0.1:080",
            "http://127.0.0.1:65536",
            "http://127.0.0.1:80/",
            "http://localhost:80",
            "https://127.0.0.1:80",
            "http://127.0.0.1:80/path",
            "http://127.0.0.1:80#token",
            "http://127.0.0.1:80?command=x",
            "http://127.0.0.1:80\\x",
            "file:///x",
            "ms-settings:",
            "http://user@127.0.0.1:80",
            "http://127.0.0.1:80\nopen",
        ] {
            assert!(!valid_origin(value), "{value}");
        }
    }
}
