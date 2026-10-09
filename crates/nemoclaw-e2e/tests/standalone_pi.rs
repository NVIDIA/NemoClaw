// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Pi configuration through the openshell and fabric providers together.
//! The fabric provider's contract tests will own this.

use nemoclaw_e2e::tofu::TofuWorkspace;
use nemoclaw_test_fixtures::openshell::Fixture;
use serde_json::{Value, json};
use std::{fs, path::PathBuf, process::Output};

struct Standalone {
    root: TofuWorkspace,
}
impl Standalone {
    fn new(endpoint: &str) -> Self {
        let tofu =
            PathBuf::from(std::env::var_os("NEMOCLAW_TEST_TOFU").expect("explicit OpenTofu"));
        let provider =
            PathBuf::from(std::env::var_os("NEMOCLAW_TEST_PROVIDER").expect("explicit provider"));
        assert!(tofu.is_absolute() && provider.is_absolute());
        let root = TofuWorkspace::new(tofu, provider);
        let runtime = nemoclaw_e2e::image_runtime::binding("nvidia.fabric.pi");
        let mut document = nemoclaw_sdk::config::Document::parse(
            include_str!("../../nemoclaw-sdk/tests/fixtures/config/local.yaml").as_bytes(),
        )
        .unwrap();
        document.spec.inference_providers[0].endpoint = "http://127.0.0.1:11434/v1".into();
        let policy =
            nemoclaw_sdk::image_runtime::policy_input(&document, &document.spec.sandboxes[0])
                .unwrap();
        // Write the policy as an author would: a typed block, not JSON.
        let input = nemoclaw_openshell::structured_inputs("sandbox")
            .into_iter()
            .find(|input| input.attribute == "policy")
            .unwrap();
        let nemoclaw_tofu::shape::Shape::Object(fields) = &input.shape else {
            unreachable!("the policy is a block")
        };
        let policy = input
            .configuration(&serde_json::to_string(&policy).unwrap())
            .unwrap();
        fs::write(
            root.path().join("main.tf"),
            include_str!("fixtures/openshell_resources.tf").replace(
                "@POLICY@\n",
                &nemoclaw_e2e::hcl::block("policy", fields, &policy, 2),
            ),
        )
        .unwrap();
        fs::write(
            root.path().join("terraform.tfvars.json"),
            json!({
                "endpoint": endpoint,
                "runtime_json": serde_json::to_string(&runtime).unwrap(),
                "binaries": runtime.binaries(),
            })
            .to_string(),
        )
        .unwrap();
        Self { root }
    }
    fn run(&self, args: &[&str], success: bool) -> Output {
        let output = self
            .root
            .command()
            .args(args)
            .arg("-no-color")
            .env("NEMOCLAW_TEST_REGISTRATION_KEY", "fixture-secret")
            .env("NEMOCLAW_TEST_ROTATED_KEY", "rotated-fixture-secret")
            .output()
            .unwrap();
        assert_eq!(
            output.status.success(),
            success,
            "{args:?}\n{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        output
    }
    fn state(&self) -> Vec<u8> {
        fs::read(self.root.path().join("terraform.tfstate")).unwrap()
    }
    fn apply(&self) {
        self.run(&["apply", "-auto-approve", "-input=false"], true);
    }
    fn noop(&self) {
        self.run(&["plan", "-input=false", "-out=noop.plan"], true);
        let output = self.run(&["show", "-json", "noop.plan"], true);
        let plan: Value = serde_json::from_slice(&output.stdout).unwrap();
        for change in plan["resource_changes"].as_array().unwrap() {
            assert_eq!(change["change"]["actions"], json!(["no-op"]));
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires NEMOCLAW_TEST_TOFU and NEMOCLAW_TEST_PROVIDER; isolated Pi fixture"]
async fn standalone_pi_configuration_updates_without_replacing_the_sandbox() {
    let fixture = Fixture::start().await;
    let tofu = Standalone::new(&fixture.endpoint);
    let source = fs::read_to_string(tofu.root.path().join("main.tf")).unwrap();
    fs::write(
        tofu.root.path().join("main.tf"),
        source
            + r#"
variable "model" { default = "first-model" }
variable "adapter" {
  type    = any
  default = "nvidia.fabric.pi"
}
resource "fabric_agent_configuration" "agent" {
  count = var.enabled ? 1 : 0
  workspace = openshell_sandbox.agent[0].workspace
  name = openshell_sandbox.agent[0].name
  owner = openshell_sandbox.agent[0].owner
  generation = openshell_sandbox.agent[0].generation
  sandbox_id = openshell_sandbox.agent[0].id
  config_json = jsonencode({ schema_version = "fabric.agent/v1alpha1", runtime = {}, metadata = { name = "assistant" }, harness = { adapter_id = var.adapter }, models = { default = { provider = "openai", model = var.model } } })
}
"#,
    )
    .unwrap();
    // A configuration Fabric rejects fails validation at its field, before
    // any sandbox call, and the message never repeats the rejected value.
    let rejected = tofu.run(
        &[
            "plan",
            "-input=false",
            "-var=model=PRIVATE_SENTINEL",
            r#"-var=adapter=["PRIVATE_SENTINEL"]"#,
        ],
        false,
    );
    let stderr = String::from_utf8_lossy(&rejected.stderr);
    assert!(stderr.contains("Invalid config_json"), "{stderr}");
    assert!(stderr.contains("at harness.adapter_id"), "{stderr}");
    assert!(!stderr.contains("PRIVATE_SENTINEL"), "{stderr}");
    assert!(fixture.state.lock().unwrap().exec_calls.is_empty());
    tofu.run(&["plan", "-input=false"], true);
    assert!(fixture.state.lock().unwrap().exec_calls.is_empty());
    tofu.apply();
    let effects = fixture.state.lock().unwrap().effects;
    let writes = || {
        fixture
            .state
            .lock()
            .unwrap()
            .exec_calls
            .iter()
            .filter(|command| {
                command
                    .get(1)
                    .is_some_and(|arg| arg == "configure" || arg == "prepare")
            })
            .count()
    };
    assert_eq!(writes(), 1);
    tofu.noop();
    assert_eq!(writes(), 1, "no-op must not reconfigure Pi");
    tofu.run(
        &[
            "plan",
            "-input=false",
            "-var=model=second-model",
            "-out=change.plan",
        ],
        true,
    );
    assert_eq!(writes(), 1, "plan must not configure Pi");
    tofu.run(&["apply", "-input=false", "change.plan"], true);
    assert_eq!(writes(), 2);
    assert_eq!(fixture.state.lock().unwrap().effects, effects);
    // A stopped host is observed as drift; explicit apply reconfigures it.
    let sandbox_id = fixture
        .state
        .lock()
        .unwrap()
        .sandboxes
        .values()
        .next()
        .unwrap()
        .metadata
        .as_ref()
        .unwrap()
        .id
        .clone();
    fixture
        .state
        .lock()
        .unwrap()
        .fabric_stopped
        .insert(sandbox_id.clone());
    tofu.run(
        &[
            "apply",
            "-auto-approve",
            "-input=false",
            "-var=model=second-model",
        ],
        true,
    );
    assert_eq!(writes(), 3);
    assert!(
        !fixture
            .state
            .lock()
            .unwrap()
            .fabric_stopped
            .contains(&sandbox_id)
    );
    // Lose the exec response after the host accepted a configuration. Never
    // retry the mutation automatically; the next refresh observes the outcome.
    tofu.run(
        &[
            "plan",
            "-input=false",
            "-var=model=third-model",
            "-out=ambiguous.plan",
        ],
        true,
    );
    fixture.state.lock().unwrap().lose_configure_reply = true;
    tofu.run(&["apply", "-input=false", "ambiguous.plan"], false);
    assert_eq!(writes(), 4);
    assert!(!fixture.state.lock().unwrap().lose_configure_reply);
    tofu.run(
        &[
            "apply",
            "-auto-approve",
            "-input=false",
            "-var=model=third-model",
        ],
        true,
    );
    assert_eq!(
        writes(),
        4,
        "confirmed configuration must not be written again"
    );
    let prior = tofu.state();
    fixture.state.lock().unwrap().exec_truncated = true;
    tofu.run(&["plan", "-input=false", "-var=model=second-model"], false);
    assert_eq!(tofu.state(), prior);
    assert_eq!(writes(), 4);
    assert!(!fixture.state.lock().unwrap().lose_configure_reply);
    tofu.run(
        &[
            "apply",
            "-auto-approve",
            "-input=false",
            "-var=enabled=false",
            "-var=destroying=true",
        ],
        true,
    );
    assert!(fixture.state.lock().unwrap().sandboxes.is_empty());
    assert_eq!(writes(), 4, "destroy must not reconfigure Pi");
}
