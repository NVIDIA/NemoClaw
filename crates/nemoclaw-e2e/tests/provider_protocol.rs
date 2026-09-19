// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use serde_json::{Value, json};
use std::{
    fs,
    path::PathBuf,
    process::{Command, Output},
};
use tempfile::TempDir;

struct Experiment {
    dir: TempDir,
    tofu: PathBuf,
}
impl Experiment {
    fn hardware_config(&self, invalid: bool) {
        use nemoclaw_sdk::{compile, config::Document};
        let document =
            Document::parse(include_bytes!("../../../examples/spark/vllm.yaml").as_slice())
                .unwrap();
        let generations = [
            ("managed_gateway".into(), "a".repeat(32)),
            ("inference_service".into(), "b".repeat(32)),
        ]
        .into();
        let target = compile::runtime_targets(&document, &generations)
            .unwrap()
            .into_iter()
            .find(|target| target.kind == "inference_service")
            .unwrap();
        let mut spec: Value = serde_json::from_str(&target.values["spec"]).unwrap();
        if invalid {
            let mut service: Value =
                serde_json::from_str(spec["process"]["configuration"].as_str().unwrap()).unwrap();
            service["hardware"] = json!({"profile":"h100"});
            spec["process"]["configuration"] = json!(service.to_string());
        }
        fs::write(self.dir.path().join("main.tf.json"), json!({
            "terraform":{"required_version":"= 1.12.6", "required_providers":{"nemoclaw":{"source":"registry.opentofu.org/nvidia/nemoclaw"}}},
            "provider":{"nemoclaw":{}},
            "resource":{"nemoclaw_inference_service":{"gpu":{"spec":spec.to_string().replace("${", "$${").replace("%{", "%%{")}}}
        }).to_string()).unwrap();
    }
    fn new() -> Self {
        let tofu = PathBuf::from(
            std::env::var_os("NEMOCLAW_TEST_TOFU")
                .expect("explicit pinned OpenTofu executable required"),
        );
        assert!(tofu.is_absolute());
        let this = Self {
            dir: tempfile::tempdir().unwrap(),
            tofu,
        };
        let provider = PathBuf::from(env!("CARGO_BIN_EXE_terraform-provider-nemoclaw-fixture"));
        // The fixture binary is this test package's own target. Production
        // bundles will be supplied explicitly for SDK/CLI lifecycle tests.
        fs::copy(
            provider,
            this.dir.path().join(nemoclaw_sdk::bundle::executable(
                "terraform-provider-nemoclaw",
            )),
        )
        .unwrap();
        fs::write(this.dir.path().join("tofu.rc"), format!("provider_installation {{ dev_overrides {{ \"registry.opentofu.org/nvidia/nemoclaw\" = {} }} direct {{}} }}", serde_json::to_string(this.dir.path().to_str().unwrap()).unwrap())).unwrap();
        this.config("https://initial.example/v1");
        this.mode("normal");
        this
    }
    fn config(&self, endpoint: &str) {
        fs::write(self.dir.path().join("main.tf.json"), json!({
            "terraform": {"required_version":"= 1.12.6", "required_providers":{"nemoclaw":{"source":"registry.opentofu.org/nvidia/nemoclaw"}}},
            "provider":{"nemoclaw":{}},
            "resource":{"nemoclaw_provider":{"inference":{"name":"inference", "owner":"deployment", "generation":"generation", "endpoint":endpoint}}}
        }).to_string()).unwrap();
    }
    fn mode(&self, mode: &str) {
        fs::write(self.dir.path().join("mode"), mode).unwrap();
    }
    fn run(&self, args: &[&str]) -> Output {
        Command::new(&self.tofu)
            .args(args)
            .current_dir(self.dir.path())
            .env("TF_CLI_CONFIG_FILE", self.dir.path().join("tofu.rc"))
            .env("TF_IN_AUTOMATION", "1")
            .env("CHECKPOINT_DISABLE", "1")
            .env("NEMOCLAW_FIXTURE_DIR", self.dir.path())
            .output()
            .unwrap()
    }
    fn success(&self, args: &[&str]) -> Output {
        let output = self.run(args);
        assert!(
            output.status.success(),
            "{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        output
    }
    fn state(&self) -> Value {
        serde_json::from_slice(&fs::read(self.dir.path().join("terraform.tfstate")).unwrap())
            .unwrap()
    }
    fn plan(&self) -> Value {
        self.success(&["plan", "-input=false", "-out=plan"]);
        serde_json::from_slice(&self.success(&["show", "-json", "plan"]).stdout).unwrap()
    }
}

#[test]
#[ignore = "requires explicit NEMOCLAW_TEST_TOFU; no live services"]
fn real_tofu_checks_hardware_during_validation_planning_and_saved_plan_apply() {
    let e = Experiment::new();
    e.hardware_config(true);
    let result = e.run(&["validate", "-json"]);
    assert!(!result.status.success());
    let validation: Value = serde_json::from_slice(&result.stdout).unwrap();
    assert!(
        validation["diagnostics"]
            .as_array()
            .unwrap()
            .iter()
            .any(|d| d["summary"] == "Invalid resource specification"
                && d["detail"].as_str().unwrap().contains("architecture")),
        "{validation}"
    );
    e.hardware_config(false);
    e.success(&["validate"]);
    for mode in ["old-driver", "capacity-unavailable"] {
        e.mode(mode);
        let result = e.run(&["plan", "-input=false"]);
        assert!(!result.status.success());
        let diagnostic = String::from_utf8_lossy(&result.stderr);
        assert!(
            diagnostic.contains("Resource planning failed"),
            "{diagnostic}"
        );
        assert!(
            diagnostic.contains(if mode == "old-driver" {
                "observed 570"
            } else {
                "observation transport failed"
            }),
            "{diagnostic}"
        );
        assert!(!e.dir.path().join("resource.json").exists());
    }
    e.mode("normal");
    e.success(&["plan", "-input=false", "-out=hardware.plan"]);
    e.mode("old-driver");
    let result = e.run(&["apply", "-input=false", "hardware.plan"]);
    assert!(!result.status.success());
    assert!(String::from_utf8_lossy(&result.stderr).contains("observed 570"));
    assert!(
        !e.dir.path().join("resource.json").exists(),
        "saved plan bypassed current hardware validation"
    );
    e.mode("normal");
    e.success(&["apply", "-auto-approve", "-input=false"]);
    let prior = e.state();
    e.mode("old-driver");
    assert!(!e.run(&["plan", "-input=false"]).status.success());
    assert_eq!(
        e.state(),
        prior,
        "failed capacity observation changed existing bindings"
    );
}

#[test]
#[ignore = "requires explicit NEMOCLAW_TEST_TOFU; no live services"]
fn real_tofu_preserves_failed_observations_and_distinguishes_absence_from_drift() {
    let e = Experiment::new();
    e.success(&["apply", "-auto-approve", "-input=false"]);
    let original = e.state();
    assert_eq!(
        original["resources"][0]["instances"][0]["attributes"]["id"],
        "fixture-id"
    );
    assert_eq!(
        e.plan()["resource_changes"][0]["change"]["actions"],
        json!(["no-op"])
    );
    for mode in ["read-error", "partial", "foreign"] {
        e.mode(mode);
        let output = e.run(&["plan", "-input=false"]);
        assert!(!output.status.success());
        assert!(String::from_utf8_lossy(&output.stderr).contains("Resource observation"));
        assert_eq!(e.state(), original);
    }
    e.mode("normal");
    let mut observed: Value =
        serde_json::from_slice(&fs::read(e.dir.path().join("resource.json")).unwrap()).unwrap();
    observed["endpoint"] = json!("https://drift.example/v1");
    fs::write(e.dir.path().join("resource.json"), observed.to_string()).unwrap();
    assert_eq!(
        e.plan()["resource_changes"][0]["change"]["actions"],
        json!(["update"])
    );
    e.mode("absent");
    assert_eq!(
        e.plan()["resource_changes"][0]["change"]["actions"],
        json!(["create"])
    );
    assert_eq!(e.state(), original, "plan must not persist refreshed state");
}

#[test]
#[ignore = "requires explicit NEMOCLAW_TEST_TOFU; no live services"]
fn real_tofu_retains_identity_after_creation_reports_a_later_failure() {
    let e = Experiment::new();
    e.mode("create-error");
    let output = e.run(&["apply", "-auto-approve", "-input=false"]);
    assert!(!output.status.success());
    assert_eq!(
        e.state()["resources"][0]["instances"][0]["attributes"]["id"],
        "fixture-id"
    );
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires explicit NEMOCLAW_TEST_TOFU and NEMOCLAW_TEST_PROVIDER; isolated Docker fixture"]
async fn production_provider_rechecks_network_and_image_prerequisites_before_saved_plan_apply() {
    use nemoclaw_sdk::{compile, config::Document};
    use std::sync::{Arc, Mutex};

    let provider = PathBuf::from(
        std::env::var_os("NEMOCLAW_TEST_PROVIDER").expect("explicit production provider required"),
    );
    assert!(provider.is_absolute());
    let mode = Arc::new(Mutex::new("normal"));
    let shared = mode.clone();
    let fixture = nemoclaw_e2e::docker::Fixture::start(move |request| {
        assert_eq!(request.method, "GET", "planning or rejected apply mutated Docker");
        let mode = *shared.lock().unwrap();
        let response = match request.path.split('?').next().unwrap() {
            "/info" => (200, json!({"ID":"engine", "Architecture":"x86_64"})),
            "/networks" => (200, if mode == "overlap" {
                json!([{"IPAM":{"Config":[{"Subnet":"172.30.121.0/24"}]}}])
            } else { json!([]) }),
            path if path.starts_with("/networks/") => (404, json!({})),
            path if path.starts_with("/images/") => {
                if mode == "missing-image" {
                    (404, json!({}))
                } else {
                    (200, json!({"Id":"sha256:gateway", "Os":"linux", "Architecture":if mode == "wrong-architecture" { "arm64" } else { "amd64" }}))
                }
            }
            _ => panic!("unexpected prerequisite observation {}", request.path),
        };
        Some((response.0, serde_json::to_vec(&response.1).unwrap()))
    }).await;
    let e = Experiment::new();
    fs::copy(
        provider,
        e.dir.path().join(nemoclaw_sdk::bundle::executable(
            "terraform-provider-nemoclaw",
        )),
    )
    .unwrap();
    let document =
        Document::parse(include_bytes!("../../../examples/spark/vllm.yaml").as_slice()).unwrap();
    let generations = [
        ("managed_gateway".into(), "a".repeat(32)),
        ("inference_service".into(), "b".repeat(32)),
    ]
    .into();
    let target = compile::runtime_targets(&document, &generations)
        .unwrap()
        .into_iter()
        .find(|target| target.kind == "managed_gateway")
        .unwrap();
    let mut spec: Value = serde_json::from_str(&target.values["spec"]).unwrap();
    spec["gateway"]["engine"] = json!(fixture.endpoint);
    let configure = |policy: &str| {
        fs::write(e.dir.path().join("main.tf.json"), json!({
            "terraform":{"required_version":"= 1.12.6", "required_providers":{"nemoclaw":{"source":"registry.opentofu.org/nvidia/nemoclaw"}}},
            "provider":{"nemoclaw":{"endpoint":"http://127.0.0.1:1"}},
            "resource":{"nemoclaw_managed_gateway":{"gateway":{"spec":spec.to_string(), "image_pull_policy":policy}}}
        }).to_string()).unwrap();
    };
    configure("Never");
    e.success(&["validate"]);
    for (failure, expected) in [
        ("overlap", "subnet overlaps"),
        (
            "wrong-architecture",
            "incompatible with the execution target",
        ),
        ("missing-image", "image is absent"),
    ] {
        *mode.lock().unwrap() = failure;
        let output = e.run(&["plan", "-input=false"]);
        assert!(!output.status.success());
        assert!(
            String::from_utf8_lossy(&output.stderr).contains(expected),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        *mode.lock().unwrap() = "normal";
        e.success(&["plan", "-input=false", "-out=prerequisites.plan"]);
        *mode.lock().unwrap() = failure;
        let output = e.run(&["apply", "-input=false", "prerequisites.plan"]);
        assert!(!output.status.success());
        assert!(
            String::from_utf8_lossy(&output.stderr).contains(expected),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    for policy in ["Always", "IfNotPresent"] {
        configure(policy);
        *mode.lock().unwrap() = "missing-image";
        e.success(&["plan", "-input=false"]);
    }
}
