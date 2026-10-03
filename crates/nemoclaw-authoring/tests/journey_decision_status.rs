// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use nemoclaw_authoring::{Capabilities, DecisionStatus, JourneyDefinition, PartialDocument};
use serde_json::json;

#[test]
fn supplied_values_and_user_decisions_are_distinct() {
    let capabilities = Capabilities::available();
    let base =
        PartialDocument::from_yaml(include_bytes!("../../../examples/onboarding/openclaw.yaml"))
            .unwrap();
    let mut session = JourneyDefinition::new("decision-status", base)
        .ask(["/metadata/name", "adapter:nvidia.fabric.openclaw:/cli"])
        .start(&capabilities)
        .unwrap();

    assert_eq!(
        session.values().pointer("/metadata/name"),
        Some(&json!("openclaw-nvidia-hosted"))
    );
    assert_eq!(
        session.decision_status("/metadata/name"),
        DecisionStatus::Unreviewed
    );
    session
        .answer(
            &capabilities,
            "/metadata/name",
            Some(json!("openclaw-nvidia-hosted")),
        )
        .unwrap();
    assert_eq!(
        session.decision_status("/metadata/name"),
        DecisionStatus::Accepted
    );

    let optional = "adapter:nvidia.fabric.openclaw:/cli";
    assert!(
        !session
            .resolve(&capabilities)
            .unwrap()
            .question(optional)
            .unwrap()
            .required()
    );
    session.answer(&capabilities, optional, None).unwrap();
    assert_eq!(session.decision_status(optional), DecisionStatus::Omitted);
    assert!(
        session
            .values()
            .pointer("/spec/sandboxes/0/harness/settings/cli")
            .is_none()
    );
}
