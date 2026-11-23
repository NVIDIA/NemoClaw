// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// These ignored tests form an executable backlog. Each test describes an
// onboarding journey that cannot yet be expressed faithfully in desired state
// or by the offline authoring boundary. Remove `ignore` only when the named
// contract exists, then replace the failure with an outside-in journey.

#[test]
#[ignore = "managed Ollama authoring needs published runtime images (#13516) and a qualified model catalog (#14776)"]
fn an_author_can_install_or_reuse_ollama_after_environment_discovery() {
    panic!("missing offline catalog for a complete managed Ollama document");
}

#[test]
#[ignore = "managed vLLM authoring needs published runtime images (#13516) and a qualified model catalog (#14776)"]
fn an_author_can_install_or_reuse_vllm_after_environment_discovery() {
    panic!("missing offline catalog for a complete managed vLLM document");
}
