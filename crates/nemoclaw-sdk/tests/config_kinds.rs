// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use nemoclaw_sdk::config::{Harness, InferenceProvider, Runtime};
use serde_json::json;

#[test]
fn selectors_reject_unknown_values_at_deserialization() {
    assert!(serde_json::from_value::<Harness>(json!({"kind":"unknown"})).is_err());
    assert!(serde_json::from_value::<Runtime>(json!({"provider":"unknown"})).is_err());
    assert!(
        serde_json::from_value::<InferenceProvider>(json!({"name":"model", "provider":"unknown"}))
            .is_err()
    );
}

#[test]
fn required_selectors_are_not_silently_defaulted() {
    assert!(serde_json::from_value::<Harness>(json!({})).is_err());
    assert!(serde_json::from_value::<InferenceProvider>(json!({"name":"model"})).is_err());
}

#[test]
fn selector_names_round_trip_without_changing_wire_values() {
    use nemoclaw_sdk::config::{ComputeDriver, HarnessKind, InferenceProviderKind};
    fn round_trip<T>(cases: &[(T, &str)])
    where
        T: std::fmt::Debug
            + PartialEq
            + std::fmt::Display
            + std::str::FromStr
            + serde::Serialize
            + serde::de::DeserializeOwned,
        T::Err: std::fmt::Debug,
    {
        for (kind, name) in cases {
            assert_eq!(serde_json::to_value(kind).unwrap(), json!(name));
            assert_eq!(&serde_json::from_value::<T>(json!(name)).unwrap(), kind);
            assert_eq!(&name.parse::<T>().unwrap(), kind);
            assert_eq!(kind.to_string(), *name);
        }
        for name in ["", "unknown", "Docker", "OPENAI", "open-claw"] {
            assert!(name.parse::<T>().is_err());
            assert!(serde_json::from_value::<T>(json!(name)).is_err());
        }
    }
    round_trip(&[
        (HarnessKind::DeepAgents, "deepagents"),
        (HarnessKind::Hermes, "hermes"),
        (HarnessKind::OpenClaw, "openclaw"),
        (HarnessKind::Claude, "claude"),
        (HarnessKind::Codex, "codex"),
        (HarnessKind::MiniSweAgent, "mini-swe-agent"),
        (HarnessKind::Nooa, "nooa"),
        (HarnessKind::NooaBench, "nooa-bench"),
        (HarnessKind::RemoteAgent, "remote-agent"),
        (HarnessKind::Pi, "pi"),
    ]);
    round_trip(&[
        (ComputeDriver::Docker, "docker"),
        (ComputeDriver::Podman, "podman"),
        (ComputeDriver::Kubernetes, "kubernetes"),
    ]);
    round_trip(&[
        (InferenceProviderKind::Openai, "openai"),
        (InferenceProviderKind::Anthropic, "anthropic"),
    ]);
}

#[test]
fn omitted_and_empty_runtime_select_docker_without_changing_intent_digest() {
    use nemoclaw_sdk::config::{ComputeDriver, Document};
    let document =
        Document::parse(include_bytes!("fixtures/config/local.yaml").as_slice()).unwrap();
    for runtime in [
        json!({}),
        json!({"provider":""}),
        json!({"provider":"docker"}),
    ] {
        let mut input = serde_json::to_value(&document).unwrap();
        input["spec"]["sandboxes"][0]["runtime"] = runtime;
        let parsed = Document::parse(input.to_string().as_bytes()).unwrap();
        assert_eq!(
            parsed.spec.sandboxes[0].runtime.provider,
            ComputeDriver::Docker
        );
        assert_eq!(parsed.digest(), document.digest());
        assert_eq!(parsed.yaml().unwrap(), document.yaml().unwrap());
    }
}
