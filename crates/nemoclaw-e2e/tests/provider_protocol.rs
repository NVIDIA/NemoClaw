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
