// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::*;
#[test]
fn ordinary_plan_cannot_delete_replace_or_recreate_a_bound_resource() {
    let allowed = [("nemoclaw_workspace.deployment".into(), Row::new())].into();
    let bound = [(
        "nemoclaw_workspace.deployment".into(),
        StateBinding {
            id: "physical".into(),
            ..Default::default()
        },
    )]
    .into();
    for actions in [
        vec!["delete"],
        vec!["delete", "create"],
        vec!["create"],
        vec!["forget"],
    ] {
        let plan:Plan=serde_json::from_value(json!({"resource_changes":[{"address":"nemoclaw_workspace.deployment","change":{"actions":actions,"before":{"id":"physical"}}}]})).unwrap();
        assert!(check_plan(&plan, &allowed, &bound).is_err());
    }
}
#[test]
fn teardown_must_account_for_every_binding_and_retain_the_workspace() {
    let allowed = [("nemoclaw_workspace.deployment".into(), Row::new())].into();
    let bound = [(
        "nemoclaw_workspace.deployment".into(),
        StateBinding {
            id: "physical".into(),
            ..Default::default()
        },
    )]
    .into();
    let retained = ["nemoclaw_workspace.deployment".into()].into();
    let plan: Plan = serde_json::from_value(json!({"resource_changes":[]})).unwrap();
    assert!(check_destroy_plan(&plan, &allowed, &bound, &retained).is_err());
    let plan:Plan=serde_json::from_value(json!({"resource_changes":[{"address":"nemoclaw_workspace.deployment","change":{"actions":["delete"],"before":{"id":"physical"}}}]})).unwrap();
    assert!(check_destroy_plan(&plan, &allowed, &bound, &retained).is_err());
}

#[test]
fn credential_references_cannot_override_opentofu_control_variables() {
    struct Values;
    impl Secrets for Values {
        fn resolve(&self, _: &str) -> Result<String, crate::ObservationError> {
            Ok("foreign-config".into())
        }
    }
    let mut document =
        Document::parse(include_str!("../../tests/fixtures/config/local.yaml").as_bytes()).unwrap();
    document.spec.inference_providers[0].endpoint = "https://example.com/v1".into();
    document.spec.inference_providers[0].credential = Some(Credential {
        env: "TF_CLI_CONFIG_FILE".into(),
    });
    assert!(command_environment(&document, &Values, Path::new("state")).is_err());
}
