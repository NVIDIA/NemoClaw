// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::*;
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, Write};
use std::os::windows::fs::OpenOptionsExt;
use std::os::windows::io::AsRawHandle;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

static NEXT: AtomicU64 = AtomicU64::new(0);
const FIXTURE: &str = "runtime_host::tests::owned_process_fixture";

struct Fixture {
    root: PathBuf,
    lease: File,
}
impl Fixture {
    fn new() -> Self {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "NemoClawGuardian-{}-{nonce:x}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        let marker = root.join("lease");
        fs::write(&marker, b"fixed test lease").unwrap();
        let lease = OpenOptions::new()
            .read(true)
            .share_mode(1)
            .open(marker)
            .unwrap();
        Self { root, lease }
    }
    fn command(&self, mode: &str) -> Command {
        let mut command = Command::new(std::env::current_exe().unwrap());
        command
            .args(["--exact", FIXTURE, "--nocapture"])
            .env("NEMOCLAW_GUARDIAN_TEST_MODE", mode)
            .env("NEMOCLAW_GUARDIAN_TEST_ROOT", &self.root)
            .current_dir(&self.root);
        command
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        // This fixture's handle still exists during Drop; remove only test data.
        for name in [
            "events",
            "child-pid",
            "grandchild-pid",
            "release",
            "arguments",
        ] {
            let _ = fs::remove_file(self.root.join(name));
        }
    }
}
fn finish(fixture: Fixture) {
    let root = fixture.root.clone();
    drop(fixture);
    fs::remove_dir_all(root).unwrap();
}
fn event(root: &Path, text: &str) {
    let mut file = OpenOptions::new()
        .append(true)
        .create(true)
        .open(root.join("events"))
        .unwrap();
    writeln!(file, "{text}").unwrap();
    file.sync_all().unwrap();
}
fn wait_for(path: &Path) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while !path.exists() {
        assert!(
            Instant::now() < deadline,
            "owned fixture did not publish {}",
            path.display()
        );
        std::thread::sleep(Duration::from_millis(10));
    }
}

// The test executable is the actual owned child/grandchild. Invoking this case
// without its private mode is only the fixture entry, not an OS-control claim.
#[test]
fn owned_process_fixture() {
    let Ok(mode) = std::env::var("NEMOCLAW_GUARDIAN_TEST_MODE") else {
        return;
    };
    let root = PathBuf::from(std::env::var_os("NEMOCLAW_GUARDIAN_TEST_ROOT").unwrap());
    match mode.as_str() {
        "exit23" => std::process::exit(23),
        "stdin" => {
            let mut line = String::new();
            std::io::stdin().lock().read_line(&mut line).unwrap();
            assert_eq!(line, "start\n");
            event(&root, "handshake-received");
        }
        "parent" | "orphan-parent" => {
            event(&root, "parent-started");
            let mut command = Command::new(std::env::current_exe().unwrap());
            command
                .args(["--exact", FIXTURE, "--nocapture"])
                .env("NEMOCLAW_GUARDIAN_TEST_MODE", "grandchild")
                .current_dir(&root);
            let mut child = command.spawn().unwrap();
            fs::write(root.join("grandchild-pid"), child.id().to_string()).unwrap();
            wait_for(&root.join("child-pid"));
            if mode == "parent" {
                assert!(child.wait().unwrap().success());
            }
            event(&root, "parent-exiting");
        }
        "grandchild" => {
            fs::write(root.join("child-pid"), std::process::id().to_string()).unwrap();
            wait_for(&root.join("release"));
            event(&root, "grandchild-finished");
        }
        "arguments" => {
            let value = std::env::var("NEMOCLAW_GUARDIAN_TEST_VALUE").unwrap();
            fs::write(root.join("arguments"), value).unwrap();
        }
        _ => panic!("unknown owned fixture mode"),
    }
}

#[test]
fn preserves_real_child_exit_code_and_no_lingering_job_members() {
    let fixture = Fixture::new();
    assert_eq!(
        run(
            fixture.command("exit23"),
            0x08000000,
            fixture.lease.as_raw_handle(),
            false
        ),
        Ok(23)
    );
    finish(fixture);
}

#[test]
fn owned_stdin_handshake_is_delivered_without_waiting_for_eof() {
    let fixture = Fixture::new();
    assert_eq!(
        run(
            fixture.command("stdin"),
            0x08000000,
            fixture.lease.as_raw_handle(),
            true
        ),
        Ok(0)
    );
    assert!(
        fs::read_to_string(fixture.root.join("events"))
            .unwrap()
            .contains("handshake-received")
    );
    finish(fixture);
}

#[test]
fn normal_child_and_grandchild_finish_before_guardian_returns() {
    let fixture = Fixture::new();
    let root = fixture.root.clone();
    let signal = std::thread::spawn(move || {
        wait_for(&root.join("child-pid"));
        std::thread::sleep(Duration::from_millis(200));
        assert!(fs::remove_file(root.join("lease")).is_err());
        fs::write(root.join("release"), b"stop owned grandchild").unwrap();
    });
    assert_eq!(
        run(
            fixture.command("parent"),
            0x08000000,
            fixture.lease.as_raw_handle(),
            false
        ),
        Ok(0)
    );
    signal.join().unwrap();
    let events = fs::read_to_string(fixture.root.join("events")).unwrap();
    assert!(events.contains("grandchild-finished\nparent-exiting"));
    finish(fixture);
}

#[test]
fn living_descendant_forces_cleanup_and_cannot_be_reported_as_success() {
    let fixture = Fixture::new();
    let started = Instant::now();
    assert_eq!(
        run(
            fixture.command("orphan-parent"),
            0x08000000,
            fixture.lease.as_raw_handle(),
            false
        ),
        Err("runtime-host-left-descendants")
    );
    assert!(started.elapsed() >= Duration::from_secs(5));
    assert!(
        !fs::read_to_string(fixture.root.join("events"))
            .unwrap()
            .contains("grandchild-finished")
    );
    // The completed Job query is the authoritative descendant-exit observation;
    // its native handles have closed before this root can be removed.
    finish(fixture);
}

#[test]
fn actual_child_environment_keeps_unicode_spaces_and_literal_metacharacters() {
    let fixture = Fixture::new();
    let value = "Unicode Ω space & literal $(not executed)";
    let mut command = fixture.command("arguments");
    command.env("NEMOCLAW_GUARDIAN_TEST_VALUE", value);
    assert_eq!(
        run(command, 0x08000000, fixture.lease.as_raw_handle(), false),
        Ok(0)
    );
    assert_eq!(
        fs::read_to_string(fixture.root.join("arguments")).unwrap(),
        value
    );
    finish(fixture);
}

#[test]
fn missing_child_preserves_start_failure_without_releasing_caller_lease() {
    let fixture = Fixture::new();
    let mut command = Command::new(fixture.root.join("not-present.exe"));
    command.current_dir(&fixture.root);
    assert_eq!(
        run(command, 0x08000000, fixture.lease.as_raw_handle(), false),
        Err("runtime-host-start")
    );
    assert!(fs::remove_file(fixture.root.join("lease")).is_err());
    finish(fixture);
}

#[test]
fn crt_arguments_preserve_spaces_quotes_and_trailing_slashes() {
    for (value, expected) in [
        ("", "\"\""),
        ("hello world", "\"hello world\""),
        ("C:\\end\\", "\"C:\\end\\\\\""),
        ("a\"b", "\"a\\\"b\""),
    ] {
        assert_eq!(
            String::from_utf16(&quoted(OsStr::new(value)).unwrap()).unwrap(),
            expected
        );
    }
}
#[test]
fn rejects_embedded_nul() {
    assert!(quoted(OsStr::new("a\0b")).is_err());
}
