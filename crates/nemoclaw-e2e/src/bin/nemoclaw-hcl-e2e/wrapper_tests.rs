// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::*;
use serde_json::Value;

const LIVE_TEST: &str = "tests/docker-openclaw-nvidia.tftest.hcl";

/// Copy the live suite under root/suite.
fn suite(root: &Path) {
    let source = Path::new(env!("CARGO_MANIFEST_DIR")).join("hcl");
    for name in ["main.tf", "verifier/main.tf", LIVE_TEST] {
        let destination = root.join("suite").join(name);
        fs::create_dir_all(destination.parent().unwrap()).unwrap();
        fs::copy(source.join(name), destination).unwrap();
    }
}

fn script(root: &Path, name: &str, body: &str) -> PathBuf {
    use std::os::unix::fs::PermissionsExt;
    let path = root.join(name);
    fs::write(&path, format!("#!/bin/sh\nset -eu\n{body}\n")).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
    path
}

/// Fake CLI, OpenTofu, and probe that trace each step and fail where told.
fn tools(root: &Path) -> Tools {
    Tools {
        candidate_revision: "a".repeat(40),
        cli: script(
            root,
            "nemoclaw",
            r#"
operation="$1"
printf '%s\n' "$operation" >> "$TRACE"
while [ "$1" != --state-dir ]; do shift; done
case "$operation" in
  plan) printf product-state > "$2/sentinel" ;;
  apply)
    changes='[]'
    if [ -f "$2/terraform.tfstate" ] && [ "${FAIL_PHASE:-}" = reapply ]; then
      changes='[{"resource":"openshell_sandbox.assistant","actions":["update"]}]'
    fi
    printf '{"outcome":"succeeded","changes":%s}' "$changes"
    printf '{"resources":[]}' > "$2/terraform.tfstate" ;;
  destroy)
    [ "${FAIL_CLEANUP:-}" != 1 ]
    printf '{"outcome":"destroyed","changes":[],"retained":["openshell_gateway_storage.runtime"]}' ;;
esac
[ "${FAIL_PHASE:-}" != "$operation" ]
"#,
        ),
        tofu: script(
            root,
            "tofu",
            r#"
printf 'tofu-%s\n' "$2" >> "$TRACE"
[ "$2" != test ] || [ "${FAIL_PHASE:-}" != tofu-test ]
"#,
        ),
        // A succeeded run without reply text must still fail the outcome.
        probe: script(
            root,
            "probe",
            r#"
valid=true
if [ "$NEMOCLAW_HCL_TARGET" = "${INVALID_TARGET:-}" ]; then valid=false; fi
printf '{"target":"%s","expected":{"agent_name":"%s","runtime_id":"runtime"},"response":{"attempted":true,"succeeded":true,"agent_name":"%s","runtime_id":"runtime","output_valid":%s}}' \
 "$NEMOCLAW_HCL_TARGET" "$NEMOCLAW_HCL_AGENT" "$NEMOCLAW_HCL_AGENT" "$valid" > "$NEMOCLAW_HCL_REPORT"
"#,
        ),
        environment: BTreeMap::from([("TRACE".into(), root.join("trace").into())]),
    }
}

async fn run(
    root: &Path,
    bundle: &Path,
    tools: &Tools,
    filter: &str,
    name: &str,
) -> (Result<(), String>, PathBuf) {
    let deployment =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("hcl/cases/docker-openclaw-nvidia.yaml");
    let (suite, directory) = (root.join("suite"), root.join(name));
    let cancel = CancellationToken::new();
    let filter = Path::new(filter);
    let result = execute_with_tools(
        &deployment,
        &suite,
        filter,
        bundle,
        &directory,
        tools,
        &cancel,
    )
    .await;
    (result, directory)
}

fn reports(run: &Path) -> BTreeMap<String, PathBuf> {
    fs::read_dir(run.join("verifier/reports"))
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| !path.to_string_lossy().ends_with(".request.json"))
        .map(|path| {
            let report: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
            (report["target"].as_str().unwrap().into(), path)
        })
        .collect()
}

fn result(run: &Path) -> Value {
    serde_json::from_slice(&fs::read(run.join("result.json")).unwrap()).unwrap()
}

#[tokio::test]
#[ignore = "requires NEMOCLAW_TEST_BUNDLE; NEMOCLAW_HCL_TOFU may override OpenTofu; fixture observations, no Docker or inference"]
async fn shared_hcl_assertions_load_scenarios_from_disk_and_only_fail_on_outcome() {
    let root = tempfile::tempdir().unwrap();
    let root = root.path();
    suite(root);
    let mut tools = tools(root);
    let bundle = PathBuf::from(std::env::var_os("NEMOCLAW_TEST_BUNDLE").unwrap());
    tools.tofu = std::env::var_os("NEMOCLAW_HCL_TOFU")
        .map(PathBuf::from)
        .unwrap_or_else(|| Bundle::open(&bundle).unwrap().tofu());

    let (outcome, live) = run(root, &bundle, &tools, LIVE_TEST, "live").await;
    outcome.unwrap();
    assert_eq!(
        reports(&live).into_keys().collect::<Vec<_>>(),
        ["assistant"]
    );

    // A new scenario on disk, with two targets, reuses the live file's assertion.
    let scenario = fs::read_to_string(root.join("suite").join(LIVE_TEST)).unwrap();
    let (before, rest) = scenario.split_once("  variables {").unwrap();
    let (_, assertion) = rest.split_once("  assert {").unwrap();
    let targets = r#"  variables {
    targets = {
      followup   = { agent = "followup", request = "a new question from disk", response_pointer = "/output/response" }
      researcher = { agent = "researcher", request = "a second question", response_pointer = "/output/response" }
    }
  }
"#;
    let followup_test = "tests/followup.tftest.hcl";
    let scenario = format!("{before}{targets}  assert {{{assertion}");
    fs::write(root.join("suite").join(followup_test), scenario).unwrap();
    let (outcome, followup) = run(root, &bundle, &tools, followup_test, "followup").await;
    outcome.unwrap();
    let found = reports(&followup);
    assert_eq!(found.keys().collect::<Vec<_>>(), ["followup", "researcher"]);
    let request = fs::read(found["followup"].with_extension("request.json")).unwrap();
    let request: Value = serde_json::from_slice(&request).unwrap();
    assert_eq!(request, "a new question from disk");

    // Only the failing target is named, and cleanup still runs.
    tools
        .environment
        .insert("INVALID_TARGET".into(), "researcher".into());
    let (outcome, invalid) = run(root, &bundle, &tools, followup_test, "invalid").await;
    assert!(outcome.is_err());
    let output = fs::read_to_string(invalid.join("verifier/tofu-test.stdout")).unwrap();
    assert!(output.contains("outcome: researcher"), "{output}");
    let trace = fs::read_to_string(root.join("trace")).unwrap();
    let reapplied = "plan\napply\napply\ndestroy\n".repeat(2);
    assert_eq!(trace, format!("{reapplied}plan\napply\ndestroy\n"));
    for run in [&live, &followup, &invalid] {
        let sentinel = fs::read_to_string(run.join("deployment/sentinel")).unwrap();
        assert_eq!(sentinel, "product-state");
        let cleanup = &result(run)["cleanup"];
        assert_eq!(cleanup["succeeded"], true);
        assert_eq!(
            cleanup["retained"],
            json!(["openshell_gateway_storage.runtime"])
        );
    }
}

#[tokio::test]
async fn deployment_or_verification_failure_still_cleans_up_and_preserves_the_original_failure() {
    let failed = |step: &str| format!("{step}: command failed; inspect private evidence");
    let tofu = "plan\napply\ntofu-get\ntofu-test\n";
    let reapply = format!("{tofu}apply\n");
    let changed = "reapply: changed openshell_sandbox.assistant".to_owned();
    for (phase, steps, failure) in [
        ("apply", "plan\napply\n", failed("apply")),
        ("tofu-test", tofu, failed("tofu-test")),
        ("reapply", reapply.as_str(), changed),
    ] {
        let root = tempfile::tempdir().unwrap();
        let root = root.path();
        suite(root);
        let mut tools = tools(root);
        tools.environment.insert("FAIL_PHASE".into(), phase.into());
        tools.environment.insert("FAIL_CLEANUP".into(), "1".into());
        let (outcome, run) = run(root, root, &tools, LIVE_TEST, "run").await;
        assert!(outcome.is_err());
        let trace = fs::read_to_string(root.join("trace")).unwrap();
        assert_eq!(trace, format!("{steps}destroy\n"));
        let result = result(&run);
        assert_eq!(result["failed_phase"], phase);
        assert_eq!(result["failure"], failure);
        assert_eq!(result["cleanup"]["succeeded"], false);
        assert_eq!(result["cleanup"]["failure"], failed("destroy"));
    }
}
