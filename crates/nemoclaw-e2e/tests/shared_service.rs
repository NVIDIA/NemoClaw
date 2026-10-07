// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
#![cfg(target_os = "linux")]

use crate::service_images::support::{Scenario, assert_apply_unchanged};
use nemoclaw_sdk::{CancellationToken, Deployment};

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires explicit bundle, agent image/profile and proxy image; creates owned Docker resources"]
// E02-S10
async fn shared_service_preserves_consumers_and_export_reapply() {
    let scenario = Scenario::start().await;
    let mut document = scenario.proxy_document(2).await;
    let deployment = Deployment::new(scenario.state.path(), &scenario.bundle);
    let cancel = CancellationToken::new();

    let plan = deployment.plan(&document, &cancel).await.unwrap();
    assert!(!plan.changes.is_empty());
    scenario.assert_no_resources();
    deployment.apply(&document, &cancel).await.unwrap();
    let service = scenario.service_identity(&document);
    let survivor = scenario.agent_identity("assistant-1");
    scenario.assert_shared_service(&document, 2);
    scenario.assert_agent_service_access("assistant-0");
    scenario.assert_agent_responds("assistant-0");
    scenario.assert_agent_service_access("assistant-1");
    scenario.assert_agent_responds("assistant-1");

    let exported = scenario.export();
    assert_eq!(exported, document);
    assert_apply_unchanged(&deployment, &exported, &cancel).await;
    assert_eq!(scenario.service_identity(&document), service);
    assert_eq!(scenario.agent_identity("assistant-1"), survivor);

    let original = document.clone();
    document.spec.sandboxes.remove(0);
    let error = deployment.apply(&document, &cancel).await.unwrap_err();
    assert!(
        matches!(error, nemoclaw_sdk::Error::SandboxChangeRefused { sandbox, action: "remove" } if sandbox == "assistant-0")
    );
    document = original;
    scenario.assert_agent_service_access("assistant-0");
    scenario.assert_agent_responds("assistant-0");
    assert_eq!(scenario.agent_identity("assistant-1"), survivor);
    assert_eq!(scenario.service_identity(&document), service);
    scenario.assert_shared_service(&document, 2);
    scenario.assert_agent_service_access("assistant-1");
    scenario.assert_agent_responds("assistant-1");

    // Reopen from exported configuration: the service reference and both
    // consumers must survive the configuration handoff without reconstruction.
    let exported = scenario.export();
    assert_eq!(exported, document);
    let reopened = Deployment::new(scenario.state.path(), &scenario.bundle);
    assert_apply_unchanged(&reopened, &exported, &cancel).await;
    assert_eq!(scenario.service_identity(&document), service);
    scenario.destroy();
    scenario.assert_agent_absent("assistant-0");
    scenario.assert_agent_absent("assistant-1");
    scenario.assert_service_destroyed_with_credentials_retained(&document);
    scenario.assert_external_server_alive().await;
}
