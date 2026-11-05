// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Pi agent commands that must fail, which `tofu test` cannot expect: a
//! rejected configuration, a lost start reply, an unobserved runtime, a
//! changed agent without a new sandbox, and a failed start.

use crate::*;

/// The Pi sandbox in `hcl/agent/main.tf`, run with OpenTofu's plan and apply
/// commands so a check can follow a failed one.
struct Standalone {
    root: TofuWorkspace,
}
impl Standalone {
    fn new(endpoint: &str) -> Self {
        let root = workspace();
        let fixtures = Path::new(HCL).join("agent");
        fs::copy(fixtures.join("main.tf"), root.path().join("main.tf")).unwrap();
        let mut variables: Value =
            serde_json::from_slice(&fs::read(fixtures.join("terraform.tfvars.json")).unwrap())
                .unwrap();
        variables["endpoint"] = json!(endpoint);
        variables["catalog_json"] = json!(catalog_json());
        fs::write(
            root.path().join("terraform.tfvars.json"),
            variables.to_string(),
        )
        .unwrap();
        Self { root }
    }
    fn run(&self, args: &[&str], success: bool) -> Output {
        let output = self
            .root
            .command()
            .args(args)
            .args(["-input=false", "-no-color"])
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
}

/// OpenTofu wraps diagnostic text.
fn diagnostic(output: &Output) -> String {
    String::from_utf8_lossy(&output.stderr)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// Runtime starts and stops the fake gateway received.
fn writes(fixture: &Fixture) -> usize {
    let state = fixture.state.lock().unwrap();
    let write = |command: &&Vec<String>| {
        command
            .get(1)
            .is_some_and(|operation| operation == "start" || operation == "stop")
    };
    state.exec_calls.iter().filter(write).count()
}

/// A rejected configuration, a lost start reply, and an unobserved runtime
/// each fail OpenTofu's command, which `tofu test` cannot expect.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires NEMOCLAW_TEST_BUNDLE; fake OpenShell gateway"]
async fn failed_pi_operations_change_nothing_they_did_not_report() {
    let fixture = Fixture::start().await;
    let tofu = Standalone::new(&fixture.endpoint);
    // A configuration Fabric rejects fails validation at its field, before
    // any sandbox call, and the message never repeats the rejected value.
    let rejected = diagnostic(&tofu.run(
        &[
            "plan",
            "-var=model=PRIVATE_SENTINEL",
            "-var=mode=PRIVATE_SENTINEL",
        ],
        false,
    ));
    assert!(rejected.contains("Invalid configuration"), "{rejected}");
    assert!(
        rejected.contains("at instructions.system.mode"),
        "{rejected}"
    );
    assert!(!rejected.contains("PRIVATE_SENTINEL"), "{rejected}");
    assert!(fixture.state.lock().unwrap().exec_calls.is_empty());
    tofu.run(&["apply", "-auto-approve"], true);
    assert_eq!(writes(&fixture), 1);
    // Lose the reply to a new agent's start. Apply fails without retrying and
    // the agent is left tainted. The runtime may have started, and another
    // start would run beside it: replacing the sandbox recovers.
    fixture.state.lock().unwrap().lose_start_reply = true;
    tofu.run(
        &["apply", "-auto-approve", "-var=model=second-model"],
        false,
    );
    assert_eq!(writes(&fixture), 3);
    tofu.run(
        &[
            "apply",
            "-auto-approve",
            "-var=model=second-model",
            "-replace=openshell_sandbox.agent[0]",
        ],
        true,
    );
    assert_eq!(
        writes(&fixture),
        4,
        "the replaced sandbox starts the agent once"
    );
    // Reading an agent checks its runtime. A check whose reply is cut off
    // leaves the agent unobserved, so the plan fails and changes nothing.
    let prior = tofu.state();
    fixture.state.lock().unwrap().exec_truncated = true;
    let unobserved = diagnostic(&tofu.run(&["plan", "-var=model=second-model"], false));
    assert!(
        unobserved.contains("observation is incomplete"),
        "{unobserved}"
    );
    assert_eq!(tofu.state(), prior);
    assert_eq!(writes(&fixture), 4);
}

/// Without a trigger that replaces its sandbox, a changed agent is refused
/// while planning, with the way to fix it, and nothing changes.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires NEMOCLAW_TEST_BUNDLE; fake OpenShell gateway"]
async fn a_changed_agent_without_a_new_sandbox_is_refused() {
    let fixture = Fixture::start().await;
    let tofu = Standalone::new(&fixture.endpoint);
    let main = tofu.root.path().join("main.tf");
    let source = fs::read_to_string(&main).unwrap();
    let trigger =
        "  lifecycle {\n    replace_triggered_by = [terraform_data.agent_configuration]\n  }\n";
    assert!(source.contains(trigger));
    fs::write(&main, source.replace(trigger, "")).unwrap();
    tofu.run(&["apply", "-auto-approve"], true);
    let effects = fixture.state.lock().unwrap().effects;
    let refused = diagnostic(&tofu.run(&["plan", "-var=model=second-model"], false));
    assert!(
        refused.contains("A changed agent needs a new sandbox"),
        "{refused}"
    );
    assert!(refused.contains("replace_triggered_by"), "{refused}");
    assert_eq!(fixture.state.lock().unwrap().effects, effects);
}

/// Fabric's own message about a failed start can repeat the harness's output,
/// so the diagnostic leaves it out and names the private file that keeps it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires NEMOCLAW_TEST_BUNDLE; fake OpenShell gateway"]
async fn a_failed_start_keeps_fabrics_message_in_a_private_file() {
    let fixture = Fixture::start().await;
    fixture.state.lock().unwrap().configuration_error = Some(json!({
        "error": {"stage": "start", "code": "start_failed", "message": "harness said PRIVATE_SENTINEL"}
    }));
    let tofu = Standalone::new(&fixture.endpoint);
    let diagnostics = tofu.root.path().join("diagnostics");
    let output = tofu
        .root
        .command()
        .args(["apply", "-auto-approve", "-input=false", "-no-color"])
        .env(nemoclaw_backend::DIAGNOSTICS_ENV, &diagnostics)
        .output()
        .unwrap();
    assert!(!output.status.success());
    let stderr = diagnostic(&output);
    assert!(stderr.contains("start_failed"), "{stderr}");
    assert!(!stderr.contains("PRIVATE_SENTINEL"), "{stderr}");
    let saved: Vec<PathBuf> = fs::read_dir(&diagnostics)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .collect();
    let [saved] = saved.as_slice() else {
        panic!("one message file: {saved:?}");
    };
    assert!(
        stderr.contains(&format!("Fabric's message is in {}", saved.display())),
        "{stderr}"
    );
    let message: Value = serde_json::from_slice(&fs::read(saved).unwrap()).unwrap();
    assert_eq!(
        message,
        json!({"stage": "start", "code": "start_failed", "effects": "unknown", "message": "harness said PRIVATE_SENTINEL"})
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(saved).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(
            fs::metadata(&diagnostics).unwrap().permissions().mode() & 0o777,
            0o700
        );
    }
}
