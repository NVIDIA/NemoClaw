// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// These ignored tests form an executable backlog. Each test describes an
// onboarding journey that cannot yet be expressed faithfully in desired state
// or by the offline authoring boundary. Remove `ignore` only when the named
// contract exists, then replace the failure with an outside-in journey.

#[test]
#[ignore = "V1 has no NemoCUA harness kind or qualified image contract"]
fn an_author_can_choose_the_feature_gated_nemocua_agent() {
    panic!("missing V1 NemoCUA harness contract");
}

#[test]
#[ignore = "V1 has no managed llama.cpp service or GGUF model contract"]
fn an_author_can_attach_or_install_llama_cpp() {
    panic!("missing V1 llama.cpp lifecycle contract");
}

#[test]
#[ignore = "V1 has no managed NVIDIA NIM service identity"]
fn an_author_can_choose_local_nvidia_nim_on_a_qualified_gpu() {
    panic!("missing V1 NIM lifecycle contract");
}

#[test]
#[ignore = "V1 has no managed model-router or model-pool lifecycle"]
fn an_author_can_choose_the_experimental_model_router() {
    panic!("missing V1 model-router contract");
}

#[test]
#[ignore = "managed Ollama authoring needs a qualified runtime image, hardware profile, and immutable model digest catalog"]
fn an_author_can_install_or_reuse_ollama_after_environment_discovery() {
    panic!("missing offline catalog for a complete managed Ollama document");
}

#[test]
#[ignore = "managed vLLM authoring needs qualified runtime images, hardware profiles, and immutable model revisions"]
fn an_author_can_install_or_reuse_vllm_after_environment_discovery() {
    panic!("missing offline catalog for a complete managed vLLM document");
}

#[test]
#[ignore = "V1 Sandbox has no CPU or RAM resource-sizing fields"]
fn an_author_can_choose_a_resource_profile_or_custom_cpu_and_ram() {
    panic!("missing V1 sandbox resource contract");
}

#[test]
#[ignore = "desired state preserves isolated or explicit policy, but has no policy-tier and composable-preset intent"]
fn an_author_can_choose_a_policy_tier_then_customize_presets_and_access() {
    panic!("missing V1 guided policy-preset contract");
}

#[test]
#[ignore = "V1 has no messaging-channel configuration model"]
fn an_author_can_select_multiple_messaging_channels() {
    panic!("missing V1 messaging-channel contract");
}

#[test]
#[ignore = "V1 Runtime has no sandbox GPU-selection or host-mount fields"]
fn an_author_can_choose_sandbox_gpu_access_and_read_only_host_mounts() {
    panic!("missing V1 sandbox runtime resource contract");
}

#[test]
#[ignore = "V1 cannot preserve trusted-private-host intent or endpoint qualification evidence"]
fn an_author_can_trust_a_private_compatible_endpoint_after_validation() {
    panic!("missing V1 trusted-private-endpoint contract");
}
