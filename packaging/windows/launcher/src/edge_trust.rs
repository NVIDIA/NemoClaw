// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use std::ffi::{OsStr, c_void};
use std::iter;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::fs::MetadataExt;
use std::path::Path;
use std::ptr::{null, null_mut};

type RawHandle = *mut c_void;

#[repr(C)]
struct Guid {
    data1: u32,
    data2: u16,
    data3: u16,
    data4: [u8; 8],
}

#[repr(C)]
struct WintrustFileInfo {
    size: u32,
    path: *const u16,
    file: RawHandle,
    known_subject: *const Guid,
}

#[repr(C)]
struct WintrustData {
    size: u32,
    policy_callback: *mut c_void,
    sip_client: *mut c_void,
    ui_choice: u32,
    revocation_checks: u32,
    union_choice: u32,
    file: *mut WintrustFileInfo,
    state_action: u32,
    state_data: RawHandle,
    url_reference: *const u16,
    provider_flags: u32,
    ui_context: u32,
    signature_settings: *mut c_void,
}

#[repr(C)]
struct CryptProviderCert {
    size: u32,
    cert: *const c_void,
}

#[repr(C)]
#[derive(Clone, Copy)]
struct Translation {
    language: u16,
    code_page: u16,
}

#[repr(C)]
#[derive(Default)]
struct FileTime {
    low: u32,
    high: u32,
}

#[link(name = "wintrust")]
unsafe extern "system" {
    fn WinVerifyTrust(window: RawHandle, action: *const Guid, data: *mut WintrustData) -> i32;
}

#[link(name = "crypt32")]
unsafe extern "system" {
    fn CertGetNameStringW(
        cert: *const c_void,
        kind: u32,
        flags: u32,
        parameters: *mut c_void,
        output: *mut u16,
        length: u32,
    ) -> u32;
    fn CertGetCertificateContextProperty(
        cert: *const c_void,
        property: u32,
        output: *mut c_void,
        length: *mut u32,
    ) -> i32;
}

#[link(name = "version")]
unsafe extern "system" {
    fn GetFileVersionInfoSizeW(path: *const u16, handle: *mut u32) -> u32;
    fn GetFileVersionInfoW(path: *const u16, handle: u32, length: u32, output: *mut c_void) -> i32;
    fn VerQueryValueW(
        block: *const c_void,
        sub_block: *const u16,
        output: *mut *mut c_void,
        length: *mut u32,
    ) -> i32;
}

#[link(name = "kernel32")]
unsafe extern "system" {
    fn GetModuleHandleW(name: *const u16) -> RawHandle;
    fn GetProcAddress(module: RawHandle, name: *const u8) -> *mut c_void;
    fn OpenProcess(access: u32, inherit: i32, pid: u32) -> RawHandle;
    fn QueryFullProcessImageNameW(
        process: RawHandle,
        flags: u32,
        output: *mut u16,
        length: *mut u32,
    ) -> i32;
    fn GetProcessTimes(
        process: RawHandle,
        created: *mut FileTime,
        exited: *mut FileTime,
        kernel: *mut FileTime,
        user: *mut FileTime,
    ) -> i32;
    fn CloseHandle(handle: RawHandle) -> i32;
}

pub(crate) struct Identity {
    path: String,
    version: String,
    product_name: String,
    original_filename: String,
    reparse_point: bool,
    signer_subject: String,
    signer_thumbprint: String,
}

pub(crate) struct ProcessIdentity {
    pid: u32,
    path: String,
    creation_filetime: u64,
}

struct Handle(RawHandle);

impl Drop for Handle {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.0);
        }
    }
}

fn wide(value: &OsStr) -> Vec<u16> {
    value.encode_wide().chain(iter::once(0)).collect()
}

fn os_error() -> u32 {
    std::io::Error::last_os_error()
        .raw_os_error()
        .map_or(1, |value| value as u32)
}

fn json_string(value: &str) -> String {
    let mut output = String::with_capacity(value.len() + 2);
    output.push('"');
    for character in value.chars() {
        match character {
            '"' => output.push_str("\\\""),
            '\\' => output.push_str("\\\\"),
            '\u{08}' => output.push_str("\\b"),
            '\u{0c}' => output.push_str("\\f"),
            '\n' => output.push_str("\\n"),
            '\r' => output.push_str("\\r"),
            '\t' => output.push_str("\\t"),
            value if value < ' ' => output.push_str(&format!("\\u{:04x}", value as u32)),
            value => output.push(value),
        }
    }
    output.push('"');
    output
}

impl Identity {
    pub(crate) fn json(&self) -> String {
        format!(
            "{{\"schemaVersion\":1,\"path\":{},\"version\":{},\"productName\":{},\"originalFilename\":{},\"reparsePoint\":{},\"signatureStatus\":\"Valid\",\"signerSubject\":{},\"signerThumbprint\":{}}}",
            json_string(&self.path),
            json_string(&self.version),
            json_string(&self.product_name),
            json_string(&self.original_filename),
            self.reparse_point,
            json_string(&self.signer_subject),
            json_string(&self.signer_thumbprint),
        )
    }
}

impl ProcessIdentity {
    pub(crate) fn json(&self) -> String {
        format!(
            "{{\"schemaVersion\":1,\"pid\":{},\"path\":{},\"creationFiletime\":{}}}",
            self.pid,
            json_string(&self.path),
            json_string(&self.creation_filetime.to_string()),
        )
    }
}

fn version_string(block: &[u8], translation: Translation, name: &str) -> Option<String> {
    let query = format!(
        "\\StringFileInfo\\{:04x}{:04x}\\{name}",
        translation.language, translation.code_page
    );
    let query = wide(OsStr::new(&query));
    let mut value = null_mut();
    let mut length = 0;
    if unsafe {
        VerQueryValueW(
            block.as_ptr().cast(),
            query.as_ptr(),
            &mut value,
            &mut length,
        )
    } == 0
        || value.is_null()
        || !(2..=4096).contains(&length)
    {
        return None;
    }
    let text = unsafe { std::slice::from_raw_parts(value.cast::<u16>(), length as usize - 1) };
    String::from_utf16(text)
        .ok()
        .filter(|value| !value.is_empty())
}

fn version_metadata(path: &[u16]) -> Result<(String, String, String), u32> {
    let mut ignored = 0;
    let size = unsafe { GetFileVersionInfoSizeW(path.as_ptr(), &mut ignored) };
    if size == 0 {
        return Err(os_error());
    }
    if size > 16 * 1024 * 1024 {
        return Err(13);
    }
    let mut block = vec![0u8; size as usize];
    if unsafe { GetFileVersionInfoW(path.as_ptr(), 0, size, block.as_mut_ptr().cast()) } == 0 {
        return Err(os_error());
    }
    let query = wide(OsStr::new("\\VarFileInfo\\Translation"));
    let mut translations = null_mut();
    let mut length = 0;
    if unsafe {
        VerQueryValueW(
            block.as_ptr().cast(),
            query.as_ptr(),
            &mut translations,
            &mut length,
        )
    } == 0
        || translations.is_null()
        || length < std::mem::size_of::<Translation>() as u32
        || !(length as usize).is_multiple_of(std::mem::size_of::<Translation>())
    {
        return Err(13);
    }
    let count = length as usize / std::mem::size_of::<Translation>();
    for index in 0..count {
        let translation =
            unsafe { std::ptr::read_unaligned(translations.cast::<Translation>().add(index)) };
        if let (Some(version), Some(product), Some(original)) = (
            version_string(&block, translation, "FileVersion"),
            version_string(&block, translation, "ProductName"),
            version_string(&block, translation, "OriginalFilename"),
        ) {
            return Ok((version, product, original));
        }
    }
    Err(13)
}

fn signer_metadata(state: RawHandle) -> Result<(String, String), u32> {
    type FromState = unsafe extern "system" fn(RawHandle) -> *mut c_void;
    type GetSigner = unsafe extern "system" fn(*mut c_void, u32, i32, u32) -> *mut c_void;
    type GetCert = unsafe extern "system" fn(*mut c_void, u32) -> *mut CryptProviderCert;

    let module_name = wide(OsStr::new("wintrust.dll"));
    let module = unsafe { GetModuleHandleW(module_name.as_ptr()) };
    if module.is_null() {
        return Err(os_error());
    }
    let from_state =
        unsafe { GetProcAddress(module, c"WTHelperProvDataFromStateData".as_ptr().cast()) };
    let get_signer =
        unsafe { GetProcAddress(module, c"WTHelperGetProvSignerFromChain".as_ptr().cast()) };
    let get_cert =
        unsafe { GetProcAddress(module, c"WTHelperGetProvCertFromChain".as_ptr().cast()) };
    if from_state.is_null() || get_signer.is_null() || get_cert.is_null() {
        return Err(os_error());
    }
    let from_state: FromState = unsafe { std::mem::transmute(from_state) };
    let get_signer: GetSigner = unsafe { std::mem::transmute(get_signer) };
    let get_cert: GetCert = unsafe { std::mem::transmute(get_cert) };
    let provider = unsafe { from_state(state) };
    let signer = if provider.is_null() {
        null_mut()
    } else {
        unsafe { get_signer(provider, 0, 0, 0) }
    };
    let provider_cert = if signer.is_null() {
        null_mut()
    } else {
        unsafe { get_cert(signer, 0) }
    };
    let cert = if provider_cert.is_null() {
        null()
    } else {
        unsafe { (*provider_cert).cert }
    };
    if cert.is_null() {
        return Err(13);
    }

    const CERT_NAME_SIMPLE_DISPLAY_TYPE: u32 = 4;
    let name_length = unsafe {
        CertGetNameStringW(
            cert,
            CERT_NAME_SIMPLE_DISPLAY_TYPE,
            0,
            null_mut(),
            null_mut(),
            0,
        )
    };
    if !(2..=4096).contains(&name_length) {
        return Err(13);
    }
    let mut name = vec![0u16; name_length as usize];
    if unsafe {
        CertGetNameStringW(
            cert,
            CERT_NAME_SIMPLE_DISPLAY_TYPE,
            0,
            null_mut(),
            name.as_mut_ptr(),
            name_length,
        )
    } != name_length
    {
        return Err(os_error());
    }
    let name = String::from_utf16(&name[..name.len() - 1]).map_err(|_| 13u32)?;

    const CERT_SHA1_HASH_PROP_ID: u32 = 3;
    let mut thumbprint_length = 0;
    if unsafe {
        CertGetCertificateContextProperty(
            cert,
            CERT_SHA1_HASH_PROP_ID,
            null_mut(),
            &mut thumbprint_length,
        )
    } == 0
    {
        return Err(os_error());
    }
    if thumbprint_length != 20 {
        return Err(13);
    }
    let mut thumbprint = vec![0u8; thumbprint_length as usize];
    if unsafe {
        CertGetCertificateContextProperty(
            cert,
            CERT_SHA1_HASH_PROP_ID,
            thumbprint.as_mut_ptr().cast(),
            &mut thumbprint_length,
        )
    } == 0
    {
        return Err(os_error());
    }
    if thumbprint_length != 20 {
        return Err(13);
    }
    let thumbprint = thumbprint
        .iter()
        .map(|value| format!("{value:02X}"))
        .collect::<String>();
    Ok((name, thumbprint))
}

fn trusted_signer(path: &[u16]) -> Result<(String, String), u32> {
    const ACTION_GENERIC_VERIFY_V2: Guid = Guid {
        data1: 0x00aa_c56b,
        data2: 0xcd44,
        data3: 0x11d0,
        data4: [0x8c, 0xc2, 0x00, 0xc0, 0x4f, 0xc2, 0x95, 0xee],
    };
    const WTD_UI_NONE: u32 = 2;
    const WTD_CHOICE_FILE: u32 = 1;
    const WTD_STATEACTION_VERIFY: u32 = 1;
    const WTD_STATEACTION_CLOSE: u32 = 2;
    const WTD_REVOCATION_CHECK_NONE: u32 = 0x10;
    const WTD_CACHE_ONLY_URL_RETRIEVAL: u32 = 0x1000;

    let mut file = WintrustFileInfo {
        size: std::mem::size_of::<WintrustFileInfo>() as u32,
        path: path.as_ptr(),
        file: null_mut(),
        known_subject: null(),
    };
    let mut data = WintrustData {
        size: std::mem::size_of::<WintrustData>() as u32,
        policy_callback: null_mut(),
        sip_client: null_mut(),
        ui_choice: WTD_UI_NONE,
        revocation_checks: 0,
        union_choice: WTD_CHOICE_FILE,
        file: &mut file,
        state_action: WTD_STATEACTION_VERIFY,
        state_data: null_mut(),
        url_reference: null(),
        provider_flags: WTD_REVOCATION_CHECK_NONE | WTD_CACHE_ONLY_URL_RETRIEVAL,
        ui_context: 0,
        signature_settings: null_mut(),
    };
    let status = unsafe { WinVerifyTrust(null_mut(), &ACTION_GENERIC_VERIFY_V2, &mut data) };
    let result = if status == 0 {
        signer_metadata(data.state_data)
    } else {
        Err(status as u32)
    };
    data.state_action = WTD_STATEACTION_CLOSE;
    unsafe { WinVerifyTrust(null_mut(), &ACTION_GENERIC_VERIFY_V2, &mut data) };
    result
}

pub(crate) fn inspect(path: &Path) -> Result<Identity, u32> {
    if !path.is_absolute() {
        return Err(123);
    }
    let metadata = std::fs::symlink_metadata(path)
        .map_err(|error| error.raw_os_error().map_or(1, |value| value as u32))?;
    if !metadata.is_file() {
        return Err(13);
    }
    let path_wide = wide(path.as_os_str());
    let (signer_subject, signer_thumbprint) = trusted_signer(&path_wide)?;
    let (version, product_name, original_filename) = version_metadata(&path_wide)?;
    Ok(Identity {
        path: path.to_string_lossy().into_owned(),
        version,
        product_name,
        original_filename,
        reparse_point: metadata.file_attributes() & 0x400 != 0,
        signer_subject,
        signer_thumbprint,
    })
}

pub(crate) fn process(pid: u32) -> Result<ProcessIdentity, u32> {
    const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
    let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if process.is_null() {
        return Err(os_error());
    }
    let process = Handle(process);
    let mut image = vec![0u16; 32768];
    let mut image_length = image.len() as u32;
    if unsafe { QueryFullProcessImageNameW(process.0, 0, image.as_mut_ptr(), &mut image_length) }
        == 0
        || image_length == 0
        || image_length as usize > image.len()
    {
        return Err(os_error());
    }
    let mut created = FileTime::default();
    let mut exited = FileTime::default();
    let mut kernel = FileTime::default();
    let mut user = FileTime::default();
    if unsafe { GetProcessTimes(process.0, &mut created, &mut exited, &mut kernel, &mut user) } == 0
    {
        return Err(os_error());
    }
    Ok(ProcessIdentity {
        pid,
        path: String::from_utf16(&image[..image_length as usize]).map_err(|_| 13u32)?,
        creation_filetime: (u64::from(created.high) << 32) | u64::from(created.low),
    })
}

#[cfg(test)]
mod tests {
    use super::json_string;

    #[test]
    fn identity_output_escapes_json_control_characters() {
        assert_eq!(json_string("C:\\Edge\n\"x\""), "\"C:\\\\Edge\\n\\\"x\\\"\"");
    }
}
