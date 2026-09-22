// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use nemoclaw_sdk::{
    config::{InferenceProvider, InferenceProviderKind, InferenceTarget},
    services::{
        installers::vllm::Service,
        placement::{PublishedPlacement, ServicePlacement, ServicePublication},
    },
};

#[test]
fn inference_target_rejects_conflicting_or_missing_connection_fields() {
    let mut provider = InferenceProvider {
        name: "test".into(),
        provider: InferenceProviderKind::Openai,
        api: None,
        endpoint: String::new(),
        credential: None,
        service_ref: None,
    };
    assert!(provider.target().is_err());
    provider.endpoint = "https://example.com/v1".into();
    assert!(matches!(
        provider.target().unwrap(),
        InferenceTarget::External { .. }
    ));
    provider.service_ref = Some("model".into());
    assert!(provider.target().is_err());
    provider.endpoint.clear();
    assert!(matches!(
        provider.target().unwrap(),
        InferenceTarget::Service { name: "model" }
    ));
    provider.credential = Some(nemoclaw_sdk::config::Credential {
        env: "SECRET_REF".into(),
    });
    let error = provider.target().unwrap_err().to_string();
    assert!(!error.contains("SECRET_REF"));
    provider.service_ref = None;
    assert!(provider.target().is_err());
    provider.endpoint = "https://example.com/v1".into();
    assert!(matches!(
        provider.target().unwrap(),
        InferenceTarget::External {
            credential: Some(_),
            ..
        }
    ));
}

#[test]
fn explicit_placement_requires_its_publication() {
    let placement = ServicePlacement::default();
    let publication = ServicePublication::default();
    assert!(
        PublishedPlacement::from_parts(None, None)
            .unwrap()
            .is_none()
    );
    assert!(PublishedPlacement::from_parts(Some(&placement), None).is_err());
    assert!(PublishedPlacement::from_parts(None, Some(&publication)).is_err());
    assert!(
        PublishedPlacement::from_parts(Some(&placement), Some(&publication))
            .unwrap()
            .is_some()
    );
}

#[test]
fn launch_mode_requires_an_explicit_hardware_or_recipe_contract() {
    assert!(Service::default().launch_mode().is_err());
}

#[test]
fn launch_mode_distinguishes_native_and_recipe_and_rejects_both() {
    use nemoclaw_sdk::{
        config::Document,
        services::{
            ServiceDefinition,
            installers::vllm::{HardwareProfile, ServiceHardware, VllmLaunchMode},
        },
    };
    let mut document =
        Document::parse(include_str!("fixtures/config/spark.yaml").as_bytes()).unwrap();
    let ServiceDefinition::Vllm(service) = document.spec.services.get_mut("qwen").unwrap() else {
        panic!("vLLM fixture")
    };
    assert!(matches!(
        service.launch_mode().unwrap(),
        VllmLaunchMode::Recipe { .. }
    ));
    service.hardware = Some(ServiceHardware::Profile {
        profile: HardwareProfile::DgxSpark,
        architecture: None,
        min_gpu_memory_bytes: None,
    });
    assert!(service.launch_mode().is_err());
    service.recipe = None;
    assert!(matches!(
        service.launch_mode().unwrap(),
        VllmLaunchMode::Native { .. }
    ));
}
