// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! A successful apply reports the URLs the gateway gave each sandbox's service
//! exposures, read from OpenTofu state. Scripted OpenTofu supplies plans and
//! state; the provider's refresh of the URLs is covered by its contract tests.

#![cfg(unix)]

use crate::scripted_tofu::{Events, Scripted, placeholder_generations, plan_json, state_json};
use nemoclaw_sdk::{
    CancellationToken, Outcome, Progress,
    compile::{self, Target},
    config::Document,
};
use serde_json::{Value, json};

const DASHBOARD: &str = "http://nc-ws--assistant--dashboard.services.fixture.test/";
const UNNAMED: &str = "http://nc-ws--assistant.services.fixture.test/";

fn document() -> Document {
    let mut value = crate::support::fixture("local.yaml");
    value["spec"]["sandboxes"]["assistant"]["serviceExposures"] = json!({
        "dashboard": {"targetPort": 18800},
        "": {"targetPort": 8080}
    });
    Document::parse(serde_json::to_vec(&value).unwrap().as_slice()).unwrap()
}

fn targets(document: &Document, generations: &compile::Generations) -> Vec<Target> {
    compile::targets(document, generations).unwrap()
}

/// State whose sandbox carries the URLs the gateway reported.
fn state_with_urls(targets: &[Target]) -> String {
    let mut state: Value = serde_json::from_str(&state_json(targets)).unwrap();
    for resource in state["values"]["root_module"]["resources"]
        .as_array_mut()
        .unwrap()
    {
        if resource["address"] == "openshell_sandbox.assistant" {
            resource["values"]["service_urls"] = json!({"dashboard": DASHBOARD, "": UNNAMED});
        }
    }
    state.to_string()
}

fn expected() -> Value {
    json!({"assistant": {"dashboard": DASHBOARD, "": UNNAMED}})
}

#[tokio::test]
async fn apply_reports_service_urls_on_creation_and_unchanged_reapply_but_plan_does_not() {
    let scripted = Scripted::new();
    let document = document();
    let declared = targets(&document, &placeholder_generations());
    scripted.set("root.apply.plan", plan_json(&declared, "create"));
    scripted.set("root.state", state_with_urls(&declared));
    let deployment = scripted.deployment(&scripted.path("unused-kubeconfig"));
    let cancel = CancellationToken::new();

    let created = deployment.apply(&document, &cancel).await.unwrap();
    assert_eq!(created.outcome, Outcome::Succeeded);
    assert_eq!(
        serde_json::to_value(&created).unwrap()["serviceUrls"],
        expected()
    );

    let declared = targets(&document, &scripted.generations());
    scripted.set("root.state", state_with_urls(&declared));
    scripted.set("root.apply.plan", plan_json(&declared, "no-op"));
    let unchanged = deployment.apply(&document, &cancel).await.unwrap();
    assert!(unchanged.changes.is_empty(), "{:?}", unchanged.changes);
    assert_eq!(
        serde_json::to_value(&unchanged).unwrap()["serviceUrls"],
        expected()
    );

    let planned = deployment.plan(&document, &cancel).await.unwrap();
    assert_eq!(planned.outcome, Outcome::Planned);
    assert!(
        serde_json::to_value(&planned)
            .unwrap()
            .get("serviceUrls")
            .is_none()
    );
}

/// Without exposures there are no URLs to read, so apply doesn't read state
/// for them and can't warn that it failed to.
#[tokio::test]
async fn apply_without_exposures_leaves_service_urls_out_without_reading_them() {
    let scripted = Scripted::new();
    let document = Document::parse(
        serde_json::to_vec(&crate::support::fixture("local.yaml"))
            .unwrap()
            .as_slice(),
    )
    .unwrap();
    let declared = targets(&document, &placeholder_generations());
    scripted.set("root.apply.plan", plan_json(&declared, "create"));
    scripted.set("root.state", "not json");
    let events = Events::default();
    let result = scripted
        .deployment(&scripted.path("unused-kubeconfig"))
        .with_progress(events.recording())
        .apply(&document, &CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(result.outcome, Outcome::Succeeded);
    assert!(
        serde_json::to_value(&result)
            .unwrap()
            .get("serviceUrls")
            .is_none()
    );
    assert!(
        !events.contains(|event| matches!(event, Progress::Warning { .. })),
        "a deployment without exposures warned"
    );
}

/// The apply's changes are saved before the URLs are read, so failing or
/// cancelling that read still reports the apply as succeeded, without URLs and
/// with a warning that names what wasn't read.
#[tokio::test]
async fn apply_succeeds_with_a_warning_when_reading_service_urls_fails_or_is_cancelled() {
    for case in ["unreadable state", "cancelled after apply"] {
        let scripted = Scripted::new();
        let document = document();
        let declared = targets(&document, &placeholder_generations());
        scripted.set("root.apply.plan", plan_json(&declared, "create"));
        let (events, token) = (Events::default(), CancellationToken::new());
        let hook = if case == "unreadable state" {
            scripted.set("root.state", "not json");
            events.recording()
        } else {
            scripted.set("root.state", state_with_urls(&declared));
            events.cancelling(&token, |event| {
                matches!(
                    event,
                    Progress::Completed {
                        operation: "tofu.apply",
                        ..
                    }
                )
            })
        };
        let result = scripted
            .deployment(&scripted.path("unused-kubeconfig"))
            .with_progress(hook)
            .apply(&document, &token)
            .await;
        let result = result.unwrap_or_else(|error| panic!("{case}: {error:?}"));
        assert_eq!(result.outcome, Outcome::Succeeded, "{case}");
        assert!(
            serde_json::to_value(&result)
                .unwrap()
                .get("serviceUrls")
                .is_none(),
            "{case}"
        );
        assert!(
            events.contains(|event| matches!(
                event,
                Progress::Warning { message } if message.contains("service URLs")
            )),
            "{case}: no warning"
        );
    }
}
