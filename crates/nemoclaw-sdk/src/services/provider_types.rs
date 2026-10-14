// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! The OpenTofu types the vllm and ollama providers serve for service kinds.
//!
//! Service containers and model caches compile to Docker types, so their
//! kinds have no provider type; credential storage and runtime reads do.

/// Service kinds the vllm and ollama providers serve, with their type names.
pub const RUNTIME_TYPES: [(&str, &str); 6] = [
    ("inference_storage", "vllm_credential_storage"),
    ("vllm_runtime", "vllm_runtime"),
    ("ollama_proxy_storage", "ollama_proxy_credential_storage"),
    ("ollama_runtime", "ollama_runtime"),
    ("ollama_proxy_runtime", "ollama_proxy_runtime"),
    ("ollama_model", "ollama_model"),
];

/// Readiness data sources for service container kinds.
pub const READINESS_TYPES: [(&str, &str); 3] = [
    ("inference_service", "vllm_readiness"),
    ("ollama_service", "ollama_readiness"),
    ("ollama_proxy", "ollama_proxy_readiness"),
];

/// The providers serving runtime types; a type's name starts with its provider's.
pub const PROVIDERS: [&str; 2] = ["vllm", "ollama"];

/// The type a runtime provider serves for a service kind.
pub fn runtime_type(kind: &str) -> Option<&'static str> {
    RUNTIME_TYPES
        .iter()
        .find(|(runtime, _)| *runtime == kind)
        .map(|(_, name)| *name)
}

/// The service kind a runtime provider's type serves.
pub fn runtime_kind(name: &str) -> Option<&'static str> {
    RUNTIME_TYPES
        .iter()
        .find(|(_, runtime)| *runtime == name)
        .map(|(kind, _)| *kind)
}

/// The readiness data source for a service container kind.
pub fn readiness_type(kind: &str) -> Option<&'static str> {
    READINESS_TYPES
        .iter()
        .find(|(service, _)| *service == kind)
        .map(|(_, name)| *name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runtime_types_belong_to_one_provider_and_map_back_to_their_kind() {
        for (kind, name) in RUNTIME_TYPES {
            assert_eq!(runtime_type(kind), Some(name));
            assert_eq!(runtime_kind(name), Some(kind));
            assert_eq!(
                PROVIDERS
                    .iter()
                    .filter(|provider| name.starts_with(&format!("{provider}_")))
                    .count(),
                1,
                "{name}"
            );
        }
        for (_, name) in READINESS_TYPES {
            assert!(
                PROVIDERS
                    .iter()
                    .any(|provider| name.starts_with(&format!("{provider}_")))
            );
        }
        // Containers and caches compile to Docker types.
        for kind in [
            "inference_service",
            "ollama_service",
            "ollama_proxy",
            "ollama_service_storage",
        ] {
            assert_eq!(runtime_type(kind), None, "{kind}");
        }
    }
}
