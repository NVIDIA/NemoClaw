// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
#![cfg(target_os = "linux")]

use crate::service_images::managed;
use crate::service_images::support::Scenario;

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires explicit bundle, agent image/profile and proxy image; isolated SSH/Docker protocol and real agent image"]
// E04-S07
async fn remote_models_preserve_bindings_when_ssh_observation_fails() {
    let mut scenario = Scenario::start().await;
    let service = managed::ManagedService::start(&mut scenario).await;
    service.plan(&scenario).await;
    service.assert_no_effects();
    scenario.assert_no_resources();
    service.apply(&scenario).await;
    let remote = service.snapshot();
    service.assert_runtime_configuration();
    let agent = scenario.agent_identity("assistant-0");
    service.assert_remote_publication();
    scenario.assert_agent_service_access("assistant-0");
    scenario.assert_agent_responds("assistant-0");

    service.fail_ssh_observation();
    service.plan_expect_failure(&scenario).await;
    service.assert_unchanged(&remote);
    assert_eq!(scenario.agent_identity("assistant-0"), agent);
    scenario.assert_agent_service_access("assistant-0");
    scenario.assert_agent_responds("assistant-0");

    service.clear_failures();
    service.assert_export_matches_document(&scenario).await;
    service.assert_apply_unchanged(&scenario).await;
    service.assert_unchanged(&remote);
    assert_eq!(scenario.agent_identity("assistant-0"), agent);
    scenario.assert_agent_service_access("assistant-0");
    scenario.assert_agent_responds("assistant-0");

    service.destroy(&scenario).await;
    service.assert_destroyed_with_storage_retained(&remote);
    scenario.assert_agent_absent("assistant-0");
}
