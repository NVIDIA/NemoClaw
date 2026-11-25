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
        .arg("--")
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
    .args(["sandbox", "exec", "--", "hello world"])
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
fn an_oidc_gateway_without_a_sign_in_shows_the_command_to_register_it() {
    let root = tempfile::tempdir().unwrap();
    let gateway = serde_json::json!({
        "endpoint":"https://gateway.example.com",
        "oidc":{"issuer":"https://idp.example.com/realms/openshell", "clientId":"openshell-cli"}
    });
    let script = "#!/bin/sh\nprintf '%s ' \"$@\"; echo\nif [ \"$2\" = add ]; then touch \"$XDG_CONFIG_HOME/openshell/gateways/$OPENSHELL_GATEWAY/metadata.json\"; fi\n";
    let run = |args: &[&str]| {
        let output = osh(root.path(), gateway.clone(), script)
            .args(args)
            .output()
            .unwrap();
        assert!(output.status.success());
        (
            String::from_utf8(output.stdout).unwrap(),
            String::from_utf8(output.stderr).unwrap(),
        )
    };
    let (stdout, hint) = run(&["status"]);
    assert_eq!(stdout, "status \n");
    let add = hint.lines().nth(1).unwrap().trim();
    assert!(
        add.starts_with("nemoclaw osh -- gateway add https://gateway.example.com --name nc-")
            && add.ends_with(
                " --oidc-issuer https://idp.example.com/realms/openshell --oidc-client-id openshell-cli"
            ),
        "{hint}"
    );
    let args: Vec<&str> = add.split(' ').skip(3).collect();
    assert_eq!(run(&args).1, "");
    assert_eq!(run(&["status"]), ("status \n".into(), "".into()));
}

#[test]
fn a_gateway_reached_only_with_a_bearer_token_is_refused() {
    let root = tempfile::tempdir().unwrap();
    let gateway = serde_json::json!({
        "endpoint":"https://gateway.example.com", "credential":{"env":"GATEWAY_TOKEN"}
    });
    let output = osh(root.path(), gateway, "#!/bin/sh\nexit 0\n")
        .arg("status")
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("bearer token"),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}
