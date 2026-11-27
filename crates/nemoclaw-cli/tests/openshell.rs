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

/// An OIDC gateway reaches OpenShell like any other: the one-time
/// registration is a printed next step, not something `osh` checks.
#[test]
fn an_oidc_gateway_runs_openshell_directly() {
    let root = tempfile::tempdir().unwrap();
    let gateway = serde_json::json!({
        "endpoint":"https://gateway.example.com",
        "oidc":{"issuer":"https://idp.example.com/realms/openshell", "clientId":"openshell-cli"}
    });
    let output = osh(
        root.path(),
        gateway,
        "#!/bin/sh\nprintf 'ran %s\\n' \"$@\"\n",
    )
    .arg("status")
    .output()
    .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(output.stdout, b"ran status\n");
}

/// The bundled CLI can't carry a token, so a gateway with a token and no
/// sign-in settings is refused, even with mTLS, and told how to sign in.
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
        let error = String::from_utf8_lossy(&output.stderr);
        assert!(error.contains("add gateway.oidc"), "{error}");
    }
}
