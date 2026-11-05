// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Run shell boundaries with synthetic inputs, fake permission responses, and no network.
use std::{
    fs,
    process::Command,
    sync::atomic::{AtomicUsize, Ordering},
};

static NEXT: AtomicUsize = AtomicUsize::new(0);

fn scripts(step: &str) -> Vec<String> {
    let workflow = fs::read_to_string(".github/workflows/colossus-connectivity.yml").unwrap();
    workflow
        .split(&format!("      - name: {step}\n"))
        .skip(1)
        .map(|section| {
            section
                .split("        run: |\n")
                .nth(1)
                .unwrap()
                .lines()
                .take_while(|line| line.is_empty() || line.starts_with("          "))
                .map(|line| line.strip_prefix("          ").unwrap_or(line))
                .collect::<Vec<_>>()
                .join("\n")
        })
        .collect()
}

#[test]
/// Both jobs reject either actor when permission lookup fails or grants insufficient access.
fn authorizes_both_actors_and_fails_closed_in_each_job() {
    let scripts = scripts("Authorize maintainers");
    assert_eq!(
        scripts.len(),
        2,
        "each job must authorize its current triggering actor"
    );
    for script in scripts {
        for (scenario, original, rerunner, allowed) in [
            ("maintain", "owner", "operator", true),
            ("admin", "owner", "operator", true),
            ("write", "owner", "operator", false),
            ("read", "owner", "operator", false),
            ("api_failure", "owner", "operator", false),
            ("denied_original", "writer", "operator", false),
            ("denied_rerunner", "owner", "writer", false),
            ("malformed", "owner", "operator", false),
            ("maintain", "-invalid", "operator", false),
        ] {
            let shell = format!(
                r#"
gh() {{
  case "$scenario" in
    api_failure) echo 'synthetic-secret' >&2; return 1 ;;
    denied_original|denied_rerunner)
      if [[ "$*" == *'/writer/'* ]]; then echo write; else echo maintain; fi ;;
    malformed) printf 'maintain\nwrite\n' ;;
    *) printf '%s\n' "$scenario" ;;
  esac
}}
{script}
"#
            );
            let output = Command::new("bash")
                .args(["-c", &shell])
                .env("scenario", scenario)
                .env("ACTOR", original)
                .env("TRIGGERING_ACTOR", rerunner)
                .env("GITHUB_REPOSITORY", "NVIDIA/NemoClaw")
                .output()
                .unwrap();
            assert_eq!(
                output.status.success(),
                allowed,
                "permission scenario {scenario}"
            );
            assert!(!String::from_utf8_lossy(&output.stderr).contains("synthetic-secret"));
        }
    }
}

#[test]
/// Synthetic SSH output must stay private, and every exit must remove credential files.
fn publishes_only_outcome_and_commit_and_removes_credentials() {
    let script = &scripts("Verify SSH connectivity")[0];
    for scenario in [
        "success",
        "ssh_failure",
        "timeout",
        "interrupted",
        "missing_key",
        "missing_host",
        "missing_user",
        "missing_known_hosts",
        "invalid_host",
        "invalid_user",
        "invalid_key",
        "invalid_known_hosts",
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
  [[ "$scenario" == success ]] ;;
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
        assert_eq!(
            stdout.trim(),
            if allowed {
                "SSH connectivity: passed"
            } else {
                "SSH connectivity: failed"
            }
        );
        assert!(
            stderr.is_empty(),
            "raw stderr escaped in {scenario}: {stderr}"
        );
        assert_eq!(
            summary_text,
            format!(
                "SSH connectivity: {}\nTested commit: {}\n",
                if allowed { "passed" } else { "failed" },
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
