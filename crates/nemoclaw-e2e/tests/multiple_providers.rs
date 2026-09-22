// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use nemoclaw_e2e::openshell::Fixture;
use nemoclaw_sdk::{CancellationToken, Deployment, config::Document, openshell::Secrets};
use std::{fs, path::PathBuf, process::Command, sync::Arc};

struct FixtureCredential;
impl Secrets for FixtureCredential {
    fn resolve(&self, name: &str) -> Result<String, nemoclaw_sdk::ObservationError> {
        assert_eq!(name, "HOSTED_API_KEY");
        Ok("owned-hosted-fixture-value".into())
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires explicit verified NEMOCLAW_TEST_BUNDLE; isolated API fixture, no live inference"]
async fn provider_union_export_reapply_drift_and_destroy_remain_scoped_to_each_sandbox() {
    let bundle = PathBuf::from(std::env::var_os("NEMOCLAW_TEST_BUNDLE").unwrap());
    let fixture = Fixture::start().await;
    let mut first =
        Document::parse(include_str!("../../../examples/multiple-providers.yaml").as_bytes())
            .unwrap();
    *first.spec.gateway.endpoint_mut() = fixture.endpoint.clone();
    let mut second = first.clone();
    second.metadata.uid = "7db61f79-1965-45ac-824a-1c3f3b26aa5d".into();
    second.spec.sandboxes.remove(0);
    assert_eq!(second.credential_names(), Vec::<&str>::new());
    let first_state = tempfile::tempdir().unwrap();
    let second_state = tempfile::tempdir().unwrap();
    let deployment =
        Deployment::new(first_state.path(), &bundle).with_secrets(Arc::new(FixtureCredential));
    let other = Deployment::new(second_state.path(), &bundle);
    let cancel = CancellationToken::new();
    deployment.apply(&first, &cancel).await.unwrap();
    other.apply(&second, &cancel).await.unwrap();
    let effects = fixture.state.lock().unwrap().effects;
    let state = fs::read(first_state.path().join("terraform.tfstate")).unwrap();
    assert!(!String::from_utf8_lossy(&state).contains("owned-hosted-fixture-value"));
    let executable = bundle
        .join("bin")
        .join(nemoclaw_sdk::bundle::executable("nemoclaw"));
    let exported = Command::new(&executable)
        .args(["export", "--state-dir"])
        .arg(first_state.path())
        .output()
        .unwrap();
    assert!(
        exported.status.success(),
        "{}",
        String::from_utf8_lossy(&exported.stderr)
    );
    let authored = Document::parse(exported.stdout.as_slice()).unwrap();
    assert_eq!(authored, first);
    assert!(
        deployment
            .apply(&authored, &cancel)
            .await
            .unwrap()
            .changes
            .is_empty()
    );
    assert_eq!(fixture.state.lock().unwrap().effects, effects);
    nemoclaw_e2e::assert_same_deployment_state(
        &fs::read(first_state.path().join("terraform.tfstate")).unwrap(),
        &state,
    );
    let first_key = format!("{}/{}", first.workspace(), first.spec.sandboxes[0].name);
    let second_key = format!("{}/{}", second.workspace(), second.spec.sandboxes[0].name);
    {
        let mut live = fixture.state.lock().unwrap();
        let second_spec = live.sandboxes[&second_key].spec.as_ref().unwrap();
        assert_eq!(second_spec.providers, ["local"]);
        let first_spec = live
            .sandboxes
            .get_mut(&first_key)
            .unwrap()
            .spec
            .as_mut()
            .unwrap();
        assert_eq!(first_spec.providers, ["hosted", "local"]);
        first_spec.providers.remove(0);
    }
    assert!(deployment.plan(&first, &cancel).await.is_err());
    assert!(
        other
            .plan(&second, &cancel)
            .await
            .unwrap()
            .changes
            .is_empty()
    );
    assert_eq!(fixture.state.lock().unwrap().effects, effects);
    fixture
        .state
        .lock()
        .unwrap()
        .sandboxes
        .get_mut(&first_key)
        .unwrap()
        .spec
        .as_mut()
        .unwrap()
        .providers
        .insert(0, "hosted".into());
    for directory in [first_state.path(), second_state.path()] {
        let result = Command::new(&executable)
            .args(["destroy", "--state-dir"])
            .arg(directory)
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        if directory == first_state.path() {
            assert!(
                other
                    .apply(&second, &cancel)
                    .await
                    .unwrap()
                    .changes
                    .is_empty()
            );
        }
    }
    let live = fixture.state.lock().unwrap();
    assert!(live.sandboxes.is_empty());
    assert!(live.providers.is_empty());
    assert!(live.profiles.is_empty());
    assert_eq!(live.workspaces.len(), 2);
}
