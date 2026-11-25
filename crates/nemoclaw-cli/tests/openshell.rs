// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use nemoclaw_sdk::{
    bundle::{Manifest, hash_file},
    config::Document,
};
use std::{fs, path::Path, process::Command};

/// `nemoclaw osh --` for a saved deployment, with `gateway` fields merged
/// into the example's, whose bundled CLI is `script`.
fn osh(root: &Path, gateway: serde_json::Value, script: &str) -> Command {
    let mut document: serde_json::Value = serde_json::to_value(
        Document::parse(include_bytes!("../../../examples/agents/openclaw.yaml").as_slice())
            .unwrap(),
    )
    .unwrap();
    for (key, value) in gateway.as_object().into_iter().flatten() {
        document["spec"]["gateway"][key] = value.clone();
    }
    let document: Document = serde_json::from_value(document).unwrap();
    let state = root.join("state");
    fs::create_dir_all(&state).unwrap();
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
    cli.args(["osh", "--state-dir"])
        .arg(state)
        .arg("--bundle")
        .arg(bundle)
        .env("OPENSHELL_GATEWAY", "user-gateway");
    cli
}

#[test]
fn runs_openshell_against_the_deployment_gateway_and_workspace() {
    let root = tempfile::tempdir().unwrap();
    let output = osh(
        root.path(),
        serde_json::Value::Null,
        "#!/bin/sh\n[ \"$OPENSHELL_GATEWAY\" = \"$OPENSHELL_WORKSPACE\" ] || exit 1\nprintf '%s\\n' \"$OPENSHELL_GATEWAY_ENDPOINT\" \"$@\"\nexit 37\n",
    )
    .args(["--", "sandbox", "exec", "--", "hello world"])
    .output()
    .unwrap();
    assert_eq!(
        output.status.code(),
        Some(37),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        String::from_utf8_lossy(&output.stdout),
        "http://127.0.0.1:17671\nsandbox\nexec\n--\nhello world\n"
    );
}

#[test]
fn an_unregistered_oidc_gateway_stops_before_running_the_requested_command() {
    let root = tempfile::tempdir().unwrap();
    let gateway = serde_json::json!({
        "endpoint":"https://gateway.example.com",
        "oidc":{"issuer":"https://idp.example.com/realms/openshell", "clientId":"openshell-cli"}
    });
    let output = osh(
        root.path(),
        gateway,
        "#!/bin/sh\nprintf 'must not run\\n'\n",
    )
    .arg("status")
    .output()
    .unwrap();
    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
    assert!(String::from_utf8_lossy(&output.stderr).contains("Sign in"));
}

/// The bundled CLI can't carry a bearer token, so a gateway that needs one is
/// refused, even when mTLS is also configured, instead of reached without it.
#[test]
fn a_gateway_that_needs_a_bearer_token_is_refused() {
    let root = tempfile::tempdir().unwrap();
    let mtls = serde_json::json!({"ca":{"env":"CLI_CA"},"certificate":{"env":"CLI_CERT"},"key":{"env":"CLI_KEY"}});
    for tls in [serde_json::Value::Null, mtls] {
        let mut gateway = serde_json::json!({
            "endpoint":"https://gateway.example.com", "credential":{"env":"GATEWAY_TOKEN"}
        });
        if !tls.is_null() {
            gateway["tls"] = tls;
        }
        let output = osh(root.path(), gateway, "#!/bin/sh\nexit 0\n")
            .arg("status")
            .env("CLI_CA", root.path().join("ca"))
            .env("CLI_CERT", root.path().join("cert"))
            .env("CLI_KEY", root.path().join("key"))
            .output()
            .unwrap();
        assert!(!output.status.success());
        assert!(
            String::from_utf8_lossy(&output.stderr).contains("bearer token"),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
}

#[test]
fn help_and_gateway_management_reach_openshell_before_oidc_registration() {
    let root = tempfile::tempdir().unwrap();
    let gateway = serde_json::json!({"endpoint":"https://gateway.example.com",
        "oidc":{"issuer":"https://idp.example.com", "clientId":"openshell-cli"}});
    for args in [
        vec!["--", "--help"],
        vec![
            "--",
            "--gateway-insecure",
            "gateway",
            "add",
            "https://gateway.example.com",
        ],
    ] {
        let output = osh(
            root.path(),
            gateway.clone(),
            "#!/bin/sh\nprintf 'forwarded\\n'\n",
        )
        .args(args)
        .output()
        .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(output.stdout, b"forwarded\n");
        assert!(output.stderr.is_empty());
    }
}

#[test]
fn oidc_registration_hint_runs_against_the_same_state_and_bundle() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("deployment's files");
    fs::create_dir(&root).unwrap();
    let gateway = serde_json::json!({
        "endpoint":"https://gateway.example.com",
        "oidc":{"issuer":"https://idp.example.com", "clientId":"openshell-cli"}
    });
    let script = "#!/bin/sh\nif [ \"$2\" = add ]; then touch \"$XDG_CONFIG_HOME/openshell/gateways/$OPENSHELL_GATEWAY/metadata.json\"; fi\nprintf 'registered\\n'\n";
    let output = osh(&root, gateway.clone(), script)
        .arg("status")
        .output()
        .unwrap();
    assert!(!output.status.success());
    let hint = String::from_utf8(output.stderr).unwrap();
    let command = hint.lines().nth(1).unwrap().trim();
    let bin = root.join("bin");
    fs::create_dir(&bin).unwrap();
    std::os::unix::fs::symlink(env!("CARGO_BIN_EXE_nemoclaw"), bin.join("nemoclaw")).unwrap();
    let replay = Command::new("/bin/sh")
        .args(["-c", command])
        .current_dir(&root)
        .env("PATH", format!("{}:/usr/bin:/bin", bin.display()))
        .env("NEMOCLAW_DISABLE_TELEMETRY", "1")
        .output()
        .unwrap();
    assert!(
        replay.status.success(),
        "hint: {command}\n{}",
        String::from_utf8_lossy(&replay.stderr)
    );
    assert_eq!(String::from_utf8_lossy(&replay.stdout), "registered\n");
    let output = osh(&root, gateway, script).arg("status").output().unwrap();
    assert!(output.status.success());
    assert!(
        output.stderr.is_empty(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn oidc_registration_hint_preserves_literal_arguments_in_the_shell() {
    let root = tempfile::tempdir().unwrap();
    let gateway = serde_json::json!({
        "endpoint":"https://gateway.example.com",
        "oidc":{"issuer":"https://idp.example.com", "clientId":"client$REVIEW_EXPAND",
                "audience":"api audience", "scopes":"openid offline'access"}
    });
    let output = osh(root.path(), gateway, "#!/bin/sh\nexit 0\n")
        .arg("status")
        .output()
        .unwrap();
    assert!(!output.status.success());
    let hint = String::from_utf8(output.stderr).unwrap();
    let command = hint.lines().nth(1).unwrap().trim();
    let bin = root.path().join("bin");
    fs::create_dir(&bin).unwrap();
    crate::executable::write_executable(
        &bin.join("nemoclaw"),
        "#!/bin/sh\nprintf '%s\\n' \"$@\"\n",
    );
    let replay = Command::new("/bin/sh")
        .args(["-c", command])
        .env("PATH", format!("{}:/usr/bin:/bin", bin.display()))
        .env("REVIEW_EXPAND", "expanded")
        .output()
        .unwrap();
    assert!(replay.status.success());
    let args = String::from_utf8(replay.stdout).unwrap();
    let values: Vec<_> = args.lines().collect();
    assert!(
        values.contains(&"--oidc-client-id=client$REVIEW_EXPAND"),
        "{args}"
    );
    assert!(values.contains(&"--oidc-audience=api audience"), "{args}");
    assert!(
        values.contains(&"--oidc-scopes=openid offline'access"),
        "{args}"
    );
}

#[test]
fn oidc_login_settings_with_controls_are_refused_without_a_registration_hint() {
    let root = tempfile::tempdir().unwrap();
    let gateway = serde_json::json!({"endpoint":"https://gateway.example.com",
        "oidc":{"issuer":"https://idp.example.com", "clientId":"openshell-cli", "audience":"api\u{1b}[2J"}});
    let output = osh(
        root.path(),
        gateway,
        "#!/bin/sh\nprintf 'must not run\\n'\n",
    )
    .arg("status")
    .output()
    .unwrap();
    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
    let error = String::from_utf8(output.stderr).unwrap();
    assert!(error.contains("control characters"), "{error}");
    assert!(
        !error.contains('\u{1b}') && !error.contains("gateway add"),
        "{error}"
    );
}
