// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Run shell boundaries with synthetic inputs, fake permission responses, and no network.
use std::{
    fs,
    process::Command,
    sync::atomic::{AtomicUsize, Ordering},
};

static NEXT: AtomicUsize = AtomicUsize::new(0);

/// The `run` script of the workflow step named `step`, dedented. Only
/// indentation relative to the step matters, not its absolute depth.
fn script(step: &str) -> String {
    let workflow = fs::read_to_string(".github/workflows/colossus-connectivity.yml").unwrap();
    let mut lines = workflow
        .lines()
        .skip_while(|line| line.trim() != format!("- name: {step}"))
        .skip(1);
    let run = lines
        .by_ref()
        .find(|line| line.trim() == "run: |")
        .unwrap_or_else(|| panic!("no run script for step {step:?}"));
    let key = run.len() - run.trim_start().len();
    let body: Vec<&str> = lines
        .take_while(|line| line.trim().is_empty() || line.len() - line.trim_start().len() > key)
        .collect();
    let indent = body
        .iter()
        .filter(|line| !line.trim().is_empty())
        .map(|line| line.len() - line.trim_start().len())
        .min()
        .unwrap_or(0);
    body.iter()
        .map(|line| line.get(indent..).unwrap_or(""))
        .collect::<Vec<_>>()
        .join("\n")
}

#[test]
/// Synthetic SSH output must stay private, the outcome names only the failed
/// stage, and every exit must remove credential files.
fn publishes_only_outcome_and_commit_and_removes_credentials() {
    let script = &script("Verify SSH connectivity");
    for (scenario, outcome) in [
        ("success", "passed"),
        ("ssh_failure", "failed (ssh)"),
        ("remote_failure", "failed (remote-command)"),
        ("timeout", "failed (timeout)"),
        ("interrupted", "failed (interrupted)"),
        ("missing_key", "failed (inputs)"),
        ("missing_host", "failed (inputs)"),
        ("missing_user", "failed (inputs)"),
        ("missing_known_hosts", "failed (inputs)"),
        ("invalid_host", "failed (inputs)"),
        ("invalid_user", "failed (inputs)"),
        ("invalid_key", "failed (key)"),
        ("invalid_known_hosts", "failed (known-hosts)"),
    ] {
        let root = std::env::temp_dir().join(format!(
            "ssh-workflow-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        let summary = root.join("summary");
        let bin = root.join("bin");
        fs::create_dir(&bin).unwrap();
        let shim = r#"#!/bin/bash
set -eu
case "${0##*/}" in
ssh-keygen)
  if [[ "$scenario" == invalid_key && "$1" == -y ]] || [[ "$scenario" == invalid_known_hosts && "$1" == -l ]]; then
    echo synthetic-private-key >&2; exit 1
  fi ;;
timeout)
  [[ "$1" == --signal=TERM && "$2" == --kill-after=5s && "$3" == 30s ]] || exit 82
  shift 3
  [[ "$scenario" != timeout ]] || exit 124
  if [[ "$scenario" == interrupted ]]; then kill -TERM "$PPID"; exit 143; fi
  exec "$@" ;;
ssh)
  : > "${0%/*}/ssh-invoked"
  args=" $* "
  for requirement in ' -F /dev/null ' ' StrictHostKeyChecking=yes ' ' BatchMode=yes ' ' IdentityAgent=none ' ' ForwardAgent=no ' ' ClearAllForwardings=yes ' ' /usr/bin/true '; do
    [[ "$args" == *"$requirement"* ]] || exit 80
  done
  [[ -z "${PROBE_PRIVATE_KEY+x}" && -z "${PROBE_KNOWN_HOSTS+x}" ]] || exit 81
  printf 'synthetic-private-key target.example.invalid\n'
  printf 'synthetic-known-hosts synthetic-user\n' >&2
  case "$scenario" in success) exit 0 ;; remote_failure) exit 1 ;; *) exit 255 ;; esac ;;
esac
"#;
        for command in ["ssh", "ssh-keygen", "timeout"] {
            use std::os::unix::fs::PermissionsExt;
            let path = bin.join(command);
            fs::write(&path, shim).unwrap();
            fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
        }
        let output = Command::new("bash")
            .args(["-c", script])
            .env(
                "PATH",
                format!("{}:{}", bin.display(), std::env::var("PATH").unwrap()),
            )
            .env("scenario", scenario)
            .env("RUNNER_TEMP", &root)
            .env("GITHUB_STEP_SUMMARY", &summary)
            .env("GITHUB_SHA", "a".repeat(40))
            .env(
                "PROBE_HOST",
                if scenario == "missing_host" {
                    ""
                } else if scenario == "invalid_host" {
                    "-bad"
                } else {
                    "target.example.invalid"
                },
            )
            .env(
                "PROBE_USER",
                if scenario == "missing_user" {
                    ""
                } else if scenario == "invalid_user" {
                    "bad user"
                } else {
                    "synthetic-user"
                },
            )
            .env(
                "PROBE_KNOWN_HOSTS",
                if scenario == "missing_known_hosts" {
                    ""
                } else {
                    "synthetic-known-hosts"
                },
            )
            .env(
                "PROBE_PRIVATE_KEY",
                if scenario == "missing_key" {
                    ""
                } else {
                    "synthetic-private-key"
                },
            )
            .output()
            .unwrap();
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        let summary_text = fs::read_to_string(&summary).unwrap();
        let allowed = scenario == "success";
        if scenario.starts_with("missing_") || scenario.starts_with("invalid_") {
            assert!(
                !bin.join("ssh-invoked").exists(),
                "SSH invoked with rejected inputs in {scenario}"
            );
        }
        assert_eq!(output.status.success(), allowed, "{scenario}: {stderr}");
        assert_eq!(stdout.trim(), format!("SSH connectivity: {outcome}"));
        assert!(
            stderr.is_empty(),
            "raw stderr escaped in {scenario}: {stderr}"
        );
        assert_eq!(
            summary_text,
            format!(
                "SSH connectivity: {outcome}\nTested commit: {}\n",
                "a".repeat(40)
            )
        );
        assert_eq!(
            fs::read_dir(&root).unwrap().count(),
            2,
            "credential files retained in {scenario}"
        );
        fs::remove_dir_all(root).unwrap();
    }
}
