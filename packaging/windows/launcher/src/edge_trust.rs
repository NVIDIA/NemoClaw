// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use std::ffi::{OsStr, c_void};
use std::iter;
use std::os::windows::ffi::OsStrExt;
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

#[link(name = "wintrust")]
unsafe extern "system" {
    fn WinVerifyTrust(window: RawHandle, action: *const Guid, data: *mut WintrustData) -> i32;
}

pub(crate) fn verify(path: &Path) -> Result<(), u32> {
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

    if !path.is_absolute() {
        return Err(123);
    }
    let wide = OsStr::new(path.as_os_str())
        .encode_wide()
        .chain(iter::once(0))
        .collect::<Vec<_>>();
    let mut file = WintrustFileInfo {
        size: std::mem::size_of::<WintrustFileInfo>() as u32,
        path: wide.as_ptr(),
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
    data.state_action = WTD_STATEACTION_CLOSE;
    unsafe { WinVerifyTrust(null_mut(), &ACTION_GENERIC_VERIFY_V2, &mut data) };
    if status != 0 {
        return Err(status as u32);
    }
    Ok(())
}
