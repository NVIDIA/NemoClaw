// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use nemoclaw_sdk::{
    bundle::{Manifest, hash_file},
    config::Document,
};
use std::{fs, path::Path, process::Command};

fn command(root: &Path, name: &str, script: &str) -> Command {
    let document =
        Document::parse(include_bytes!("../../../examples/agents/openclaw.yaml").as_slice())
            .unwrap();
    let state = root.join("state");
    fs::create_dir_all(&state).unwrap();
    // A saved deployment in the SDK's version-34 intent format.
    let record = serde_json::json!({
        "version":34, "digest":document.digest(), "document":document,
        "generations":{
            "workspace":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "sandbox":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "provider":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "managed_gateway":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        }
    });
    fs::write(
        state.join("intent.json"),
        serde_json::to_vec(&record).unwrap(),
    )
    .unwrap();
    let bundle = root.join("bundle");
    crate::bundle::write_bundle(&bundle, None);
    let binary = bundle.join("libexec/openshell");
    crate::executable::write_executable(&binary, script);
    let path = bundle.join("manifest.json");
    let mut manifest: Manifest = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    manifest
        .files
        .insert("libexec/openshell".into(), hash_file(&binary).unwrap());
    fs::write(path, serde_json::to_vec(&manifest).unwrap()).unwrap();
    let mut cli = crate::nemoclaw();
    cli.arg(name)
        .arg("--state-dir")
        .arg(state)
        .arg("--bundle")
        .arg(bundle)
        .arg("--");
    cli
}

#[test]
fn both_command_names_preserve_child_arguments_output_and_exit_code() {
    for name in ["openshell", "osh"] {
        let root = tempfile::tempdir().unwrap();
        let output = command(
            root.path(),
            name,
            "#!/bin/sh\nprintf '%s\\0' \"$@\"\nprintf 'child stderr\\n' >&2\nexit 37\n",
        )
        .args(["sandbox", "exec", "--verbose", "--", "hello world"])
        .output()
        .unwrap();
        assert_eq!(
            output.status.code(),
            Some(37),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(
            output.stdout,
            b"sandbox\0exec\0--verbose\0--\0hello world\0"
        );
        assert_eq!(output.stderr, b"child stderr\n");
        assert_eq!(
            fs::read_dir(root.path().join("state/openshell"))
                .unwrap()
                .count(),
            0
        );
    }
}

const OIDC_CLI: &str = r#"#!/bin/sh
set -eu
session="$XDG_CONFIG_HOME/session"
profile="$XDG_CONFIG_HOME/profile"
if [ "$1 $2" = 'gateway list' ]; then
  if [ -n "${OSH_PROBE_HOLD:-}" ]; then
    printf ready > "$OSH_PROBE_HOLD"
    while [ ! -f "$OSH_PROBE_HOLD.release" ]; do sleep 0.01; done
  fi
  if [ -f "$profile" ]; then
    printf '[{"name":"%s"}]\n' "$OPENSHELL_GATEWAY"
  else
    printf '[]\n'
  fi
elif [ "$1 $2" = 'gateway add' ]; then
  if [ "${OSH_FAIL_REGISTRATION:-0}" != '0' ]; then
    exit "$OSH_FAIL_REGISTRATION"
  fi
  [ "$3" = 'https://gateway.example.com' ]
  shift 3
  name= issuer= client= audience= scopes=
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --name) name="$2" ;;
      --oidc-issuer) issuer="$2" ;;
      --oidc-client-id) client="$2" ;;
      --oidc-audience) audience="$2" ;;
      --oidc-scopes) scopes="$2" ;;
      *) exit 28 ;;
    esac
    shift 2
  done
  [ "$name" = "$OPENSHELL_GATEWAY" ]
  [ "$issuer" = 'https://idp.example.com/realms/openshell' ]
  [ "$client" = 'openshell-cli' ]
  [ "$audience" = 'openshell' ]
  [ "$scopes" = 'openid offline_access' ]
  if [ "${OPENSHELL_OIDC_CLIENT_SECRET:-}" = 'client-secret-sentinel' ]; then
    printf 'client-credentials\n' > "$session"
  else
    printf 'browser\n' > "$session"
  fi
  printf registered > "$profile"
  printf 'registered and authenticated\n'
elif [ "$1 $2" = 'gateway login' ]; then
  [ -f "$profile" ]
  printf 'browser\n' > "$session"
  printf 'authenticated again\n'
elif [ "$1 $2" = 'gateway logout' ]; then
  rm "$session"
elif [ "$1 $2" = 'sandbox list' ]; then
  [ -f "$session" ]
  cat "$session"
  printf '%s\n' "$OPENSHELL_WORKSPACE" "$XDG_CONFIG_HOME"
  if [ -n "${OSH_HOLD:-}" ]; then
    printf ready > "$OSH_HOLD"
    exec sleep 60
  fi
else
  exit 29
fi
"#;

fn oidc_command(root: &Path, script: &str) -> Command {
    let mut cli = command(root, "osh", script);
    let path = root.join("state/intent.json");
    let mut record: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    record["document"]["spec"]["gateway"]["endpoint"] =
        serde_json::json!("https://gateway.example.com");
    record["document"]["spec"]["gateway"]["credential"] =
        serde_json::json!({"env":"DEPLOYMENT_TOKEN"});
    record["document"]["spec"]["gateway"]["oidc"] = serde_json::json!({
        "issuer":"https://idp.example.com/realms/openshell",
        "clientId":"openshell-cli", "audience":"openshell", "scopes":"openid offline_access"
    });
    let document: Document = serde_json::from_value(record["document"].clone()).unwrap();
    record["digest"] = serde_json::json!(document.digest());
    fs::write(path, serde_json::to_vec(&record).unwrap()).unwrap();
    cli.env_remove("OPENSHELL_OIDC_CLIENT_SECRET")
        .env_remove("DEPLOYMENT_TOKEN")
        .env("XDG_CONFIG_HOME", root.join("user-config"));
    cli
}

#[test]
fn oidc_login_registers_from_yaml_once_and_keeps_the_session_for_the_next_command() {
    for client_secret in [false, true] {
        let root = tempfile::tempdir().unwrap();
        let mut login = oidc_command(root.path(), OIDC_CLI);
        if client_secret {
            login.env("OPENSHELL_OIDC_CLIENT_SECRET", "client-secret-sentinel");
        }
        let output = login.args(["gateway", "login"]).output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(
            output.stdout, b"registered and authenticated\n",
            "first login must not authenticate twice"
        );
        let output = oidc_command(root.path(), OIDC_CLI)
            .args(["sandbox", "list"])
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let text = String::from_utf8(output.stdout).unwrap();
        assert!(
            text.starts_with(if client_secret {
                "client-credentials\n"
            } else {
                "browser\n"
            }),
            "{text}"
        );
        assert!(
            text.contains("nc-"),
            "the saved workspace must be selected: {text}"
        );
        assert!(
            !root.path().join("user-config").exists(),
            "the user's OpenShell configuration must remain untouched"
        );
        let output = oidc_command(root.path(), OIDC_CLI)
            .args(["gateway", "login"])
            .output()
            .unwrap();
        assert!(output.status.success());
        assert_eq!(output.stdout, b"authenticated again\n");
    }
}

#[test]
fn missing_oidc_login_points_to_the_selected_bundle_without_starting_authentication() {
    let root = tempfile::Builder::new()
        .prefix("osh state ")
        .tempdir()
        .unwrap();
    let output = oidc_command(root.path(), OIDC_CLI)
        .args(["sandbox", "list"])
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(
        output.stdout.is_empty(),
        "do not start login as a side effect of a sandbox command"
    );
    let text = String::from_utf8(output.stderr).unwrap();
    assert!(
        text.contains("--bundle"),
        "the recovery command must select this bundle: {text}"
    );
    assert!(text.contains("-- gateway login"), "{text}");
    assert!(text.contains("'"), "quote paths containing spaces: {text}");
}

#[test]
fn failed_oidc_registration_preserves_the_exit_code_and_can_be_retried() {
    let root = tempfile::tempdir().unwrap();
    let output = oidc_command(root.path(), OIDC_CLI)
        .env("OSH_FAIL_REGISTRATION", "23")
        .args(["gateway", "login"])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(23));
    let output = oidc_command(root.path(), OIDC_CLI)
        .args(["gateway", "login"])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(output.stdout, b"registered and authenticated\n");
}

#[test]
fn oidc_logout_keeps_the_profile_and_login_restores_access() {
    let root = tempfile::tempdir().unwrap();
    for args in [["gateway", "login"], ["gateway", "logout"]] {
        assert!(
            oidc_command(root.path(), OIDC_CLI)
                .args(args)
                .output()
                .unwrap()
                .status
                .success()
        );
    }
    let output = oidc_command(root.path(), OIDC_CLI)
        .args(["sandbox", "list"])
        .output()
        .unwrap();
    assert!(!output.status.success(), "logout must remove access");
    let output = oidc_command(root.path(), OIDC_CLI)
        .args(["gateway", "login"])
        .output()
        .unwrap();
    assert!(output.status.success());
    assert_eq!(
        output.stdout, b"authenticated again\n",
        "reuse the existing profile after logout"
    );
    assert!(
        oidc_command(root.path(), OIDC_CLI)
            .args(["sandbox", "list"])
            .output()
            .unwrap()
            .status
            .success()
    );
}

#[test]
fn changing_oidc_client_requires_a_new_login_and_preserves_the_old_session() {
    let root = tempfile::tempdir().unwrap();
    assert!(
        oidc_command(root.path(), OIDC_CLI)
            .args(["gateway", "login"])
            .output()
            .unwrap()
            .status
            .success()
    );
    let mut cli = oidc_command(root.path(), OIDC_CLI);
    let path = root.path().join("state/intent.json");
    let mut record: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    record["document"]["spec"]["gateway"]["oidc"]["clientId"] = serde_json::json!("another-client");
    let document: Document = serde_json::from_value(record["document"].clone()).unwrap();
    record["digest"] = serde_json::json!(document.digest());
    fs::write(path, serde_json::to_vec(&record).unwrap()).unwrap();
    let output = cli.args(["sandbox", "list"]).output().unwrap();
    assert!(
        !output.status.success(),
        "do not reuse another client's login"
    );
    assert!(String::from_utf8_lossy(&output.stderr).contains("-- gateway login"));
    assert!(
        oidc_command(root.path(), OIDC_CLI)
            .args(["sandbox", "list"])
            .output()
            .unwrap()
            .status
            .success(),
        "retain the original client's session"
    );
}

#[test]
fn registered_oidc_commands_can_run_while_another_command_is_forwarding() {
    use nix::{
        sys::signal::{Signal, kill},
        unistd::Pid,
    };
    let root = tempfile::tempdir().unwrap();
    assert!(
        oidc_command(root.path(), OIDC_CLI)
            .args(["gateway", "login"])
            .output()
            .unwrap()
            .status
            .success()
    );
    let ready = root.path().join("forward-ready");
    let mut child = oidc_command(root.path(), OIDC_CLI)
        .env("OSH_HOLD", &ready)
        .args(["sandbox", "list"])
        .stdout(std::process::Stdio::null())
        .spawn()
        .unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while !ready.exists() && std::time::Instant::now() < deadline {
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    let output = oidc_command(root.path(), OIDC_CLI)
        .args(["sandbox", "list"])
        .output()
        .unwrap();
    kill(
        Pid::from_raw(child.id().try_into().unwrap()),
        Signal::SIGTERM,
    )
    .unwrap();
    child.wait().unwrap();
    assert!(ready.exists(), "the first command must be running");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn registered_oidc_commands_do_not_lock_each_others_profile_lookup() {
    let root = tempfile::tempdir().unwrap();
    assert!(
        oidc_command(root.path(), OIDC_CLI)
            .args(["gateway", "login"])
            .output()
            .unwrap()
            .status
            .success()
    );
    let ready = root.path().join("probe-ready");
    let mut child = oidc_command(root.path(), OIDC_CLI)
        .env("OSH_PROBE_HOLD", &ready)
        .args(["sandbox", "list"])
        .stdout(std::process::Stdio::null())
        .spawn()
        .unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while !ready.exists() && std::time::Instant::now() < deadline {
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    let output = oidc_command(root.path(), OIDC_CLI)
        .args(["sandbox", "list"])
        .output()
        .unwrap();
    fs::write(root.path().join("probe-ready.release"), b"release").unwrap();
    let status = child.wait().unwrap();
    assert!(ready.exists());
    assert!(status.success());
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn termination_reaches_the_child_and_removes_its_configuration() {
    use nix::{
        sys::signal::{Signal, kill},
        unistd::Pid,
    };
    let root = tempfile::tempdir().unwrap();
    let ready = root.path().join("ready");
    let mut child = command(
        root.path(),
        "osh",
        "#!/bin/sh\nprintf '%s' \"$XDG_CONFIG_HOME\" > \"$OSH_READY\"\nexec sleep 60\n",
    )
    .env("OSH_READY", &ready)
    .spawn()
    .unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while !ready.is_file() && std::time::Instant::now() < deadline {
        if let Some(status) = child.try_wait().unwrap() {
            panic!("wrapper exited before starting child: {status}");
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    assert!(ready.is_file(), "child must start before the signal");
    let configuration = fs::read_to_string(&ready).unwrap();
    kill(
        Pid::from_raw(child.id().try_into().unwrap()),
        Signal::SIGTERM,
    )
    .unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    loop {
        if let Some(status) = child.try_wait().unwrap() {
            assert_eq!(status.code(), Some(143));
            break;
        }
        if std::time::Instant::now() >= deadline {
            child.kill().unwrap();
            child.wait().unwrap();
            panic!("termination did not stop the child");
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    assert!(!Path::new(&configuration).exists());
}
