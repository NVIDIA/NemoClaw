// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use nemoclaw_sdk::config::{Credential, Document};

#[test]
fn inference_connection_is_resolved_independently_of_the_sandbox_engine() {
    let local = Document::parse(include_str!("fixtures/config/spark.yaml").as_bytes()).unwrap();
    let published = local.inference_connection();
    assert_eq!(published.endpoint, local.inference_endpoint());
    assert!(published.credential.is_none());
    let mut remote =
        Document::parse(include_str!("fixtures/config/local.yaml").as_bytes()).unwrap();
    remote.spec.inference_providers[0].endpoint = "https://inference.example.test:9443/v1".into();
    remote.spec.inference_providers[0].credential = Some(Credential {
        env: "MODEL_TOKEN".into(),
    });
    let first = remote.inference_connection();
    remote.spec.sandboxes[0].runtime.provider = "podman".into();
    remote.validate().unwrap();
    assert_eq!(remote.inference_connection(), first);
    assert_eq!(first.endpoint, "https://inference.example.test:9443/v1");
    assert_eq!(first.credential.unwrap().env, "MODEL_TOKEN");
    // Resolution is pure: this address need not be reachable by the CLI host.
    remote.spec.inference_providers[0].endpoint = "https://unreachable.invalid/v1".into();
    remote.validate().unwrap();
    assert_eq!(
        remote.inference_connection().endpoint,
        "https://unreachable.invalid/v1"
    );
}
