// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use crate::{
    config::{Document, ServiceDefinition},
    services::contract::Installer,
};

#[test]
fn inference_removal_retains_cache_and_requires_authenticated_storage() {
    for (fixture, name, data) in [
        (
            include_str!("../../../tests/fixtures/config/managed-ollama.yaml"),
            "ollama-server",
            "docker_volume.ollama_service_storage_ollama-server",
        ),
        (
            include_str!("../../../tests/fixtures/config/spark.yaml"),
            "qwen",
            "docker_volume.inference_storage_inference_qwen",
        ),
    ] {
        for authenticated in [false, true] {
            let mut document = Document::parse(fixture.as_bytes()).unwrap();
            let service = document.spec.services.get_mut(name).unwrap();
            match service {
                ServiceDefinition::Vllm(service) => {
                    service.authentication =
                        authenticated.then_some(super::vllm::ServiceAuthentication::Bearer)
                }
                _ if authenticated => continue,
                _ => {}
            }
            let removal = document.spec.services[name]
                .remove(&document, name, &Default::default())
                .unwrap();
            if authenticated {
                let auth = format!("vllm_credential_storage.inference_{name}_auth");
                assert_eq!(removal.retained, [auth.clone(), data.into()]);
                assert_eq!(
                    removal.required_storage,
                    [(format!("nemoclaw_inference_service.inference_{name}"), auth)]
                );
            } else {
                assert_eq!(removal.retained, [data]);
                assert!(removal.required_storage.is_empty());
            }
        }
    }
}
