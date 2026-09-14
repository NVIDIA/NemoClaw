// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

#[path = "../launcher/src/runtime_lease.rs"]
mod runtime_lease;
mod runtime_manifest;
mod runtime_transaction;
#[cfg(windows)]
mod windows_runtime_store;
#[cfg(windows)]
mod windows_sha256;

#[cfg(windows)]
mod diagnostics {
    use std::ffi::c_void;
    use std::ptr::{null, null_mut};

    type Hkey = *mut c_void;
    const LOCAL_MACHINE: Hkey = 0x8000_0002usize as Hkey;
    const KEY_SET_VALUE: u32 = 0x0002;
    const KEY_QUERY_VALUE: u32 = 0x0001;
    const KEY_WOW64_64KEY: u32 = 0x0100;
    const REG_SZ: u32 = 1;
    const ERROR_FILE_NOT_FOUND: i32 = 2;
    const PATH: &str = "SOFTWARE\\NVIDIA\\NemoClaw\\InstallDiagnostics";
    const VALUE: &str = "RuntimeMaintenancePrimary";

    #[link(name = "advapi32")]
    unsafe extern "system" {
        fn RegCreateKeyExW(
            key: Hkey,
            subkey: *const u16,
            reserved: u32,
            class: *mut u16,
            options: u32,
            access: u32,
            security: *const c_void,
            result: *mut Hkey,
            disposition: *mut u32,
        ) -> i32;
        fn RegQueryValueExW(
            key: Hkey,
            name: *const u16,
            reserved: *mut u32,
            kind: *mut u32,
            data: *mut u8,
            size: *mut u32,
        ) -> i32;
        fn RegSetValueExW(
            key: Hkey,
            name: *const u16,
            reserved: u32,
            kind: u32,
            data: *const u8,
            size: u32,
        ) -> i32;
        fn RegDeleteValueW(key: Hkey, name: *const u16) -> i32;
        fn RegCloseKey(key: Hkey) -> i32;
    }

    fn wide(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(std::iter::once(0)).collect()
    }
    fn key() -> Option<Hkey> {
        let mut key = null_mut();
        let status = unsafe {
            RegCreateKeyExW(
                LOCAL_MACHINE,
                wide(PATH).as_ptr(),
                0,
                null_mut(),
                0,
                KEY_SET_VALUE | KEY_QUERY_VALUE | KEY_WOW64_64KEY,
                null(),
                &mut key,
                null_mut(),
            )
        };
        (status == 0 && !key.is_null()).then_some(key)
    }
    pub(super) fn clear() {
        if let Some(key) = key() {
            unsafe {
                RegDeleteValueW(key, wide(VALUE).as_ptr());
                RegCloseKey(key);
            }
        }
    }
    pub(super) fn record(stage: &str, error: &str, exit_code: i32) {
        let Some(key) = key() else { return };
        let name = wide(VALUE);
        let mut size = 0;
        let existing = unsafe {
            RegQueryValueExW(
                key,
                name.as_ptr(),
                null_mut(),
                null_mut(),
                null_mut(),
                &mut size,
            )
        };
        if existing == ERROR_FILE_NOT_FOUND {
            let data = wide(&format!("stage={stage}; error={error}; exitCode={exit_code}"));
            unsafe {
                RegSetValueExW(
                    key,
                    name.as_ptr(),
                    0,
                    REG_SZ,
                    data.as_ptr().cast(),
                    (data.len() * 2) as u32,
                );
            }
        }
        unsafe { RegCloseKey(key) };
    }
}

fn failure_exit_code(error: &str) -> i32 {
    match error {
        "Identity" => 81,
        "NoTransaction" => 82,
        "ForeignTransaction" => 83,
        "LegacyRequiresStopFirst" => 84,
        "Busy" => 85,
        "Native(\"runtime-image-system-root\")" => 111,
        "Native(\"runtime-image-script\")" => 112,
        "Native(\"runtime-image-diskpart\")" => 113,
        "Native(\"runtime-image-script-cleanup\")" => 114,
        "Native(\"runtime-image-mount\")" => 115,
        "Native(\"runtime-image-detach\")" => 116,
        _ => 120,
    }
}

fn main() {
    #[cfg(not(windows))]
    {
        eprintln!("The native MSI transaction helper requires Windows.");
        std::process::exit(1);
    }
    #[cfg(windows)]
    {
        let arguments = std::env::args().skip(1).collect::<Vec<_>>();
        #[cfg(feature = "msi-boundary-fixture")]
        if arguments == ["--fixture-identify"] {
            println!("NEMOCLAW_MSI_FIXTURE_COMMIT_FAILURE_V1");
            return;
        }
        #[cfg(feature = "msi-boundary-fixture")]
        let (arguments, fail_before_admission) = {
            let mut arguments = arguments;
            let selected = arguments
                .last()
                .is_some_and(|value| value == "--fixture-fail-before-admission");
            if selected {
                arguments.pop();
            }
            (arguments, selected)
        };
        let args = arguments.iter().map(String::as_str).collect::<Vec<_>>();
        if matches!(args.as_slice(), ["--runtime-msi", "begin-install", ..]) {
            diagnostics::clear();
        }
        // The same exact native lease entrypoints let Windows integration tests
        // hold real package/version/Node leases against the embedded helper.
        let result = match args.as_slice() {
            ["--runtime-session", agent] => runtime_lease::run(agent),
            ["--runtime-current-descriptor"] => runtime_lease::describe(),
            ["--runtime-retire", id, digest] => runtime_lease::transition(id, digest, false),
            ["--runtime-restore", id, digest] => runtime_lease::transition(id, digest, true),
            ["--runtime-msi", ..] => {
                let mut store = windows_runtime_store::WindowsStore::new();
                #[cfg(feature = "msi-boundary-fixture")]
                {
                    store.fail_before_admission = fail_before_admission;
                }
                runtime_transaction::dispatch(&mut store, &arguments[1..])
                    .map_err(|error| format!("{error:?}"))
            }
            _ => Err("The native MSI transaction command is invalid.".into()),
        };
        if let Err(error) = result {
            eprintln!("NemoClaw runtime maintenance failed: {error}");
            #[cfg(feature = "msi-boundary-fixture")]
            if error == "Native(\"fixture-before-admission\")" {
                std::process::exit(47);
            }
            // Windows Installer retains the actual custom-action exit code even
            // when Burn cannot preserve a child process's stderr. Keep these
            // codes stable so an early image attach/verification failure remains
            // attributable in the installed acceptance evidence.
            let exit_code = failure_exit_code(&error);
            if matches!(args.first(), Some(value) if *value == "--runtime-msi") {
                let stage = match args.get(1).copied() {
                    Some("begin-install" | "begin-remove" | "join-remove" | "verify"
                        | "commit-install" | "commit-remove" | "rollback") => args[1],
                    _ => "invalid",
                };
                diagnostics::record(stage, &error, exit_code);
            }
            std::process::exit(exit_code);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::failure_exit_code;

    #[test]
    fn image_failures_have_stable_distinct_codes() {
        assert_eq!(failure_exit_code("Native(\"runtime-image-diskpart\")"), 113);
        assert_eq!(failure_exit_code("Native(\"runtime-image-mount\")"), 115);
        assert_eq!(failure_exit_code("Native(\"runtime-image-detach\")"), 116);
        assert_eq!(failure_exit_code("Native(\"other\")"), 120);
    }
}
