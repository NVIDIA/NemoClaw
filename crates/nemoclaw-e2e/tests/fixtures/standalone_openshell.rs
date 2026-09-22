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
    fn deferred_endpoint(&self) {
        let source = fs::read_to_string(self.root.path().join("main.tf")).unwrap();
        fs::write(
            self.root.path().join("main.tf"),
            source.replace(
                "endpoint = var.endpoint",
                "endpoint = terraform_data.bootstrap.output",
            ) + "\nresource \"terraform_data\" \"bootstrap\" { input = var.endpoint }\n",
        )
        .unwrap();
    }
    fn apply(&self) {
        self.run(&["apply", "-auto-approve", "-input=false"], true);
    }
    fn registrations_only(&self) {
        let path = self.root.path().join("main.tf");
        let source = fs::read_to_string(&path).unwrap();
        let (registrations, _) = source
            .split_once("resource \"nemoclaw_sandbox\" \"agent\"")
            .unwrap();
        fs::write(
            path,
            registrations.replace("\"http://127.0.0.1:11434/v1\"", "var.inference_endpoint")
                + "\nvariable \"inference_endpoint\" { default = \"http://127.0.0.1:11434/v1\" }\n",
        )
        .unwrap();
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
async fn standalone_registrations_recreate_confirmed_absence_without_replacing_sandboxes() {
    let fixture = Fixture::start().await;
    let tofu = Standalone::new(&fixture.endpoint);
    tofu.apply();
    let sandbox = fixture.state.lock().unwrap().sandboxes.clone();
    for kind in ["provider", "provider_profile"] {
        {
            let mut state = fixture.state.lock().unwrap();
            if kind == "provider" {
                state.providers.clear();
            } else {
                state.profiles.clear();
            }
        }
        let effects = fixture.state.lock().unwrap().effects;
        tofu.run(&["plan", "-input=false", "-out=recover.plan"], true);
        assert_eq!(fixture.state.lock().unwrap().effects, effects);
        let plan: Value =
            serde_json::from_slice(&tofu.run(&["show", "-json", "recover.plan"], true).stdout)
                .unwrap();
        for change in plan["resource_changes"].as_array().unwrap() {
            assert_eq!(
                change["change"]["actions"],
                if change["type"] == format!("nemoclaw_{kind}") {
                    json!(["create"])
                } else {
                    json!(["no-op"])
                },
                "{change}"
            );
        }
        tofu.run(&["apply", "-input=false", "recover.plan"], true);
        tofu.noop();
        let state = fixture.state.lock().unwrap();
        assert_eq!(state.sandboxes, sandbox);
        assert_eq!(state.providers.len(), 1);
        assert_eq!(state.profiles.len(), 1);
        assert_eq!(state.effects, effects + 1);
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires explicit NEMOCLAW_TEST_TOFU and NEMOCLAW_TEST_PROVIDER; isolated OpenShell fixture"]
async fn standalone_registrations_replace_and_remove_without_destroy_mode() {
    let fixture = Fixture::start().await;
    let tofu = Standalone::new(&fixture.endpoint);
    tofu.registrations_only();
    tofu.apply();
    let before = fixture.state.lock().unwrap().providers.clone();
    let effects = fixture.state.lock().unwrap().effects;
    tofu.run(
        &[
            "plan",
            "-input=false",
            "-var=inference_endpoint=http://127.0.0.1:11435/v1",
            "-out=change.plan",
        ],
        true,
    );
    assert_eq!(fixture.state.lock().unwrap().effects, effects);
    let plan: Value =
        serde_json::from_slice(&tofu.run(&["show", "-json", "change.plan"], true).stdout).unwrap();
    for change in plan["resource_changes"].as_array().unwrap() {
        assert_eq!(
            change["change"]["actions"],
            match change["type"].as_str().unwrap() {
                "nemoclaw_provider_profile" => json!(["delete", "create"]),
                "nemoclaw_provider" => json!(["delete", "create"]),
                "nemoclaw_workspace" => json!(["no-op"]),
                other => panic!("unexpected resource {other}"),
            }
        );
    }
    tofu.run(&["apply", "-input=false", "change.plan"], true);
    {
        let state = fixture.state.lock().unwrap();
        let provider = state.providers.values().next().unwrap();
        assert_ne!(
            provider.metadata.as_ref().unwrap().id,
            before
                .values()
                .next()
                .unwrap()
                .metadata
                .as_ref()
                .unwrap()
                .id
        );
        assert_eq!(
            provider.config["OPENAI_BASE_URL"],
            "http://127.0.0.1:11435/v1"
        );
        assert_eq!(state.profiles.len(), 1);
    }
    tofu.run(
        &[
            "apply",
            "-auto-approve",
            "-input=false",
            "-var=enabled=false",
        ],
        true,
    );
    let state = fixture.state.lock().unwrap();
    assert_eq!(state.workspaces.len(), 1);
    assert!(state.providers.is_empty() && state.profiles.is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires explicit NEMOCLAW_TEST_TOFU and NEMOCLAW_TEST_PROVIDER; isolated OpenShell fixture"]
async fn standalone_registrations_preserve_bindings_on_failed_or_foreign_observations() {
    let fixture = Fixture::start().await;
    let tofu = Standalone::new(&fixture.endpoint);
    tofu.registrations_only();
    tofu.apply();
    let prior = tofu.state();
    let effects = fixture.state.lock().unwrap().effects;
    for kind in ["provider", "provider_profile"] {
        for code in [tonic::Code::Unavailable, tonic::Code::Unauthenticated] {
            fixture.state.lock().unwrap().fail_read = Some((kind, code));
            tofu.run(&["plan", "-input=false"], false);
            assert_eq!(tofu.state(), prior);
        }
    }
    {
        let mut state = fixture.state.lock().unwrap();
        state.fail_read = None;
        state
            .providers
            .values_mut()
            .next()
            .unwrap()
            .metadata
            .as_mut()
            .unwrap()
            .labels
            .insert("nemoclaw.nvidia.com/uid".into(), "foreign".into());
    }
    tofu.run(&["plan", "-input=false", "-var=enabled=false"], false);
    assert_eq!(tofu.state(), prior);
    assert_eq!(fixture.state.lock().unwrap().effects, effects);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires explicit NEMOCLAW_TEST_TOFU and NEMOCLAW_TEST_PROVIDER; isolated OpenShell fixture"]
async fn standalone_registrations_recover_lost_create_response_without_duplicate_creation() {
    let fixture = Fixture::start().await;
    let tofu = Standalone::new(&fixture.endpoint);
    tofu.registrations_only();
    fixture.state.lock().unwrap().lose_create = true;
    tofu.run(&["apply", "-auto-approve", "-input=false"], false);
    let profiles = fixture.state.lock().unwrap().profiles.clone();
    assert_eq!(profiles.len(), 1);
    assert!(fixture.state.lock().unwrap().providers.is_empty());
    let effects = fixture.state.lock().unwrap().effects;
    tofu.apply();
    tofu.noop();
    let state = fixture.state.lock().unwrap();
    assert_eq!(state.profiles, profiles);
    assert_eq!(state.providers.len(), 1);
    assert_eq!(state.effects, effects + 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires explicit NEMOCLAW_TEST_TOFU and NEMOCLAW_TEST_PROVIDER; isolated OpenShell fixture"]
async fn standalone_registration_authentication_mode_replaces_but_secret_reference_rotation_updates()
 {
    let fixture = Fixture::start().await;
    let tofu = Standalone::new(&fixture.endpoint);
    tofu.registrations_only();
    let path = tofu.root.path().join("main.tf");
    fs::write(
        &path,
        fs::read_to_string(&path)
            .unwrap()
            .replace(
                "authenticated = \"false\"",
                "authenticated = tostring(var.credential_env != \"\")",
            )
            .replace(
                "endpoint   = nemoclaw_provider_profile.inference[0].endpoint",
                "endpoint   = nemoclaw_provider_profile.inference[0].endpoint\n  credential_env = var.credential_env",
            )
            + "\nvariable \"credential_env\" { default = \"\" }\n",
    )
    .unwrap();
    tofu.apply();
    let id = || {
        fixture
            .state
            .lock()
            .unwrap()
            .providers
            .values()
            .next()
            .unwrap()
            .metadata
            .as_ref()
            .unwrap()
            .id
            .clone()
    };
    let anonymous_id = id();
    tofu.run(
        &[
            "apply",
            "-auto-approve",
            "-input=false",
            "-var=credential_env=NEMOCLAW_TEST_REGISTRATION_KEY",
        ],
        true,
    );
    let authenticated_id = id();
    assert_ne!(anonymous_id, authenticated_id);
    let profiles = fixture.state.lock().unwrap().profiles.clone();
    tofu.run(
        &[
            "apply",
            "-auto-approve",
            "-input=false",
            "-var=credential_env=NEMOCLAW_TEST_ROTATED_KEY",
        ],
        true,
    );
    assert_eq!(id(), authenticated_id);
    assert_eq!(fixture.state.lock().unwrap().profiles, profiles);
    tofu.apply();
    assert_ne!(id(), authenticated_id);
    tofu.noop();
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
    tofu.run(
        &[
            "plan",
            "-input=false",
            "-var=destroying=true",
            "-replace=nemoclaw_sandbox.agent[0]",
        ],
        false,
    );
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
async fn standalone_hcl_defers_provider_endpoint_until_bootstrap_apply() {
    let fixture = Fixture::start().await;
    let tofu = Standalone::new(&fixture.endpoint);
    tofu.deferred_endpoint();
    tofu.run(&["plan", "-input=false", "-out=bootstrap.plan"], true);
    assert_eq!(fixture.state.lock().unwrap().effects, 0);
    assert!(!tofu.root.path().join("terraform.tfstate").exists());
    tofu.run(&["apply", "-input=false", "bootstrap.plan"], true);
    tofu.noop();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires explicit NEMOCLAW_TEST_TOFU and NEMOCLAW_TEST_PROVIDER; isolated OpenShell fixture"]
async fn deferred_provider_rechecks_ownership_before_saved_plan_apply() {
    let fixture = Fixture::start().await;
    let tofu = Standalone::new(&fixture.endpoint);
    tofu.deferred_endpoint();
    tofu.run(&["plan", "-input=false", "-out=bootstrap.plan"], true);
    let foreign = Standalone::new(&fixture.endpoint);
    let path = foreign.root.path().join("main.tf");
    fs::write(
        &path,
        fs::read_to_string(&path)
            .unwrap()
            .replace("standalone-owner", "foreign-owner"),
    )
    .unwrap();
    foreign.apply();
    let effects = fixture.state.lock().unwrap().effects;
    tofu.run(&["apply", "-input=false", "bootstrap.plan"], false);
    assert_eq!(fixture.state.lock().unwrap().effects, effects);
    foreign.noop();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires explicit NEMOCLAW_TEST_TOFU and NEMOCLAW_TEST_PROVIDER; isolated OpenShell fixture"]
async fn deferred_provider_reports_apply_observation_failures_and_recovers() {
    let fixture = Fixture::start().await;
    fixture.state.lock().unwrap().fail_read = Some(("workspace", tonic::Code::Unavailable));
    let tofu = Standalone::new(&fixture.endpoint);
    tofu.deferred_endpoint();
    tofu.run(&["plan", "-input=false", "-out=bootstrap.plan"], true);
    tofu.run(&["apply", "-input=false", "bootstrap.plan"], false);
    assert_eq!(fixture.state.lock().unwrap().effects, 0);
    fixture.state.lock().unwrap().fail_read = None;
    tofu.apply();
    tofu.noop();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires explicit NEMOCLAW_TEST_TOFU and NEMOCLAW_TEST_PROVIDER; isolated OpenShell fixture"]
async fn deferred_provider_keeps_bindings_when_bootstrap_endpoint_changes() {
    let fixture = Fixture::start().await;
    let next = Fixture::start().await;
    let tofu = Standalone::new(&fixture.endpoint);
    tofu.deferred_endpoint();
    tofu.apply();
    let prior = tofu.state();
    let effects = fixture.state.lock().unwrap().effects;
    fs::write(
        tofu.root.path().join("terraform.tfvars.json"),
        json!({"endpoint":next.endpoint}).to_string(),
    )
    .unwrap();
    tofu.run(&["plan", "-input=false"], false);
    assert_eq!(tofu.state(), prior);
    assert_eq!(fixture.state.lock().unwrap().effects, effects);
    assert_eq!(next.state.lock().unwrap().effects, 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires explicit NEMOCLAW_TEST_TOFU and NEMOCLAW_TEST_PROVIDER; isolated OpenShell fixture"]
async fn unavailable_bound_gateway_blocks_bootstrap_replacement_before_apply() {
    let fixture = Fixture::start().await;
    let tofu = Standalone::new(&fixture.endpoint);
    tofu.deferred_endpoint();
    tofu.apply();
    let prior = tofu.state();
    let effects = fixture.state.lock().unwrap().effects;
    fixture.state.lock().unwrap().fail_read = Some(("workspace", tonic::Code::Unavailable));
    tofu.run(
        &[
            "apply",
            "-input=false",
            "-auto-approve",
            "-replace=terraform_data.bootstrap",
        ],
        false,
    );
    assert_eq!(tofu.state(), prior);
    assert_eq!(fixture.state.lock().unwrap().effects, effects);
    fixture.state.lock().unwrap().fail_read = None;
    tofu.noop();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires explicit NEMOCLAW_TEST_TOFU and NEMOCLAW_TEST_PROVIDER; isolated OpenShell fixture"]
async fn gateway_readiness_dependency_waits_for_startup_before_workspace_creation() {
    let fixture = Fixture::start().await;
    fixture.state.lock().unwrap().fail_read = Some(("gateway", tonic::Code::Unavailable));
    let tofu = Standalone::new(&fixture.endpoint);
    tofu.deferred_endpoint();
    let path = tofu.root.path().join("main.tf");
    let source = fs::read_to_string(&path).unwrap().replace(
        "resource \"nemoclaw_workspace\" \"example\" {",
        "resource \"nemoclaw_workspace\" \"example\" {\n depends_on = [data.nemoclaw_gateway_capabilities.ready]",
    );
    fs::write(
        path,
        source
            + r#"
 data "nemoclaw_gateway_capabilities" "ready" {
   required_compute_drivers = ["docker"]
   wait_timeout_seconds = 5
   depends_on = [terraform_data.bootstrap]
   lifecycle {
     postcondition {
       condition = self.compatible
       error_message = "Gateway does not support Docker."
     }
   }
 }
"#,
    )
    .unwrap();
    tofu.run(&["plan", "-input=false", "-out=ready.plan"], true);
    assert_eq!(fixture.state.lock().unwrap().gateway_reads, 0);
    let state = fixture.state.clone();
    let startup = tokio::spawn(async move {
        loop {
            {
                let mut state = state.lock().unwrap();
                if state.gateway_reads >= 2 {
                    assert_eq!(
                        state.effects, 0,
                        "resources created before gateway readiness"
                    );
                    state.fail_read = None;
                    break;
                }
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    });
    tofu.run(&["apply", "-input=false", "ready.plan"], true);
    startup.await.unwrap();
    tofu.noop();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires explicit NEMOCLAW_TEST_TOFU and NEMOCLAW_TEST_PROVIDER; isolated Pi fixture"]
async fn standalone_pi_configuration_updates_without_replacing_the_sandbox() {
    let fixture = Fixture::start().await;
    let tofu = Standalone::new(&fixture.endpoint);
    let source = fs::read_to_string(tofu.root.path().join("main.tf"))
        .unwrap()
        .replace("fabric-openclaw", "fabric-pi")
        .replace("      model       = \"fixture-model\"\n", "");
    fs::write(
        tofu.root.path().join("main.tf"),
        source
            + r#"
variable "model" { default = "first-model" }
resource "nemoclaw_pi_configuration" "agent" {
  count = var.enabled ? 1 : 0
  workspace = nemoclaw_sandbox.agent[0].workspace
  name = nemoclaw_sandbox.agent[0].name
  owner = nemoclaw_sandbox.agent[0].owner
  generation = nemoclaw_sandbox.agent[0].generation
  sandbox_id = nemoclaw_sandbox.agent[0].id
  model_json = jsonencode({ model = var.model })
}
"#,
    )
    .unwrap();
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
                    .get(2)
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
    fixture.state.lock().unwrap().pi_stopped = true;
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
    assert!(!fixture.state.lock().unwrap().pi_stopped);
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
    fixture.state.lock().unwrap().exec_truncated = true;
    tofu.run(&["apply", "-input=false", "ambiguous.plan"], false);
    assert_eq!(writes(), 4);
    fixture.state.lock().unwrap().exec_truncated = false;
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
    fixture.state.lock().unwrap().exec_truncated = false;
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

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires explicit NEMOCLAW_TEST_TOFU and NEMOCLAW_TEST_PROVIDER; isolated OpenShell fixture"]
async fn standalone_create_readback_rejects_substitution_and_retains_established_binding() {
    for field in [
        "id",
        "nemoclaw.nvidia.com/uid",
        "nemoclaw.nvidia.com/generation",
    ] {
        let fixture = Fixture::start().await;
        let tofu = Standalone::new(&fixture.endpoint);
        fixture
            .state
            .lock()
            .unwrap()
            .substitute_sandbox_after_create = Some((field, "substituted".into()));
        tofu.run(&["apply", "-auto-approve", "-input=false"], false);
        let effects = fixture.state.lock().unwrap().effects;
        let partial: Value = serde_json::from_slice(&tofu.state()).unwrap();
        let sandbox = partial["resources"]
            .as_array()
            .unwrap()
            .iter()
            .find(|resource| resource["type"] == "nemoclaw_sandbox")
            .expect("failed readback must preserve the create response binding");
        assert_eq!(
            sandbox["instances"][0]["attributes"]["id"],
            format!("id-{effects}")
        );
        assert_eq!(sandbox["instances"][0]["status"], "tainted");
        let prior = tofu.state();
        tofu.run(&["plan", "-input=false"], false);
        tofu.run(
            &[
                "apply",
                "-auto-approve",
                "-input=false",
                "-var=enabled=false",
                "-var=destroying=true",
            ],
            false,
        );
        assert_eq!(tofu.state(), prior);
        let state = fixture.state.lock().unwrap();
        assert_eq!(state.effects, effects);
        assert_eq!(state.delete_calls, 0);
        assert_eq!(state.sandboxes.len(), 1);
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires explicit NEMOCLAW_TEST_TOFU and NEMOCLAW_TEST_PROVIDER; isolated OpenShell fixture"]
async fn standalone_registrations_recover_after_absence_was_committed_by_refresh_only() {
    let fixture = Fixture::start().await;
    let tofu = Standalone::new(&fixture.endpoint);
    tofu.apply();
    let sandboxes = fixture.state.lock().unwrap().sandboxes.clone();
    fixture.state.lock().unwrap().providers.clear();
    let effects = fixture.state.lock().unwrap().effects;
    tofu.run(
        &["apply", "-refresh-only", "-auto-approve", "-input=false"],
        true,
    );
    tofu.run(&["plan", "-input=false", "-out=recover.plan"], true);
    let plan: Value =
        serde_json::from_slice(&tofu.run(&["show", "-json", "recover.plan"], true).stdout).unwrap();
    assert!(
        plan.get("resource_drift")
            .is_none_or(|drift| drift.as_array().unwrap().is_empty())
    );
    let registration = plan["resource_changes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|change| change["type"] == "nemoclaw_provider")
        .unwrap();
    assert_eq!(registration["change"]["actions"], json!(["create"]));
    assert_eq!(fixture.state.lock().unwrap().effects, effects);
    tofu.run(&["apply", "-input=false", "recover.plan"], true);
    tofu.noop();
    let state = fixture.state.lock().unwrap();
    assert_eq!(state.effects, effects + 1);
    assert_eq!(state.sandboxes, sandboxes);
    assert_eq!(state.providers.len(), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires explicit NEMOCLAW_TEST_TOFU and NEMOCLAW_TEST_PROVIDER; isolated OpenShell fixture"]
async fn standalone_lost_create_reply_requires_original_intent_to_recover_untracked_registration() {
    let fixture = Fixture::start().await;
    let tofu = Standalone::new(&fixture.endpoint);
    tofu.registrations_only();
    fixture.state.lock().unwrap().lose_create = true;
    tofu.run(&["apply", "-auto-approve", "-input=false"], false);
    let profiles = fixture.state.lock().unwrap().profiles.clone();
    assert_eq!(profiles.len(), 1);
    let effects = fixture.state.lock().unwrap().effects;
    // Core cannot refresh an identity it never received. Removing this intent
    // succeeds but leaves the remote profile untracked; the SDK must retain its
    // ambiguous-creation guard until the API supplies a stronger contract.
    tofu.run(
        &[
            "apply",
            "-auto-approve",
            "-input=false",
            "-var=enabled=false",
        ],
        true,
    );
    assert_eq!(fixture.state.lock().unwrap().profiles, profiles);
    assert_eq!(fixture.state.lock().unwrap().effects, effects);
    // Replaying the original declaration observes and verifies that profile.
    tofu.apply();
    tofu.noop();
    let state = fixture.state.lock().unwrap();
    assert_eq!(state.profiles, profiles);
    assert_eq!(state.effects, effects + 1);
}
