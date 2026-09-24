// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use nemoclaw_sdk::{config::Document, fabric_config};
use serde_json::{Value, json};
fn input() -> Value {
    serde_saphyr::from_str(include_str!("fixtures/config/local.yaml")).unwrap()
}
#[test]
fn invocation_timeout_projects_to_public_runtime_for_any_adapter() {
    for id in ["nvidia.fabric.pi", "org.fixture.future"] {
        let mut value = input();
        value["spec"]["sandboxes"][0]["harness"]["kind"] = id.into();
        value["spec"]["sandboxes"][0]["harness"]["execution"] = json!({"timeoutSeconds":900});
        let doc = Document::parse(value.to_string().as_bytes()).unwrap();
        assert_eq!(
            fabric_config::for_sandbox(&doc, &doc.spec.sandboxes[0]).unwrap()["runtime"]["timeout_seconds"],
            900
        );
        assert_eq!(
            Document::parse(doc.yaml().unwrap().as_bytes()).unwrap(),
            doc
        );
    }
}
#[test]
fn invalid_timeout_and_native_heartbeat_requirements_are_not_silently_accepted() {
    for execution in [
        json!({}),
        json!(null),
        json!({"timeoutSeconds":0}),
        json!({"timeoutSeconds":-1}),
        json!({"timeoutSeconds":1.5}),
        json!({"heartbeatEvery":"30m"}),
    ] {
        let mut value = input();
        value["spec"]["sandboxes"][0]["harness"]["execution"] = execution;
        assert!(Document::parse(value.to_string().as_bytes()).is_err());
    }
}
