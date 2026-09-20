// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use super::*;

struct Standalone {
    root: tempfile::TempDir,
    tofu: PathBuf,
}
impl Standalone {
    fn new(endpoint: &str) -> Self {
        let root = tempfile::tempdir().unwrap();
        let tofu =
            PathBuf::from(std::env::var_os("NEMOCLAW_TEST_TOFU").expect("explicit OpenTofu"));
        let provider =
            PathBuf::from(std::env::var_os("NEMOCLAW_TEST_PROVIDER").expect("explicit provider"));
        assert!(tofu.is_absolute() && provider.is_absolute());
        fs::copy(
            provider,
            root.path().join(nemoclaw_sdk::bundle::executable(
                "terraform-provider-nemoclaw",
            )),
        )
        .unwrap();
        fs::write(root.path().join("tofu.rc"), format!("provider_installation {{ dev_overrides {{ \"registry.opentofu.org/nvidia/nemoclaw\" = {} }} direct {{}} }}", serde_json::to_string(root.path()).unwrap())).unwrap();
        fs::write(
            root.path().join("main.tf"),
            include_str!("openshell_resources.tf"),
        )
        .unwrap();
        fs::write(
            root.path().join("terraform.tfvars.json"),
            json!({"endpoint":endpoint}).to_string(),
        )
        .unwrap();
        Self { root, tofu }
    }
    fn run(&self, args: &[&str], success: bool) -> Output {
        let output = Command::new(&self.tofu)
            .args(args)
            .arg("-no-color")
            .current_dir(self.root.path())
            .env("TF_CLI_CONFIG_FILE", self.root.path().join("tofu.rc"))
            .env("CHECKPOINT_DISABLE", "1")
            .env("TF_IN_AUTOMATION", "1")
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
#[ignore = "requires explicit NEMOCLAW_TEST_TOFU and NEMOCLAW_TEST_PROVIDER; isolated OpenShell fixture"]
async fn standalone_hcl_applies_resources_without_sdk_encoding_or_coordination() {
    let fixture = Fixture::start().await;
    let tofu = Standalone::new(&fixture.endpoint);
    tofu.run(&["plan", "-input=false"], true);
    assert_eq!(fixture.state.lock().unwrap().effects, 0);
    tofu.apply();
    tofu.noop();
    let state = fixture.state.lock().unwrap();
    assert_eq!(
        (
            state.workspaces.len(),
            state.profiles.len(),
            state.providers.len(),
            state.sandboxes.len()
        ),
        (1, 1, 1, 1)
    );
    let sandbox = state.sandboxes.values().next().unwrap();
    assert_eq!(sandbox.spec.as_ref().unwrap().providers, vec!["local"]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires explicit NEMOCLAW_TEST_TOFU and NEMOCLAW_TEST_PROVIDER; isolated OpenShell fixture"]
async fn standalone_hcl_recovers_partial_creation_after_untaint_and_retains_workspace() {
    let fixture = Fixture::start().await;
    let tofu = Standalone::new(&fixture.endpoint);
    fixture.state.lock().unwrap().fail_after_create = Some(("sandbox", tonic::Code::Unavailable));
    tofu.run(&["apply", "-auto-approve", "-input=false"], false);
    let effects = fixture.state.lock().unwrap().effects;
    assert_eq!(fixture.state.lock().unwrap().sandboxes.len(), 1);
    let partial: Value = serde_json::from_slice(&tofu.state()).unwrap();
    assert!(
        partial["resources"]
            .as_array()
            .unwrap()
            .iter()
            .any(|resource| {
                resource["type"] == "nemoclaw_sandbox"
                    && resource["instances"][0]["attributes"]["id"]
                        .as_str()
                        .is_some_and(|id| !id.is_empty())
            })
    );
    fixture.state.lock().unwrap().fail_read = None;
    // A failed create with an established ID is tainted by OpenTofu. Refresh
    // verifies that binding before the operator explicitly clears the taint.
    tofu.run(
        &["apply", "-refresh-only", "-auto-approve", "-input=false"],
        true,
    );
    tofu.run(&["untaint", "nemoclaw_sandbox.agent[0]"], true);
    tofu.apply();
    tofu.noop();
    assert_eq!(fixture.state.lock().unwrap().effects, effects);
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
    let state = fixture.state.lock().unwrap();
    assert_eq!(
        (
            state.workspaces.len(),
            state.profiles.len(),
            state.providers.len(),
            state.sandboxes.len()
        ),
        (1, 0, 0, 0)
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires explicit NEMOCLAW_TEST_TOFU and NEMOCLAW_TEST_PROVIDER; isolated OpenShell fixture"]
async fn standalone_hcl_rejects_missing_bound_resources_before_recreation() {
    let fixture = Fixture::start().await;
    let tofu = Standalone::new(&fixture.endpoint);
    tofu.apply();
    let prior = tofu.state();
    fixture.state.lock().unwrap().sandboxes.clear();
    let effects = fixture.state.lock().unwrap().effects;
    tofu.run(&["plan", "-input=false"], false);
    assert_eq!(tofu.state(), prior);
    assert_eq!(fixture.state.lock().unwrap().effects, effects);
    // Explicit teardown can account for confirmed absence.
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
    assert_eq!(fixture.state.lock().unwrap().workspaces.len(), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires explicit NEMOCLAW_TEST_TOFU and NEMOCLAW_TEST_PROVIDER; isolated OpenShell fixture"]
async fn standalone_hcl_rejects_replacement_and_unauthorized_removal_during_plan() {
    let fixture = Fixture::start().await;
    let tofu = Standalone::new(&fixture.endpoint);
    tofu.apply();
    let prior = tofu.state();
    let effects = fixture.state.lock().unwrap().effects;
    tofu.run(&["plan", "-input=false", "-var=image=fixture@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"], false);
    tofu.run(&["plan", "-input=false", "-var=enabled=false"], false);
    assert_eq!(tofu.state(), prior);
    let state = fixture.state.lock().unwrap();
    assert_eq!(state.effects, effects);
    assert_eq!(state.delete_calls, 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires explicit NEMOCLAW_TEST_TOFU and NEMOCLAW_TEST_PROVIDER; isolated OpenShell fixture"]
async fn standalone_hcl_preserves_state_on_failed_observation_and_foreign_identity() {
    let fixture = Fixture::start().await;
    let tofu = Standalone::new(&fixture.endpoint);
    tofu.apply();
    let prior = tofu.state();
    let effects = fixture.state.lock().unwrap().effects;
    for code in [tonic::Code::Unavailable, tonic::Code::Unauthenticated] {
        fixture.state.lock().unwrap().fail_read = Some(("sandbox", code));
        let output = tofu.run(&["plan", "-input=false"], false);
        assert!(!String::from_utf8_lossy(&output.stderr).contains("secret-sentinel"));
        assert_eq!(tofu.state(), prior);
    }
    fixture.state.lock().unwrap().fail_read = None;
    let original = fixture.state.lock().unwrap().sandboxes.clone();
    for field in [
        "id",
        "nemoclaw.nvidia.com/uid",
        "nemoclaw.nvidia.com/generation",
    ] {
        {
            let mut state = fixture.state.lock().unwrap();
            state.sandboxes = original.clone();
            let metadata = state
                .sandboxes
                .values_mut()
                .next()
                .unwrap()
                .metadata
                .as_mut()
                .unwrap();
            if field == "id" {
                metadata.id = "substituted".into();
            } else {
                metadata.labels.insert(field.into(), "foreign".into());
            }
        }
        tofu.run(&["plan", "-input=false"], false);
        assert_eq!(tofu.state(), prior);
    }
    assert_eq!(fixture.state.lock().unwrap().effects, effects);
    assert_eq!(fixture.state.lock().unwrap().delete_calls, 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires explicit NEMOCLAW_TEST_TOFU and NEMOCLAW_TEST_PROVIDER; isolated OpenShell fixture"]
async fn standalone_hcl_recovers_lost_delete_response_without_repeating_the_mutation() {
    let fixture = Fixture::start().await;
    let tofu = Standalone::new(&fixture.endpoint);
    tofu.apply();
    fixture.state.lock().unwrap().lose_delete = true;
    let args = [
        "apply",
        "-auto-approve",
        "-input=false",
        "-var=enabled=false",
        "-var=destroying=true",
    ];
    tofu.run(&args, false);
    assert!(fixture.state.lock().unwrap().sandboxes.is_empty());
    assert_eq!(fixture.state.lock().unwrap().delete_calls, 1);
    let partial: Value = serde_json::from_slice(&tofu.state()).unwrap();
    // The sandbox deletion succeeded. The provider deletion lost its reply;
    // OpenTofu must retain that provider binding until absence is confirmed.
    assert!(
        partial["resources"]
            .as_array()
            .unwrap()
            .iter()
            .any(|resource| resource["type"] == "nemoclaw_provider")
    );
    tofu.run(&args, true);
    let state = fixture.state.lock().unwrap();
    assert_eq!(state.delete_calls, 1);
    assert_eq!(
        (
            state.workspaces.len(),
            state.profiles.len(),
            state.providers.len(),
            state.sandboxes.len()
        ),
        (1, 0, 0, 0)
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires explicit NEMOCLAW_TEST_TOFU and NEMOCLAW_TEST_PROVIDER; isolated OpenShell fixture"]
async fn standalone_hcl_requires_provider_endpoint_before_bootstrap_planning() {
    let fixture = Fixture::start().await;
    let tofu = Standalone::new(&fixture.endpoint);
    let source = fs::read_to_string(tofu.root.path().join("main.tf")).unwrap();
    fs::write(
        tofu.root.path().join("main.tf"),
        source.replace(
            "endpoint = var.endpoint",
            "endpoint = terraform_data.bootstrap.output",
        ) + "\nresource \"terraform_data\" \"bootstrap\" { input = var.endpoint }\n",
    )
    .unwrap();
    let output = tofu.run(&["plan", "-input=false"], false);
    assert!(String::from_utf8_lossy(&output.stderr).contains("Gateway connection"));
    assert_eq!(fixture.state.lock().unwrap().effects, 0);
    assert!(!tofu.root.path().join("terraform.tfstate").exists());
    // Once bootstrap has established the endpoint, the same graph can plan
    // and apply. This is evidence for staging with the current provider.
    tofu.run(
        &[
            "apply",
            "-auto-approve",
            "-input=false",
            "-target=terraform_data.bootstrap",
        ],
        true,
    );
    tofu.apply();
    tofu.noop();
}
