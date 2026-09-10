// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]

#[cfg(not(feature = "immutable-runtime"))]
mod inference_job;
mod native_ui_file_owner;
#[cfg(any(feature = "immutable-runtime", all(windows, test)))]
mod runtime_host;
mod runtime_lease;
mod state_session;

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

fn credential_target(provider: &str, binding: Option<&str>) -> Option<String> {
    let base = match provider {
        "nvidia" => "NVIDIA/NemoClaw/inference/nvidia",
        "openrouter" => "NVIDIA/NemoClaw/inference/openrouter",
        "compatible" => "NVIDIA/NemoClaw/inference/compatible",
        "local" => "NVIDIA/NemoClaw/inference/local",
        "brave" => "NVIDIA/NemoClaw/services/brave",
        "tavily" => "NVIDIA/NemoClaw/services/tavily",
        "telegram" => "NVIDIA/NemoClaw/services/telegram",
        "discord" => "NVIDIA/NemoClaw/services/discord",
        "slack-bot" => "NVIDIA/NemoClaw/services/slack-bot",
        "slack-app" => "NVIDIA/NemoClaw/services/slack-app",
        _ => return None,
    };
    if binding.is_none()
        && matches!(
            provider,
            "brave" | "tavily" | "telegram" | "discord" | "slack-bot" | "slack-app"
        )
    {
        return None;
    }
    Some(match binding {
        Some(value) => format!("{base}/bound/{value}"),
        None => base.to_owned(),
    })
}

fn credential_binding(arguments: &[std::ffi::OsString]) -> Option<&str> {
    if arguments.len() == 2 {
        // The existing credential qualification fixture explicitly exercises the global helper.
        return None;
    }
    if arguments.len() != 4 || arguments[2] != "--binding" {
        credential_error("The credential binding arguments are invalid.");
    }
    let binding = arguments[3]
        .to_str()
        .unwrap_or_else(|| credential_error("The credential binding is invalid."));
    if binding.len() != 64
        || !binding
            .bytes()
            .all(|value| value.is_ascii_digit() || (b'a'..=b'f').contains(&value))
    {
        credential_error("The credential binding is invalid.");
    }
    Some(binding)
}

fn credential_error(message: &str) -> ! {
    let _ = writeln!(std::io::stderr(), "{message}");
    exit(2);
}

fn credential_write(provider: &str, binding: Option<&str>) {
    let target = credential_target(provider, binding)
        .unwrap_or_else(|| credential_error("The credential provider is invalid."));
    let mut secret = Vec::new();
    std::io::stdin()
        .take((MAX_CREDENTIAL_BYTES + 1) as u64)
        .read_to_end(&mut secret)
        .unwrap_or_else(|_| credential_error("The credential could not be read."));
    if secret.is_empty() || secret.len() > MAX_CREDENTIAL_BYTES || secret.contains(&0) {
        credential_error("The credential length is invalid.");
    }
    let mut target_wide = wide(&target);
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

fn credential_read(provider: &str, binding: Option<&str>) {
    let target = credential_target(provider, binding)
        .unwrap_or_else(|| credential_error("The credential provider is invalid."));
    let target_wide = wide(&target);
    let mut credential = ptr::null_mut();
    let found = unsafe { CredReadW(target_wide.as_ptr(), CRED_TYPE_GENERIC, 0, &mut credential) };
    if found == 0 || credential.is_null() {
        credential_error("No credential is stored for this provider.");
    }
    let valid = unsafe {
        let value = &*credential;
        value.credential_blob_size > 0
            && value.credential_blob_size as usize <= MAX_CREDENTIAL_BYTES
            && !value.credential_blob.is_null()
    };
    if !valid {
        unsafe { CredFree(credential.cast()) };
        credential_error("The stored credential length is invalid.");
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

fn credential_delete(provider: &str, binding: Option<&str>) {
    let target = credential_target(provider, binding)
        .unwrap_or_else(|| credential_error("The credential provider is invalid."));
    let target_wide = wide(&target);
    if unsafe { CredDeleteW(target_wide.as_ptr(), CRED_TYPE_GENERIC, 0) } == 0
        && std::io::Error::last_os_error().raw_os_error() != Some(1168)
    {
        credential_error("Windows Credential Manager could not delete the credential.");
    }
}

#[cfg(feature = "immutable-runtime")]
fn finish_runtime(code: i32, lease: runtime_lease::native::PackageLease) -> ! {
    let validation = lease.validate();
    drop(lease);
    if let Err(message) = validation {
        if code == 0 {
            credential_error(message);
        }
        let _ = writeln!(
            std::io::stderr(),
            "Runtime ownership verification also failed: {message}"
        );
    }
    exit(code)
}

fn main() {
    #[cfg(not(feature = "immutable-runtime"))]
    let executable =
        env::current_exe().unwrap_or_else(|_| fail("The launcher path is unavailable."));
    #[cfg(not(feature = "immutable-runtime"))]
    let bin = executable
        .parent()
        .map(PathBuf::from)
        .unwrap_or_else(|| fail("The NemoClaw bin directory is unavailable."));
    #[cfg(not(feature = "immutable-runtime"))]
    let install = bin
        .parent()
        .map(PathBuf::from)
        .unwrap_or_else(|| fail("The NemoClaw installation directory is unavailable."));
    #[cfg(feature = "immutable-runtime")]
    let install = PathBuf::from(
        runtime_lease::native::installed_path().unwrap_or_else(|message| credential_error(message)),
    );
    #[cfg(feature = "immutable-runtime")]
    let bin = install.join("bin");
    let node = bin.join("node.exe");
    let mut forwarded = env::args_os().skip(1).collect::<Vec<_>>();
    #[cfg(feature = "immutable-runtime")]
    let runtime_guardian = if forwarded
        .first()
        .is_some_and(|value| value == "--runtime-guardian")
    {
        forwarded.remove(0);
        true
    } else {
        false
    };
    #[cfg(feature = "immutable-runtime")]
    let original_arguments = forwarded.clone();
    if forwarded
        .first()
        .is_some_and(|value| value == "--runtime-capabilities")
    {
        if forwarded.len() != 1 {
            credential_error("The runtime capability query takes no extra arguments.");
        }
        let enabled = cfg!(feature = "immutable-runtime");
        println!(
            "{{\"schemaVersion\":1,\"kind\":\"native-runtime-capabilities\",\"immutableRuntime\":{enabled},\"guardianEnabled\":{enabled}}}"
        );
        return;
    }
    // Dormant helper API. Normal launch selection is not changed until the
    // installed read-only and MSI transaction qualifications have passed.
    if forwarded
        .first()
        .is_some_and(|value| value == "--runtime-current-descriptor")
    {
        if forwarded.len() != 1 {
            credential_error("The runtime descriptor query takes no extra arguments.");
        }
        if let Err(message) = runtime_lease::describe() {
            credential_error(&message);
        }
        return;
    }
    if forwarded
        .first()
        .is_some_and(|value| value == "--runtime-session")
    {
        if forwarded.len() != 2 {
            credential_error("A single runtime purpose is required.");
        }
        if let Err(message) = runtime_lease::run(forwarded[1].to_str().unwrap_or("")) {
            credential_error(&message);
        }
        return;
    }
    if forwarded
        .first()
        .is_some_and(|value| value == "--runtime-retire" || value == "--runtime-restore")
    {
        if forwarded.len() != 3 {
            credential_error("The immutable runtime identity is required.");
        }
        if let Err(message) = runtime_lease::transition(
            forwarded[1].to_str().unwrap_or(""),
            forwarded[2].to_str().unwrap_or(""),
            forwarded[0] == "--runtime-restore",
        ) {
            credential_error(&message);
        }
        return;
    }
    if forwarded
        .first()
        .is_some_and(|value| value == "--runtime-cli")
    {
        credential_error(
            "Direct host agent commands are unavailable. Use the contained NemoClaw launch.",
        );
    }
    #[cfg(feature = "immutable-runtime")]
    if forwarded
        .first()
        .is_some_and(|value| value == "--runtime-host")
    {
        if forwarded.len() < 2 {
            credential_error("The owned native runtime route is required.");
        }
        let route = forwarded
            .get(1)
            .and_then(|value| value.to_str())
            .unwrap_or("");
        let agent = forwarded[2..]
            .windows(2)
            .find(|values| values[0] == "--agent")
            .and_then(|values| values[1].to_str())
            .unwrap_or("pi");
        let (mode, purpose) = match route {
            "describe" if forwarded.len() == 2 => ("--describe-runtime", "host"),
            "turn" => ("turn", "openclaw"),
            "web" => ("web", "openclaw"),
            "nemocua" => ("nemocua", "nemocua"),
            "hermes-dashboard" => ("hermes-dashboard", "hermes"),
            "terminal-turn" if matches!(agent, "pi" | "hermes" | "langchain-deepagents-code") => {
                ("terminal-turn", agent)
            }
            _ => credential_error("The owned native runtime route is invalid."),
        };
        let lease = runtime_lease::native::PackageLease::acquire(purpose)
            .unwrap_or_else(|message| credential_error(message));
        let mut command = Command::new(
            PathBuf::from(lease.runtime_path())
                .join("app")
                .join("NemoClaw.Runtime.exe"),
        );
        command
            .arg(mode)
            .args(&forwarded[2..])
            .current_dir(&install)
            .env("NEMOCLAW_NATIVE_INSTALL_ROOT", &install)
            .env("NEMOCLAW_NATIVE_RUNTIME_ROOT", lease.runtime_path());
        let code = runtime_host::run_managed(
            command,
            CREATE_NO_WINDOW,
            lease.inherited_handle(),
            false,
            Some(&install),
            false,
        )
        .unwrap_or_else(|message| credential_error(message));
        finish_runtime(code, lease);
    }
    if forwarded
        .first()
        .is_some_and(|value| value == "--native-ui-file-owner")
    {
        if forwarded.len() != 2 {
            credential_error("A single native UI relay root is required.");
        }
        if let Err(message) = native_ui_file_owner::run(&forwarded[1]) {
            credential_error(&message);
        }
        return;
    }
    if forwarded
        .first()
        .is_some_and(|value| value == "--native-inference")
    {
        let action = forwarded
            .get(1)
            .and_then(|value| value.to_str())
            .unwrap_or("");
        let provisional = cfg!(feature = "immutable-runtime")
            && action == "serve"
            && forwarded.len() == 3
            && forwarded[2] == "--startup-owned";
        if (forwarded.len() != 2 && !provisional)
            || !matches!(
                action,
                "catalog" | "install" | "ensure-ready" | "stop" | "serve"
            )
        {
            credential_error("The native local inference action is invalid.");
        }
        #[cfg(feature = "immutable-runtime")]
        let lease = runtime_lease::native::PackageLease::acquire("inference")
            .unwrap_or_else(|message| credential_error(message));
        #[cfg(feature = "immutable-runtime")]
        let entry = PathBuf::from(lease.runtime_path())
            .join("app")
            .join("NemoClaw.Runtime.exe");
        #[cfg(not(feature = "immutable-runtime"))]
        let entry = install
            .join("qualification")
            .join("native-inference-cli.mts");
        if !node.is_file() || !entry.is_file() {
            credential_error(
                "The installed local inference runtime is incomplete. Run Repair from Installed apps.",
            );
        }
        #[cfg(feature = "immutable-runtime")]
        let mut command = Command::new(&entry);
        #[cfg(not(feature = "immutable-runtime"))]
        let mut command = Command::new(&node);
        #[cfg(feature = "immutable-runtime")]
        command
            .arg("inference")
            .arg(action)
            .env("NEMOCLAW_NATIVE_RUNTIME_ROOT", lease.runtime_path());
        #[cfg(not(feature = "immutable-runtime"))]
        command
            .args(["--experimental-strip-types", "--no-warnings"])
            .arg(entry)
            .arg(action);
        command
            .current_dir(&install)
            .env("NEMOCLAW_NATIVE_INSTALL_ROOT", &install)
            .creation_flags(CREATE_NO_WINDOW);
        #[cfg(feature = "immutable-runtime")]
        {
            if action == "serve" {
                command.arg("--owned-host");
            }
            let code = runtime_host::run_managed(
                command,
                CREATE_NO_WINDOW,
                lease.inherited_handle(),
                action == "serve",
                if action == "serve" {
                    None
                } else {
                    Some(&install)
                },
                provisional,
            )
            .unwrap_or_else(|message| credential_error(message));
            finish_runtime(code, lease);
        }
        #[cfg(not(feature = "immutable-runtime"))]
        if action == "serve" {
            command.arg("--owned-host");
            match inference_job::run(command) {
                Ok(code) => exit(code),
                Err(message) => credential_error(&message),
            }
        }
        #[cfg(not(feature = "immutable-runtime"))]
        {
            let status = command.status().unwrap_or_else(|_| {
                credential_error("The native local inference operation could not start.")
            });
            exit(status.code().unwrap_or(1));
        }
    }
    if forwarded
        .first()
        .is_some_and(|value| value == "--credential-write")
    {
        let provider = forwarded
            .get(1)
            .and_then(|value| value.to_str())
            .unwrap_or_else(|| credential_error("A credential provider is required."));
        credential_write(provider, credential_binding(&forwarded));
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
        credential_read(provider, credential_binding(&forwarded));
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
        credential_delete(provider, credential_binding(&forwarded));
        return;
    }
    if forwarded
        .first()
        .is_some_and(|value| value == "--state-session")
    {
        let agent = forwarded.get(1).and_then(|value| value.to_str());
        let result = if forwarded.len() == 2 {
            state_session::run(agent.unwrap_or(""))
        } else {
            Err("A single native state agent is required.".into())
        };
        if let Err(message) = result {
            let _ = writeln!(std::io::stderr(), "{message}");
            exit(2);
        }
        return;
    }
    if forwarded
        .first()
        .is_some_and(|value| value == "--state-remove")
    {
        let result = if forwarded.len() == 2 {
            state_session::remove(forwarded[1].to_str().unwrap_or(""))
        } else {
            Err("A single native state agent is required.".into())
        };
        if let Err(message) = result {
            credential_error(&message);
        }
        return;
    }
    let explicit_console = forwarded.first().is_some_and(|value| value == "--console");
    if explicit_console {
        forwarded.remove(0);
    }
    let configure_native = forwarded
        .first()
        .is_some_and(|value| value == "--configure-native" || value == "--remove-native-data");
    let native_turn = forwarded
        .first()
        .is_some_and(|value| value == "--native-turn");
    if native_turn {
        forwarded.remove(0);
    }
    let qualification = forwarded.iter().any(|value| value == "--qualification");
    let force_onboarding = forwarded
        .iter()
        .any(|value| value == "--onboard" || value == "--installer");
    if !qualification
        && !native_turn
        && !configure_native
        && !force_onboarding
        && !forwarded.iter().any(|value| value == "--configured")
    {
        if let Some(local_app_data) = env::var_os("LOCALAPPDATA") {
            let settings = PathBuf::from(local_app_data)
                .join("NVIDIA")
                .join("NemoClaw");
            let explicit_agent = forwarded
                .windows(2)
                .find(|values| values[0] == "--agent")
                .and_then(|values| values[1].to_str())
                .map(str::to_owned);
            let remembered = std::fs::File::open(settings.join("active-agent.txt"))
                .ok()
                .and_then(|file| {
                    let mut text = String::new();
                    file.take(65).read_to_string(&mut text).ok()?;
                    (text.len() <= 64).then(|| text.trim().to_owned())
                });
            if let Some(agent) = explicit_agent.clone().or(remembered) {
                if matches!(
                    agent.as_str(),
                    "openclaw" | "hermes" | "langchain-deepagents-code" | "pi" | "nemocua"
                ) {
                    if explicit_agent.is_none() {
                        forwarded.push("--agent".into());
                        forwarded.push(agent.clone().into());
                    }
                    if settings
                        .join("agents")
                        .join(agent)
                        .join("native-windows.json")
                        .is_file()
                    {
                        forwarded.push("--configured".into());
                    }
                }
            }
        }
    }
    let configured = forwarded.iter().any(|value| value == "--configured");
    if !configured && !qualification && !native_turn && !configure_native {
        let native_ui = install.join("native-ui").join("NemoClaw.Bootstrapper.exe");
        if !native_ui.is_file() {
            fail("The native NemoClaw interface is missing. Run Repair from Installed apps.");
        }
        let mut command = Command::new(native_ui);
        let installer = forwarded.iter().any(|value| value == "--installer");
        command
            .arg(if installer {
                "--installer"
            } else {
                "--onboard"
            })
            .current_dir(&install);
        if let Some(selection) = forwarded.windows(2).find(|values| values[0] == "--agent") {
            let agent = selection[1].to_str().unwrap_or("");
            if !matches!(
                agent,
                "openclaw" | "hermes" | "langchain-deepagents-code" | "pi" | "nemocua"
            ) {
                fail("The selected NemoClaw agent is invalid.");
            }
            command.arg("--agent").arg(agent);
        }
        let wait = forwarded.iter().any(|value| value == "--wait");
        command.creation_flags(if wait {
            CREATE_NO_WINDOW
        } else {
            CREATE_NO_WINDOW | DETACHED_PROCESS
        });
        if wait {
            let status = command
                .status()
                .unwrap_or_else(|_| fail("The native NemoClaw interface could not start."));
            exit(status.code().unwrap_or(1));
        }
        command
            .spawn()
            .unwrap_or_else(|_| fail("The native NemoClaw interface could not start."));
        return;
    }
    let configured_nemocua = configured
        && forwarded
            .windows(2)
            .any(|values| values[0] == "--agent" && values[1] == "nemocua");
    let configured_openclaw = configured
        && forwarded
            .windows(2)
            .any(|values| values[0] == "--agent" && values[1] == "openclaw");
    let configured_hermes_ui = configured
        && !explicit_console
        && forwarded
            .windows(2)
            .any(|values| values[0] == "--agent" && values[1] == "hermes");
    let configured_terminal = configured
        && forwarded.windows(2).any(|values| {
            values[0] == "--agent"
                && matches!(
                    values[1].to_str(),
                    Some("pi" | "hermes" | "langchain-deepagents-code")
                )
        });
    let new_console =
        explicit_console || (configured_terminal && !configured_hermes_ui) || configured_nemocua;
    #[cfg(feature = "immutable-runtime")]
    let mode = if native_turn {
        "turn"
    } else if configured_nemocua {
        "nemocua"
    } else if configured_hermes_ui {
        "hermes-dashboard"
    } else if configured_openclaw {
        "web"
    } else if new_console {
        "console"
    } else {
        "web"
    };
    #[cfg(feature = "immutable-runtime")]
    let purpose = forwarded
        .windows(2)
        .find(|values| values[0] == "--agent")
        .and_then(|values| values[1].to_str())
        .unwrap_or("host");
    #[cfg(feature = "immutable-runtime")]
    let lease = runtime_lease::native::PackageLease::acquire(purpose)
        .unwrap_or_else(|message| fail(message));
    #[cfg(feature = "immutable-runtime")]
    let entry = PathBuf::from(lease.runtime_path())
        .join("app")
        .join("NemoClaw.Runtime.exe");
    #[cfg(not(feature = "immutable-runtime"))]
    let entry = install.join("qualification").join(if native_turn {
        "run-installed-native-turn.mts"
    } else if configured_nemocua {
        "run-installed-native-nemocua.mts"
    } else if configured_hermes_ui {
        "run-installed-native-hermes-ui.mts"
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
    let explicit_wait = forwarded.iter().any(|value| value == "--wait");
    forwarded.retain(|value| value != "--wait");
    let wait = explicit_wait || configure_native || (configured && !new_console);
    #[cfg(feature = "immutable-runtime")]
    let mut command = Command::new(&entry);
    #[cfg(not(feature = "immutable-runtime"))]
    let mut command = Command::new(node);
    #[cfg(feature = "immutable-runtime")]
    command
        .arg(mode)
        .env("NEMOCLAW_NATIVE_RUNTIME_ROOT", lease.runtime_path());
    #[cfg(not(feature = "immutable-runtime"))]
    command
        .arg("--experimental-strip-types")
        .arg("--no-warnings")
        .arg(entry);
    command
        .args(&forwarded)
        .current_dir(&install)
        .env("NEMOCLAW_NATIVE_INSTALL_ROOT", &install);
    command.creation_flags(if new_console {
        CREATE_NEW_CONSOLE
    } else if wait {
        CREATE_NO_WINDOW
    } else {
        CREATE_NO_WINDOW | DETACHED_PROCESS
    });

    #[cfg(feature = "immutable-runtime")]
    {
        if !wait && !runtime_guardian {
            let mut guardian = Command::new(bin.join("NemoClaw.exe"));
            guardian
                .arg("--runtime-guardian")
                .args(&original_arguments)
                .current_dir(&install)
                .creation_flags(CREATE_NO_WINDOW | DETACHED_PROCESS);
            guardian
                .spawn()
                .unwrap_or_else(|_| fail("The private runtime guardian could not start."));
            return;
        }
        let code = runtime_host::run_managed(
            command,
            if new_console {
                CREATE_NEW_CONSOLE
            } else {
                CREATE_NO_WINDOW
            },
            lease.inherited_handle(),
            false,
            Some(&install),
            false,
        )
        .unwrap_or_else(|message| fail(message));
        finish_runtime(code, lease);
    }
    #[cfg(not(feature = "immutable-runtime"))]
    if wait {
        let status = command
            .status()
            .unwrap_or_else(|_| fail("The installed NemoClaw runtime could not be started."));
        if configured && !new_console && !status.success() {
            fail(
                "The agent could not open or finish cleanly. Open NemoClaw Setup to check its settings, or close an existing session and try again.",
            );
        }
        exit(status.code().unwrap_or(1));
    }
    #[cfg(not(feature = "immutable-runtime"))]
    command
        .spawn()
        .unwrap_or_else(|_| fail("The installed NemoClaw runtime could not be started."));
}
