// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]

#[cfg(not(target_os = "windows"))]
compile_error!("The NemoClaw launcher is Windows-only.");

use std::env;
use std::ffi::OsStr;
use std::iter;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::process::CommandExt;
use std::path::PathBuf;
use std::process::{Command, exit};

const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const DETACHED_PROCESS: u32 = 0x0000_0008;

#[link(name = "user32")]
unsafe extern "system" {
    fn MessageBoxW(window: isize, text: *const u16, caption: *const u16, kind: u32) -> i32;
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
    let entry = install
        .join("qualification")
        .join("run-installed-native-web-ui.mts");
    if !node.is_file() || !entry.is_file() {
        fail(
            "The installed NemoClaw runtime is incomplete. Run Repair from Apps > Installed apps.",
        );
    }

    let mut forwarded = env::args_os().skip(1).collect::<Vec<_>>();
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
        .current_dir(install)
        .env("NEMOCLAW_NATIVE_INSTALL_ROOT", install);
    command.creation_flags(if wait {
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
