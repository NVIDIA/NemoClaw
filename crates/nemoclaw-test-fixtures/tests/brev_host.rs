// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Run the checked-in Brev scripts with a closed PATH of harmless Rust fakes.
#![cfg(unix)]

use std::{
    fs,
    os::unix::fs::symlink,
    path::PathBuf,
    process::{Command, Output},
};

const FAKE: &str = env!("CARGO_BIN_EXE_nemoclaw-fixture-brev");
const HOST: &str = "tools/e2e/brev-v1-host.sh";
const STARTUP: &str = "tools/e2e/brev-v1-startup.sh";

struct Fixture(tempfile::TempDir);

impl Fixture {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir(root.path().join("bin")).unwrap();
        fs::create_dir_all(root.path().join("tools/e2e")).unwrap();
        let repo = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
        for script in [HOST, STARTUP] {
            fs::copy(repo.join(script), root.path().join(script)).unwrap();
        }
        for name in [
            "brev", "ssh", "rsync", "git", "gzip", "sleep", "seq", "rm", "mkdir",
        ] {
            symlink(FAKE, root.path().join("bin").join(name)).unwrap();
        }
        Self(root)
    }

    fn startup(&self, env: &[(&str, &str)]) -> Output {
        self.startup_with_input(env, b"")
    }

    fn startup_with_input(&self, env: &[(&str, &str)], input: &[u8]) -> Output {
        for name in [
            "id",
            "sudo",
            "env",
            "tee",
            "fuser",
            "apt-get",
            "apt-cache",
            "systemctl",
            "usermod",
            "install",
        ] {
            symlink(FAKE, self.0.path().join("bin").join(name)).unwrap();
        }
        let stdin = self.0.path().join("startup.stdin");
        fs::write(&stdin, input).unwrap();
        self.command(STARTUP)
            .stdin(fs::File::open(stdin).unwrap())
            .envs(env.iter().copied())
            .output()
            .unwrap()
    }

    fn command(&self, script: &str) -> Command {
        let mut command = Command::new("/bin/bash");
        command
            .arg(script)
            .current_dir(self.0.path())
            .env_clear()
            .env("PATH", self.0.path().join("bin"))
            .env("BREV_FIXTURE_ROOT", self.0.path())
            .env("RUNNER_TEMP", self.0.path())
            .env("INSTANCE_NAME", "nclaw-v1-123-1")
            .env("NVIDIA_INFERENCE_API_KEY", "fixture-secret");
        command
    }

    fn host(&self, action: &str, env: &[(&str, &str)]) -> Output {
        self.command(HOST)
            .arg(action)
            .envs(env.iter().copied())
            .output()
            .unwrap()
    }

    fn events(&self) -> Vec<Vec<String>> {
        fs::read_to_string(self.0.path().join("events"))
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }
}

fn succeeded(output: &Output) {
    assert!(output.status.success(), "{output:?}");
}

fn calls<'a>(events: &'a [Vec<String>], name: &str) -> Vec<&'a Vec<String>> {
    events.iter().filter(|event| event[0] == name).collect()
}

fn position(events: &[Vec<String>], name: &str) -> usize {
    events
        .iter()
        .position(|event| event[0] == name)
        .unwrap_or_else(|| panic!("missing {name}: {events:?}"))
}

#[test]
fn prepare_runs_checked_in_bootstrap_once_after_ssh_before_transferring_source() {
    let fixture = Fixture::new();
    let output = fixture.host("prepare", &[("READY_FAILURES", "2")]);
    succeeded(&output);
    let events = fixture.events();
    assert_eq!(calls(&events, "ready").len(), 3);
    assert_eq!(calls(&events, "bootstrap").len(), 1);
    assert_eq!(calls(&events, "sentinel").len(), 1);
    for ssh in calls(&events, "ssh").into_iter().filter(|event| {
        matches!(
            event.last().unwrap().as_str(),
            "true" | "bash -s" | "test -f /var/run/nemoclaw-brev-v1-ready"
        )
    }) {
        assert!(ssh.windows(2).any(|args| args == ["-o", "BatchMode=yes"]));
        assert!(
            ssh.windows(2)
                .any(|args| args == ["-o", "ConnectTimeout=10"])
        );
    }
    assert!(position(&events, "bootstrap") > events.iter().rposition(|e| e[0] == "ready").unwrap());
    assert!(position(&events, "bootstrap") < position(&events, "sentinel"));
    assert!(position(&events, "sentinel") < position(&events, "rsync"));
    assert_eq!(
        fs::read(fixture.0.path().join("bootstrap.stdin")).unwrap(),
        fs::read(fixture.0.path().join(STARTUP)).unwrap(),
    );
    let create = calls(&events, "brev")
        .into_iter()
        .find(|event| event[1] == "create")
        .unwrap();
    assert!(!create.iter().any(|arg| arg == "--startup-script"));
    assert_eq!(calls(&events, "lifecycle").len(), 1);
}

#[test]
fn home_read_recovers_on_sixth_attempt_even_when_refresh_fails() {
    for action in ["prepare", "load-image", "qualify"] {
        let fixture = Fixture::new();
        let output = fixture.host(
            action,
            &[
                ("HOME_FAILURES", "5"),
                ("REFRESH_STATUS", "1"),
                ("REMOTE_HOME", "/srv/login"),
            ],
        );
        succeeded(&output);
        let events = fixture.events();
        assert_eq!(calls(&events, "home").len(), 6, "{action}");
        assert_eq!(calls(&events, "sleep").len(), 5, "{action}");
        for ssh in calls(&events, "ssh")
            .into_iter()
            .filter(|event| event.last().unwrap() == "printf %s \"$HOME\"")
        {
            assert!(ssh.windows(2).any(|args| args == ["-o", "BatchMode=yes"]));
            assert!(
                ssh.windows(2)
                    .any(|args| args == ["-o", "ConnectTimeout=10"])
            );
        }
        assert!(!String::from_utf8_lossy(&output.stdout).contains("refresh diagnostic"));
        assert!(String::from_utf8_lossy(&output.stderr).contains("refresh diagnostic"));
        let transfers = calls(&events, "rsync");
        assert!(!transfers.is_empty());
        assert!(transfers.iter().all(|event| {
            event
                .iter()
                .any(|arg| arg.starts_with("nclaw-v1-123-1:/srv/login/nclaw-v1-123-1/"))
        }));
        assert_eq!(calls(&events, "lifecycle").len(), 1, "{action}");
    }
}

#[test]
fn relative_or_empty_home_stops_before_transfer_or_lifecycle() {
    for action in ["prepare", "load-image", "qualify"] {
        for home in ["", "relative/home"] {
            let fixture = Fixture::new();
            let output = fixture.host(action, &[("REMOTE_HOME", home)]);
            assert!(!output.status.success(), "{action}: {output:?}");
            assert!(String::from_utf8_lossy(&output.stderr).contains("Invalid remote home"));
            let events = fixture.events();
            assert_eq!(calls(&events, "home").len(), 1);
            assert!(calls(&events, "rsync").is_empty());
            assert!(calls(&events, "lifecycle").is_empty());
        }
    }
}

#[test]
fn home_read_stops_after_six_failures_without_transferring_candidates() {
    for action in ["prepare", "load-image", "qualify"] {
        let fixture = Fixture::new();
        let output = fixture.host(action, &[("HOME_FAILURES", "99")]);
        assert!(!output.status.success(), "{action}: {output:?}");
        assert!(String::from_utf8_lossy(&output.stderr).contains("failed after 6 attempts"));
        let events = fixture.events();
        assert_eq!(calls(&events, "home").len(), 6);
        assert_eq!(calls(&events, "sleep").len(), 5);
        assert!(calls(&events, "rsync").is_empty());
        assert!(calls(&events, "lifecycle").is_empty());
    }
}

#[test]
fn refresh_failure_does_not_discard_an_immediately_successful_home_read() {
    for action in ["prepare", "load-image", "qualify"] {
        let fixture = Fixture::new();
        let output = fixture.host(action, &[("REFRESH_STATUS", "1")]);
        succeeded(&output);
        let events = fixture.events();
        assert_eq!(calls(&events, "home").len(), 1);
        assert!(calls(&events, "sleep").is_empty());
        assert_eq!(calls(&events, "lifecycle").len(), 1);
    }
}

#[test]
fn disconnected_bootstrap_is_not_replayed_and_stops_before_transfer() {
    let fixture = Fixture::new();
    let output = fixture.host("prepare", &[("BOOTSTRAP_DISCONNECT", "1")]);
    assert_eq!(output.status.code(), Some(255));
    let events = fixture.events();
    assert_eq!(calls(&events, "bootstrap").len(), 1);
    assert!(calls(&events, "sentinel").is_empty());
    assert!(calls(&events, "rsync").is_empty());
    assert!(calls(&events, "lifecycle").is_empty());
}

#[test]
fn missing_sentinel_stops_before_transfer_without_replaying_bootstrap() {
    let fixture = Fixture::new();
    let output = fixture.host("prepare", &[("MISSING_SENTINEL", "1")]);
    assert!(!output.status.success());
    let events = fixture.events();
    assert_eq!(calls(&events, "bootstrap").len(), 1);
    assert_eq!(calls(&events, "sentinel").len(), 1);
    assert!(calls(&events, "rsync").is_empty());
    assert!(calls(&events, "lifecycle").is_empty());
}

#[test]
fn disconnected_lifecycle_mutations_are_not_replayed() {
    for action in ["prepare", "load-image", "qualify"] {
        let fixture = Fixture::new();
        let output = fixture.host(action, &[("LIFECYCLE_DISCONNECT", "1")]);
        assert_eq!(output.status.code(), Some(255), "{action}");
        let events = fixture.events();
        assert_eq!(calls(&events, "home").len(), 1);
        assert_eq!(calls(&events, "lifecycle").len(), 1);
        assert!(!fixture.0.path().join("nvidia-api-key").exists());
    }
}

#[test]
fn startup_waits_for_root_owned_apt_locks_before_installing() {
    for lock in ["/var/lib/dpkg/lock-frontend", "/var/lib/apt/lists/lock"] {
        let fixture = Fixture::new();
        let output = fixture.startup(&[("APT_BUSY_LOCK", lock), ("APT_BUSY_PROBES", "1")]);
        succeeded(&output);
        let events = fixture.events();
        assert_eq!(
            calls(&events, "sleep"),
            vec![&vec!["sleep".to_owned(), "5".to_owned()]]
        );
        assert!(position(&events, "sleep") < position(&events, "apt-get"));
        assert!(
            calls(&events, "elevated")
                .iter()
                .any(|event| event[1] == "fuser" && event[2] == lock)
        );
        assert!(fixture.0.path().join("sentinel").exists());
    }
}

#[test]
fn every_package_install_uses_the_180_second_dpkg_lock_timeout() {
    for buildx in ["docker-buildx-plugin", "docker-buildx"] {
        let fixture = Fixture::new();
        let output = fixture.startup(&[("BUILDX_PACKAGE", buildx)]);
        succeeded(&output);
        let events = fixture.events();
        let installs: Vec<_> = calls(&events, "apt-get")
            .into_iter()
            .filter(|event| event.iter().any(|arg| arg == "install"))
            .collect();
        assert_eq!(installs.len(), 3, "{installs:?}");
        assert!(
            installs
                .iter()
                .any(|event| event.iter().any(|arg| arg == "ca-certificates"))
        );
        assert!(
            installs
                .iter()
                .any(|event| event.iter().any(|arg| arg == "docker.io"))
        );
        assert!(
            installs
                .iter()
                .any(|event| event.iter().any(|arg| arg == buildx))
        );
        for install in installs {
            assert!(
                install
                    .windows(2)
                    .any(|args| args == ["-o", "DPkg::Lock::Timeout=180"]),
                "install can race with another apt process: {install:?}"
            );
        }
    }
}

#[test]
fn startup_stops_after_180_seconds_of_busy_locks_without_installing() {
    let fixture = Fixture::new();
    let output = fixture.startup(&[
        ("APT_BUSY_LOCK", "/var/lib/dpkg/lock-frontend"),
        ("APT_BUSY_PROBES", "999"),
    ]);
    assert!(!output.status.success());
    assert!(
        String::from_utf8_lossy(&output.stdout).contains("apt locks remained busy for 180 seconds")
    );
    let events = fixture.events();
    let waits: usize = calls(&events, "sleep")
        .iter()
        .map(|event| event[1].parse::<usize>().unwrap())
        .sum();
    assert_eq!(waits, 180);
    assert!(calls(&events, "apt-get").is_empty());
    assert!(!fixture.0.path().join("sentinel").exists());
}

#[test]
fn startup_keeps_package_operations_noninteractive_after_sudo() {
    for buildx in ["docker-buildx-plugin", "docker-buildx"] {
        let fixture = Fixture::new();
        let output = fixture.startup(&[("BUILDX_PACKAGE", buildx), ("CHECK_APT_ENV", "1")]);
        succeeded(&output);
        assert_eq!(calls(&fixture.events(), "apt-get").len(), 4);
        assert!(fixture.0.path().join("sentinel").exists());
    }
}

#[test]
fn startup_does_not_allow_package_operations_to_read_caller_stdin() {
    let fixture = Fixture::new();
    let output = fixture.startup_with_input(
        &[("CHECK_APT_ENV", "1"), ("CHECK_APT_STDIN", "1")],
        b"input reserved for the calling bootstrap shell\n",
    );
    succeeded(&output);
    let events = fixture.events();
    let package_input = calls(&events, "apt-stdin");
    assert_eq!(package_input.len(), 4);
    assert!(
        package_input.iter().all(|event| event[1] == "0"),
        "package commands consumed the bootstrap input: {package_input:?}"
    );
    assert!(fixture.0.path().join("sentinel").exists());
}
