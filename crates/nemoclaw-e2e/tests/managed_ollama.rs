// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
#![cfg(target_os = "linux")]

use crate::service_images::managed;
use crate::service_images::support::Scenario;

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires explicit bundle, agent image/profile and proxy image; protocol Ollama service with real image execution"]
// E04-S02
async fn managed_ollama_recovers_and_retains_model_storage() {
    let mut scenario = Scenario::start().await;
    let service = managed::ManagedService::start(&mut scenario).await;
    service.fail_capacity_observation();
    service.plan(&scenario).await;
    service.assert_no_effects();
    service.assert_no_capacity_observations();
    scenario.assert_no_resources();

    service.fail_container_creation();
    service.apply_expect_failure(&scenario).await;
    service.assert_storage_created_without_container();
    let partial = service.snapshot();
    scenario.assert_agent_absent("assistant-0");

    service.clear_failures();
    service.apply(&scenario).await;
    let ready = service.snapshot();
    service.assert_runtime_configuration();
    service.assert_storage_retained(&partial);
    service.assert_running();
    scenario.assert_agent_service_access("assistant-0");
    scenario.assert_agent_responds("assistant-0");
    let agent = scenario.agent_identity("assistant-0");
    service.assert_export_matches_document(&scenario).await;
    service.assert_apply_unchanged(&scenario).await;
    service.assert_container_preserved(&ready);
    assert_eq!(scenario.agent_identity("assistant-0"), agent);
    scenario.assert_agent_responds("assistant-0");

    service.destroy(&scenario).await;
    service.assert_destroyed_with_storage_retained(&ready);
    scenario.assert_agent_absent("assistant-0");
}
