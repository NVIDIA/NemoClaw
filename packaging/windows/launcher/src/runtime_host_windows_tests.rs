// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::*;
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, Read, Write};
use std::os::windows::fs::OpenOptionsExt;
use std::os::windows::io::AsRawHandle;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

static NEXT: AtomicU64 = AtomicU64::new(0);
const FIXTURE: &str = "runtime_host::tests::owned_process_fixture";

struct Fixture {
    root: PathBuf,
    lease: Option<File>,
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
        Self {
            root,
            lease: Some(lease),
        }
    }
    fn lease_handle(&self) -> RawHandle {
        self.lease.as_ref().unwrap().as_raw_handle()
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
            "service-pid",
            "service-owner-pid",
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
        "pipe-invalid" => {
            let pipe = std::env::var_os("NEMOCLAW_RUNTIME_SERVICE_PIPE").unwrap();
            let mut channel = OpenOptions::new()
                .read(true)
                .write(true)
                .open(pipe)
                .unwrap();
            channel.write_all(b"unknown\n").unwrap();
            let mut response = Vec::new();
            assert!(channel.read_to_end(&mut response).is_err() || response.is_empty());
        }
        "pipe-foreign-parent" => {
            let mut command = Command::new(std::env::current_exe().unwrap());
            command
                .args(["--exact", FIXTURE, "--nocapture"])
                .env("NEMOCLAW_GUARDIAN_TEST_MODE", "pipe-invalid")
                .current_dir(&root);
            assert!(command.status().unwrap().success());
        }
        "service-loop" => {
            let mut line = String::new();
            std::io::stdin().lock().read_line(&mut line).unwrap();
            assert_eq!(line, "start\n");
            fs::write(root.join("service-pid"), std::process::id().to_string()).unwrap();
            wait_for(&root.join("release"));
        }
        "service-owner" => {
            fs::write(
                root.join("service-owner-pid"),
                std::process::id().to_string(),
            )
            .unwrap();
            let lease = OpenOptions::new()
                .read(true)
                .share_mode(1)
                .open(root.join("lease"))
                .unwrap();
            let mut command = Command::new(std::env::current_exe().unwrap());
            command
                .args(["--exact", FIXTURE, "--nocapture"])
                .env("NEMOCLAW_GUARDIAN_TEST_MODE", "service-loop")
                .current_dir(&root);
            let result = run_managed(command, 0x08000000, lease.as_raw_handle(), true, None, true);
            std::process::exit(result.unwrap_or(1));
        }
        "service-starter" => {
            let mut command = Command::new(std::env::current_exe().unwrap());
            command
                .args(["--exact", FIXTURE, "--nocapture"])
                .env("NEMOCLAW_GUARDIAN_TEST_MODE", "service-owner")
                .current_dir(&root)
                .stdin(std::process::Stdio::piped());
            let mut service = command.spawn().unwrap();
            let _provisional_writer = service.stdin.take().unwrap();
            wait_for(&root.join("service-pid"));
            loop {
                std::thread::sleep(Duration::from_secs(1));
            }
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
            fixture.lease_handle(),
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
            fixture.lease_handle(),
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
            fixture.lease_handle(),
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
            fixture.lease_handle(),
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
        run(command, 0x08000000, fixture.lease_handle(), false),
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
        run(command, 0x08000000, fixture.lease_handle(), false),
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

struct OwnedChild(std::process::Child);
impl OwnedChild {
    fn code(&mut self) -> i32 {
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            if let Some(status) = self.0.try_wait().unwrap() {
                return status.code().unwrap_or(1);
            }
            assert!(Instant::now() < deadline, "owned service did not stop");
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}
impl Drop for OwnedChild {
    fn drop(&mut self) {
        if self.0.try_wait().ok().flatten().is_none() {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
}
#[link(name = "kernel32")]
unsafe extern "system" {
    fn OpenProcess(access: u32, inherit: i32, pid: u32) -> RawHandle;
    fn TerminateProcess(process: RawHandle, code: u32) -> i32;
}
struct OwnedDescendant(Handle);
impl OwnedDescendant {
    fn from_fixture(path: &Path) -> Self {
        wait_for(path);
        let pid = fs::read_to_string(path).unwrap().parse::<u32>().unwrap();
        let handle = unsafe { OpenProcess(0x100000 | 0x1000 | 1, 0, pid) };
        assert!(!handle.is_null());
        Self(Handle(handle))
    }
    fn wait(&self) {
        assert_eq!(unsafe { WaitForSingleObject(self.0.0, 15000) }, 0);
    }
}
impl Drop for OwnedDescendant {
    fn drop(&mut self) {
        if unsafe { WaitForSingleObject(self.0.0, 0) } == 258 {
            unsafe {
                TerminateProcess(self.0.0, 1);
                WaitForSingleObject(self.0.0, 5000);
            }
        }
    }
}
#[test]
fn provisional_service_parent_eof_stops_its_actual_owned_job() {
    let mut fixture = Fixture::new();
    let mut command = fixture.command("service-owner");
    command.stdin(std::process::Stdio::piped());
    let mut service = OwnedChild(command.spawn().unwrap());
    let process = OwnedDescendant::from_fixture(&fixture.root.join("service-pid"));
    drop(fixture.lease.take());
    assert!(fs::remove_file(fixture.root.join("lease")).is_err());
    drop(service.0.stdin.take());
    assert_ne!(service.code(), 0);
    process.wait();
    finish(fixture);
}
#[test]
fn committed_service_outlives_request_pipe_and_keeps_its_own_lease_until_stop() {
    let mut fixture = Fixture::new();
    let mut command = fixture.command("service-owner");
    command.stdin(std::process::Stdio::piped());
    let mut service = OwnedChild(command.spawn().unwrap());
    let process = OwnedDescendant::from_fixture(&fixture.root.join("service-pid"));
    let mut provisional = service.0.stdin.take().unwrap();
    provisional.write_all(b"commit\n").unwrap();
    drop(provisional);
    drop(fixture.lease.take());
    std::thread::sleep(Duration::from_millis(100));
    assert!(service.0.try_wait().unwrap().is_none());
    assert!(fs::remove_file(fixture.root.join("lease")).is_err());
    fs::write(fixture.root.join("release"), b"normal owned service stop").unwrap();
    assert_eq!(service.code(), 0);
    process.wait();
    fs::remove_file(fixture.root.join("lease")).unwrap();
    finish(fixture);
}
#[test]
fn abruptly_killed_requester_cannot_strand_its_uncommitted_service() {
    let mut fixture = Fixture::new();
    let mut starter = OwnedChild(fixture.command("service-starter").spawn().unwrap());
    let process = OwnedDescendant::from_fixture(&fixture.root.join("service-pid"));
    let service = OwnedDescendant::from_fixture(&fixture.root.join("service-owner-pid"));
    drop(fixture.lease.take());
    assert!(fs::remove_file(fixture.root.join("lease")).is_err());
    starter.0.kill().unwrap();
    assert_ne!(starter.code(), 0);
    service.wait();
    process.wait();
    fs::remove_file(fixture.root.join("lease")).unwrap();
    finish(fixture);
}

#[test]
fn unused_service_pipe_closes_on_actual_agent_exit_without_an_idle_polling_loop() {
    let fixture = Fixture::new();
    assert_eq!(
        run_managed(
            fixture.command("exit23"),
            0x08000000,
            fixture.lease_handle(),
            false,
            Some(&fixture.root),
            false
        ),
        Ok(23)
    );
    finish(fixture);
}
#[test]
fn service_pipe_accepts_only_the_exact_held_agent_process_identity() {
    let fixture = Fixture::new();
    assert_eq!(
        run_managed(
            fixture.command("pipe-foreign-parent"),
            0x08000000,
            fixture.lease_handle(),
            false,
            Some(&fixture.root),
            false
        ),
        Err("runtime-service-client")
    );
    finish(fixture);
}
#[test]
fn service_pipe_rejects_unknown_actions_from_even_the_correct_agent_process() {
    let fixture = Fixture::new();
    assert_eq!(
        run_managed(
            fixture.command("pipe-invalid"),
            0x08000000,
            fixture.lease_handle(),
            false,
            Some(&fixture.root),
            false
        ),
        Err("runtime-service-request")
    );
    finish(fixture);
}
