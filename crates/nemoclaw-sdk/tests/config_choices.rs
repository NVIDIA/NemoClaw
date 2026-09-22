// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use nemoclaw_sdk::{
    config::{Credential, Document, InferenceProvider, InferenceProviderKind, InferenceTarget},
    services::{
        ServiceDefinition,
        installers::vllm::{HardwareProfile, Service, ServiceHardware, VllmLaunchMode},
        placement::{PublishedPlacement, ServicePlacement, ServicePublication},
    },
};

fn provider() -> InferenceProvider {
    InferenceProvider {
        name: "test".into(),
        provider: InferenceProviderKind::Openai,
        api: None,
        endpoint: String::new(),
        credential: None,
        service_ref: None,
    }
}

fn hardware() -> ServiceHardware {
    ServiceHardware::Profile {
        profile: HardwareProfile::DgxSpark,
        architecture: None,
        min_gpu_memory_bytes: None,
    }
}

fn recipe_service() -> Service {
    let mut document =
        Document::parse(include_str!("fixtures/config/spark.yaml").as_bytes()).unwrap();
    let ServiceDefinition::Vllm(service) = document.spec.services.remove("qwen").unwrap() else {
        panic!("vLLM fixture")
    };
    *service
}

#[test]
fn inference_target_requires_an_endpoint_or_service_reference() {
    assert!(provider().target().is_err());
}

#[test]
fn external_inference_target_accepts_an_endpoint_without_credentials() {
    let provider = InferenceProvider {
        endpoint: "https://example.com/v1".into(),
        ..provider()
    };
    assert!(matches!(
        provider.target().unwrap(),
        InferenceTarget::External {
            credential: None,
            ..
        }
    ));
}

#[test]
fn inference_target_rejects_an_endpoint_with_a_service_reference() {
    let provider = InferenceProvider {
        endpoint: "https://example.com/v1".into(),
        service_ref: Some("model".into()),
        ..provider()
    };
    assert!(provider.target().is_err());
}

#[test]
fn service_inference_target_preserves_the_service_name() {
    let provider = InferenceProvider {
        service_ref: Some("model".into()),
        ..provider()
    };
    assert!(matches!(
        provider.target().unwrap(),
        InferenceTarget::Service { name: "model" }
    ));
}

#[test]
fn service_inference_target_rejects_credentials_without_exposing_the_reference() {
    let provider = InferenceProvider {
        service_ref: Some("model".into()),
        credential: Some(Credential {
            env: "SECRET_REF".into(),
        }),
        ..provider()
    };
    let error = provider.target().unwrap_err().to_string();
    assert!(!error.contains("SECRET_REF"));
}

#[test]
fn external_inference_target_rejects_credentials_without_an_endpoint() {
    let provider = InferenceProvider {
        credential: Some(Credential {
            env: "SECRET_REF".into(),
        }),
        ..provider()
    };
    assert!(provider.target().is_err());
}

#[test]
fn external_inference_target_accepts_an_endpoint_with_credentials() {
    let provider = InferenceProvider {
        endpoint: "https://example.com/v1".into(),
        credential: Some(Credential {
            env: "SECRET_REF".into(),
        }),
        ..provider()
    };
    assert!(matches!(
        provider.target().unwrap(),
        InferenceTarget::External {
            credential: Some(_),
            ..
        }
    ));
}

#[test]
fn omitted_placement_and_publication_allow_inheritance() {
    assert!(
        PublishedPlacement::from_parts(None, None)
            .unwrap()
            .is_none()
    );
}

#[test]
fn explicit_placement_requires_its_publication() {
    let placement = ServicePlacement::default();
    assert!(PublishedPlacement::from_parts(Some(&placement), None).is_err());
}

#[test]
fn publication_requires_an_explicit_placement() {
    let publication = ServicePublication::default();
    assert!(PublishedPlacement::from_parts(None, Some(&publication)).is_err());
}

#[test]
fn explicit_placement_accepts_its_publication() {
    let placement = ServicePlacement::default();
    let publication = ServicePublication::default();
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
fn launch_mode_selects_the_recipe_contract() {
    let service = recipe_service();
    assert!(matches!(
        service.launch_mode().unwrap(),
        VllmLaunchMode::Recipe { .. }
    ));
}

#[test]
fn launch_mode_rejects_hardware_with_a_recipe() {
    let service = Service {
        hardware: Some(hardware()),
        ..recipe_service()
    };
    assert!(service.launch_mode().is_err());
}

#[test]
fn launch_mode_selects_the_native_hardware_contract() {
    let service = Service {
        hardware: Some(hardware()),
        ..Service::default()
    };
    assert!(matches!(
        service.launch_mode().unwrap(),
        VllmLaunchMode::Native { .. }
    ));
}
