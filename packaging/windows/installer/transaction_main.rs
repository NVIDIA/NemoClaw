// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]

#[cfg(any(windows, test))]
mod runtime_image_attachment;
#[path = "../launcher/src/runtime_lease.rs"]
mod runtime_lease;
mod runtime_manifest;
mod runtime_transaction;
#[cfg(windows)]
mod windows_runtime_store;
#[cfg(windows)]
mod windows_sha256;

#[cfg(windows)]
mod boot_service {
    use super::{runtime_transaction::RuntimeIdentity, windows_runtime_store::WindowsStore};
    use std::ffi::c_void;
    use std::ptr::null_mut;
    use std::sync::atomic::{AtomicPtr, AtomicU32, Ordering};
    use std::sync::{Mutex, OnceLock};

    const NAME: &str = "NemoClawRuntimeRestore";
    static EXPECTED: OnceLock<RuntimeIdentity> = OnceLock::new();
    static HANDLE: AtomicPtr<c_void> = AtomicPtr::new(null_mut());
    static EXIT: AtomicU32 = AtomicU32::new(1);
    static STATE: Mutex<(u32, u32)> = Mutex::new((2, 0));

    #[repr(C)]
    struct Status {
        kind: u32,
        state: u32,
        accepted: u32,
        win32_exit: u32,
        service_exit: u32,
        checkpoint: u32,
        wait_hint: u32,
    }
    #[repr(C)]
    struct Entry {
        name: *mut u16,
        main: Option<unsafe extern "system" fn(u32, *mut *mut u16)>,
    }
    #[link(name = "advapi32")]
    unsafe extern "system" {
        fn StartServiceCtrlDispatcherW(table: *const Entry) -> i32;
        fn RegisterServiceCtrlHandlerW(
            name: *const u16,
            handler: Option<unsafe extern "system" fn(u32)>,
        ) -> *mut c_void;
        fn SetServiceStatus(handle: *mut c_void, status: *const Status) -> i32;
    }

    fn status(update: Option<(u32, u32)>) -> bool {
        let Ok(mut current) = STATE.lock() else {
            return false;
        };
        // Serialize interrogations with completion: STOPPED must be reported
        // exactly once and must never be followed by a stale RUNNING status.
        if current.0 == 1 {
            return true;
        }
        if let Some(value) = update {
            *current = value;
        }
        let (state, exit) = *current;
        let value = Status {
            kind: 0x10,
            state,
            // One bounded restore operation; no requests or user-supplied work.
            accepted: 0,
            win32_exit: if exit == 0 { 0 } else { 1066 },
            service_exit: exit,
            checkpoint: u32::from(state == 2),
            wait_hint: if state == 2 { 30_000 } else { 0 },
        };
        unsafe { SetServiceStatus(HANDLE.load(Ordering::Acquire), &value) != 0 }
    }
    unsafe extern "system" fn control(code: u32) {
        if code == 4 {
            status(None);
        }
    }
    unsafe extern "system" fn service_main(_count: u32, _arguments: *mut *mut u16) {
        let name = NAME.encode_utf16().chain(Some(0)).collect::<Vec<_>>();
        let handle = unsafe { RegisterServiceCtrlHandlerW(name.as_ptr(), Some(control)) };
        if handle.is_null() {
            return;
        }
        HANDLE.store(handle, Ordering::Release);
        if !status(Some((2, 0))) || !status(Some((4, 0))) {
            status(Some((1, 1)));
            return;
        }
        let result = EXPECTED
            .get()
            .ok_or(super::runtime_transaction::Error::Identity)
            .and_then(|expected| WindowsStore::new().restore_on_boot(expected));
        let code = match result {
            Ok(()) => 0,
            Err(error) => super::failure_exit_code(&format!("{error:?}")) as u32,
        };
        EXIT.store(code, Ordering::Release);
        if !status(Some((1, code))) {
            EXIT.store(1, Ordering::Release);
        }
    }

    pub fn run(expected: RuntimeIdentity) -> Result<(), String> {
        expected.validate().map_err(|error| format!("{error:?}"))?;
        EXPECTED
            .set(expected)
            .map_err(|_| "Runtime restore was already initialized.")?;
        let mut name = NAME.encode_utf16().chain(Some(0)).collect::<Vec<_>>();
        let table = [
            Entry {
                name: name.as_mut_ptr(),
                main: Some(service_main),
            },
            Entry {
                name: null_mut(),
                main: None,
            },
        ];
        // No image operation occurs unless the Windows SCM invokes service_main.
        if unsafe { StartServiceCtrlDispatcherW(table.as_ptr()) } == 0 {
            return Err("Runtime restore requires the installed Windows service.".into());
        }
        if EXIT.load(Ordering::Acquire) != 0 {
            return Err("The installed runtime could not be restored at startup.".into());
        }
        Ok(())
    }
}

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
    const TIMINGS: [&str; 4] = [
        "RuntimeImageHashMilliseconds",
        "RuntimeImageAttachMilliseconds",
        "RuntimeImageMountMilliseconds",
        "RuntimeNodeHashMilliseconds",
    ];

    pub(super) struct Timing {
        name: &'static str,
        started: std::time::Instant,
    }

    impl Timing {
        pub(super) fn start(name: &'static str) -> Self {
            Self {
                name,
                started: std::time::Instant::now(),
            }
        }
    }

    impl Drop for Timing {
        fn drop(&mut self) {
            let saved = unsafe { GetLastError() };
            let elapsed = self.started.elapsed().as_millis();
            if TIMINGS.contains(&self.name) {
                if let Some(key) = key() {
                    let data = wide(&elapsed.to_string());
                    unsafe {
                        RegSetValueExW(
                            key,
                            wide(self.name).as_ptr(),
                            0,
                            REG_SZ,
                            data.as_ptr().cast(),
                            (data.len() * 2) as u32,
                        );
                        RegCloseKey(key);
                    }
                }
            }
            unsafe { SetLastError(saved) };
        }
    }

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetLastError() -> u32;
        fn SetLastError(error: u32);
    }

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
                for name in TIMINGS {
                    RegDeleteValueW(key, wide(name).as_ptr());
                }
                RegCloseKey(key);
            }
        }
    }
    pub(super) fn record(stage: &str, error: &str, exit_code: i32, native_status: u32) {
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
            let data = wide(&format!(
                "stage={stage}; error={error}; exitCode={exit_code}; nativeStatus={native_status}"
            ));
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
        "Native(\"runtime-image-open\")" => 117,
        "Native(\"runtime-image-host-compression\")" => 118,
        "Native(\"runtime-image-attach\")" => 119,
        "Native(\"runtime-image-privilege\")" => 121,
        "Native(\"runtime-image-mount-open\")"
        | "Native(\"runtime-image-mount-kind\")"
        | "Native(\"runtime-image-mount-descriptor\")"
        | "Native(\"runtime-image-mount-descriptor-dacl\")"
        | "Native(\"runtime-image-mount-permissions\")" => 122,
        "Native(\"runtime-image-mount-cleanup\")" => 123,
        _ => 120,
    }
}

#[cfg(any(windows, test))]
fn bundle_transaction<S: runtime_transaction::NativeStore>(
    store: &mut S,
    arguments: &[String],
) -> Result<(), String> {
    const OWNER: &str = "{1BA739B8-B632-4A8C-BB02-95058CC3A960}";
    let Some(action) = arguments.first().map(String::as_str) else {
        return Err("The native bundle transaction command is invalid.".into());
    };
    if action == "noop" && arguments.len() == 1 {
        return Ok(());
    }
    let (commands, rollback_begin_failure) = match (action, &arguments[1..]) {
        // The nested old MSI receives the new MSI ProductCode, not Burn's
        // UpgradeCode. Bind the journal to that compiled product identity.
        ("begin-install", fields) if fields.len() == 6 => (
            vec![[vec!["begin-install".into()], fields.to_vec()].concat()],
            true,
        ),
        ("complete-install", fields) if fields.len() == 5 => (
            vec![
                [vec!["verify".into()], fields.to_vec()].concat(),
                vec!["commit-install".into(), fields[0].clone()],
            ],
            false,
        ),
        ("begin-remove", fields) if fields.len() == 1 => (
            vec![vec!["begin-remove".into(), fields[0].clone(), OWNER.into()]],
            true,
        ),
        ("complete-remove", fields) if fields.len() == 1 => {
            (vec![vec!["commit-remove".into(), fields[0].clone()]], false)
        }
        ("rollback", fields) if fields.len() == 1 => {
            (vec![vec!["rollback".into(), fields[0].clone()]], false)
        }
        _ => return Err("The native bundle transaction command is invalid.".into()),
    };
    for command in commands {
        if let Err(error) = runtime_transaction::dispatch(store, &command) {
            let primary = format!("{error:?}");
            // A failed begin is not considered executed by Burn, so undo any
            // journal it created here. Completion failures deliberately leave
            // the journal for Burn to roll MSI back before invoking rollback.
            if rollback_begin_failure {
                let _ = runtime_transaction::dispatch(
                    store,
                    &[
                        "rollback".into(),
                        arguments.get(1).cloned().unwrap_or_default(),
                    ],
                );
            }
            return Err(primary);
        }
    }
    Ok(())
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
        if matches!(args.as_slice(), ["--runtime-bundle", "begin-install", ..]) {
            diagnostics::clear();
        }
        // The same exact native lease entrypoints let Windows integration tests
        // hold real package/version/Node leases against the embedded helper.
        let result = match args.as_slice() {
            [
                "--runtime-boot-service",
                runtime_id,
                manifest_sha256,
                source_revision,
                node_sha256,
                node_version,
            ] => boot_service::run(runtime_transaction::RuntimeIdentity {
                runtime_id: (*runtime_id).into(),
                manifest_sha256: (*manifest_sha256).into(),
                source_revision: (*source_revision).into(),
                node_sha256: (*node_sha256).into(),
                node_version: (*node_version).into(),
            }),
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
            ["--runtime-bundle", ..] => bundle_transaction(
                &mut windows_runtime_store::WindowsStore::new(),
                &arguments[1..],
            ),
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
            if matches!(args.first(), Some(value) if matches!(*value, "--runtime-msi" | "--runtime-bundle"))
            {
                let stage = match args.get(1).copied() {
                    Some(
                        "begin-install" | "complete-install" | "begin-remove" | "complete-remove"
                        | "join-remove" | "verify" | "commit-install" | "commit-remove"
                        | "rollback" | "install" | "repair" | "remove" | "cleanup",
                    ) => args[1],
                    _ => "invalid",
                };
                diagnostics::record(
                    stage,
                    &error,
                    exit_code,
                    windows_runtime_store::diagnostic_status(),
                );
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
        assert_eq!(
            failure_exit_code("Native(\"runtime-image-mount-cleanup\")"),
            123
        );
        assert_eq!(
            failure_exit_code("Native(\"runtime-image-mount-permissions\")"),
            122
        );
        assert_eq!(failure_exit_code("Native(\"other\")"), 120);
    }

    #[test]
    fn bundle_authoring_spans_msi_with_one_transaction() {
        let source = include_str!("../Bundle.wxs");
        let begin = source.find("NemoClawRuntimeTransactionBegin").unwrap();
        let msi = source.find("<MsiPackage Id=\"NemoClawArm64Msi\"").unwrap();
        let complete = source.find("NemoClawRuntimeTransactionComplete").unwrap();
        let remove_begin = source.find("NemoClawRuntimeRemovalBegin").unwrap();
        let remove_commit = source.find("NemoClawRuntimeRemovalCommit").unwrap();
        assert!(remove_commit < begin && begin < msi && msi < complete && complete < remove_begin);
        assert_eq!(
            source.matches("--runtime-bundle begin-install $(var.RuntimeTuple) &quot;$(var.RuntimeProductCode)&quot;").count(),
            2
        );
        assert!(source.contains("--runtime-bundle complete-install $(var.RuntimeTuple)"));
        assert!(source.contains("--runtime-bundle begin-remove $(var.RuntimeId)"));
        assert!(source.contains("--runtime-bundle complete-remove $(var.RuntimeId)"));
        assert_eq!(
            source
                .matches("--runtime-bundle rollback $(var.RuntimeId)")
                .count(),
            4
        );
    }
}
