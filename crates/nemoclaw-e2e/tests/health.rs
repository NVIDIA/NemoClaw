// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use nemoclaw_e2e::openshell::Fixture;
use nemoclaw_sdk::{backend::Backend, compile, config::Document, openshell::OpenShell};
use std::{collections::BTreeMap, sync::Arc};

#[tokio::test]
async fn health_reads_the_owned_host_without_generation_and_preserves_busy_readiness() {
    let fixture = Fixture::start().await;
    let mut doc = Document::parse(
        include_str!("../../nemoclaw-sdk/tests/fixtures/config/local.yaml").as_bytes(),
    )
    .unwrap();
    *doc.spec.gateway.endpoint_mut() = fixture.endpoint.clone();
    let client = OpenShell::connect(
        &doc.spec.gateway,
        Arc::new(nemoclaw_sdk::openshell::EnvironmentSecrets),
    )
    .unwrap();
    let generations = ["workspace", "provider", "sandbox"]
        .into_iter()
        .map(|k| (k.into(), format!("{k}-generation")))
        .collect::<BTreeMap<_, _>>();
    let targets = compile::targets(&doc, &generations).unwrap();
    for target in targets.iter().filter(|target| {
        matches!(
            target.kind.as_str(),
            "workspace" | "provider_profile" | "provider"
        )
    }) {
        let result = client.ensure(&target.kind, &target.values).await;
        assert!(result.error().is_none(), "{:?}", result.error());
    }
    let target = targets
        .iter()
        .find(|target| target.kind == "sandbox")
        .unwrap();
    let mutation = client.ensure("sandbox", &target.values).await;
    assert!(mutation.error().is_none(), "{:?}", mutation.error());
    let binding = mutation.into_parts().0.unwrap();
    let health = client.health(&binding).await.unwrap();
    assert!(!health.supported);
    assert!(health.allows_apply_completion());
    for (liveness, activity, readiness, accepted) in [
        ("responsive", "busy", "ready", true),
        ("responsive", "idle", "not_ready", false),
        ("responsive", "stopping", "not_ready", false),
        ("unknown", "unknown", "unknown", false),
        ("unresponsive", "busy", "unknown", false),
        ("exited", "unknown", "not_ready", false),
    ] {
        let report = serde_json::json!({
            "runtime_id": "owned-runtime", "checked_at_millis": 100, "duration_millis": 2,
            "liveness": liveness, "activity": activity, "readiness": readiness,
            "reason_code": "fixture_observation",
            "checks": [{"name":"inference", "status":"unsupported", "reason_code":"not_implemented", "observed_at_millis":99,"age_millis":1}]
        });
        fixture.state.lock().unwrap().health_report = Some(serde_json::json!({
            "supported": true, "report": report, "reason_code": null
        }));
        let health = client.health(&binding).await.unwrap();
        assert_eq!(health.report, Some(report));
        assert_eq!(health.allows_apply_completion(), accepted);
    }
    fixture.state.lock().unwrap().health_report = Some(serde_json::json!({
        "supported": true, "report": null, "reason_code": "fabric_health_timeout"
    }));
    assert!(
        !client
            .health(&binding)
            .await
            .unwrap()
            .allows_apply_completion()
    );
    fixture.state.lock().unwrap().health_report = Some(serde_json::json!({
        "supported": false, "report": null, "reason_code": "fabric_health_timeout"
    }));
    assert!(client.health(&binding).await.is_err());
    fixture.state.lock().unwrap().health_report =
        Some(serde_json::json!({"secret-sentinel": true}));
    assert!(
        !client
            .health(&binding)
            .await
            .unwrap_err()
            .to_string()
            .contains("secret-sentinel")
    );
    let state = fixture.state.lock().unwrap();
    assert!(
        state
            .exec_calls
            .iter()
            .all(|command| command.last().unwrap() == "health")
    );
}
