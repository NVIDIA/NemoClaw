// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use nemoclaw_authoring::{
    Answers, Capabilities, Draft, EditableField, JourneyFlow, JourneyFlowQuestion, Session,
};

#[test]
fn complete_draft_resolves_guided_setting_and_deployment_questions_in_order() {
    let capabilities = Capabilities::available();
    let authored = Session::new()
        .unwrap()
        .project(&capabilities, &Answers::onboarding_defaults())
        .unwrap();
    let mut draft = Draft::from_document(authored.document().clone()).unwrap();
    let flow = JourneyFlow::new(&draft, &capabilities);
    assert!(matches!(
        flow.next_question().unwrap(),
        JourneyFlowQuestion::Guided(_)
    ));

    for _ in 0..32 {
        let Some(field) = draft.next_question(&capabilities).unwrap() else {
            break;
        };
        draft.delegate(&capabilities, field.id()).unwrap();
    }
    let flow = JourneyFlow::new(&draft, &capabilities);
    assert!(matches!(
        flow.next_question().unwrap(),
        JourneyFlowQuestion::Setting { .. }
            | JourneyFlowQuestion::Deployment { .. }
            | JourneyFlowQuestion::Review
    ));
}

#[test]
fn an_exhausted_route_list_never_reopens_an_empty_route_menu() {
    let draft = Draft::from_yaml(include_bytes!(
        "../../../examples/spark/local-and-hosted.yaml"
    ))
    .unwrap();
    let capabilities = Capabilities::available().preserving_draft(&draft).unwrap();
    let mut draft = Session::new()
        .unwrap()
        .draft_from_template(draft.document().clone())
        .unwrap();
    draft.select_route("hosted").unwrap();
    for _ in 0..16 {
        let field = draft.next_question(&capabilities).unwrap().unwrap();
        if field.id() == EditableField::Inference {
            break;
        }
        draft.delegate(&capabilities, field.id()).unwrap();
    }
    assert_eq!(
        draft.next_question(&capabilities).unwrap().unwrap().id(),
        EditableField::Inference
    );
    let completed = draft.route_names().unwrap();
    let flow = JourneyFlow::new(&draft, &capabilities).with_progress(&completed, false, 0);
    assert!(matches!(
        flow.next_question().unwrap(),
        JourneyFlowQuestion::Guided(_)
    ));
}
