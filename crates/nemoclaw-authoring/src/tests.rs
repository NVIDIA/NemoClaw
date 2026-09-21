// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::*;
use crate::capabilities::NVIDIA_MODEL;
use nemoclaw_sdk::config::{Document, Gateway, InferenceApi};

const UID: &str = "12345678-1234-4234-9234-123456789abc";

fn answers() -> Answers {
    Answers {
        deployment_name: "openclaw-nvidia-hosted".into(),
        sandbox_name: "assistant".into(),
        agent_name: "primary".into(),
        harness: HarnessChoice::OpenClaw,
        runtime: RuntimeChoice::Docker,
        inference: InferenceChoice::NvidiaHosted,
        api: ApiChoice::OpenAiCompletions,
        provider_name: "hosted-nvidia-prod".into(),
        model: "nvidia/nemotron-3-super-120b-a12b".into(),
        credential_env: "NVIDIA_INFERENCE_API_KEY".into(),
    }
}

#[test]
fn fixed_hosted_openclaw_answers_project_to_parser_accepted_intent() {
    let capabilities = Capabilities::available();
    assert_eq!(
        capabilities
            .scenario(
                HarnessChoice::OpenClaw,
                RuntimeChoice::Docker,
                InferenceChoice::NvidiaHosted,
                ApiChoice::OpenAiCompletions,
            )
            .unwrap()
            .models,
        [NVIDIA_MODEL]
    );
    let session = Session::with_uid(UID).unwrap();
    let first = session.project(&capabilities, &answers()).unwrap();
    let second = session.project(&capabilities, &answers()).unwrap();
    assert_eq!(first.yaml(), second.yaml());
    assert!(!first.yaml().contains("nvapi-"));

    let document = first.document();
    assert_eq!(document.metadata.name, "openclaw-nvidia-hosted");
    assert_eq!(document.metadata.uid, UID);
    assert!(matches!(document.spec.gateway, Gateway::Managed(_)));
    assert_eq!(
        document.spec.gateway.as_managed().unwrap().image,
        nemoclaw_sdk::config::DEFAULT_GATEWAY_IMAGE
    );
    let provider = document.inference_provider().unwrap();
    assert_eq!(provider.name, "hosted-nvidia-prod");
    assert_eq!(provider.provider, "openai");
    assert_eq!(provider.endpoint, "https://integrate.api.nvidia.com/v1");
    assert_eq!(document.credential_names(), ["NVIDIA_INFERENCE_API_KEY"]);
    let sandbox = &document.spec.sandboxes[0];
    assert_eq!(document.sandbox_harness(sandbox).unwrap().kind, "openclaw");
    assert_eq!(sandbox.runtime.provider, "docker");
    assert!(first.yaml().contains("runtime:"));
    let policy = &sandbox.network.policy.as_ref().unwrap().explicit;
    let process = policy.process.as_ref().unwrap();
    assert_eq!(process.run_as_user.as_deref(), Some("1000"));
    assert_eq!(process.run_as_group.as_deref(), Some("1000"));
    let hosted = &policy.network_policies["hosted-inference"];
    assert_eq!(hosted.name, "hosted-inference");
    assert_eq!(
        hosted.endpoints[0].host.as_deref(),
        Some("integrate.api.nvidia.com")
    );
    assert_eq!(hosted.endpoints[0].port, Some(443));
    assert_eq!(hosted.binaries[0].path, "/usr/bin/openclaw");
    let filesystem = policy.filesystem_policy.as_ref().unwrap();
    assert_eq!(filesystem.include_workdir, Some(true));
    assert_eq!(
        filesystem.read_write.as_ref().unwrap().as_slice(),
        ["/sandbox"]
    );
    for path in ["/usr", "/opt/fabric", "/opt/nemoclaw", "/app"] {
        assert!(
            filesystem
                .read_only
                .as_ref()
                .unwrap()
                .iter()
                .any(|candidate| candidate == path),
            "policy must retain {path} as read-only"
        );
    }
    let route = &document.sandbox_inference(sandbox).unwrap().routes[0];
    assert_eq!(route.provider_ref.as_deref(), Some("hosted-nvidia-prod"));
    assert_eq!(route.overrides.model, "nvidia/nemotron-3-super-120b-a12b");
}

#[test]
fn representable_scenarios_share_one_parser_validated_table() {
    struct Scenario {
        name: &'static str,
        variation: &'static str,
        direct_inputs: AnswerOverrides,
        interactive_inputs: Answers,
        available_models: &'static [&'static str],
        expected_harness: &'static str,
        expected_api: InferenceApi,
        expected_binary: &'static str,
        expected_read_only: &'static str,
        credential_references: &'static [&'static str],
        completion_boundary: CompletionBoundary,
        authored_source_assertions: &'static [(&'static str, &'static str)],
    }

    let scenarios = [
        Scenario {
            name: "hosted OpenClaw completions",
            variation: "baseline OpenClaw harness with OpenAI Completions",
            direct_inputs: AnswerOverrides::default(),
            interactive_inputs: Answers {
                deployment_name: "openclaw-nvidia-hosted".into(),
                sandbox_name: "assistant".into(),
                agent_name: "primary".into(),
                harness: HarnessChoice::OpenClaw,
                runtime: RuntimeChoice::Docker,
                inference: InferenceChoice::NvidiaHosted,
                api: ApiChoice::OpenAiCompletions,
                provider_name: "hosted-nvidia-prod".into(),
                model: NVIDIA_MODEL.into(),
                credential_env: "NVIDIA_INFERENCE_API_KEY".into(),
            },
            available_models: &[NVIDIA_MODEL],
            expected_harness: "openclaw",
            expected_api: InferenceApi::OpenaiCompletions,
            expected_binary: "/usr/bin/openclaw",
            expected_read_only: "/app",
            credential_references: &["NVIDIA_INFERENCE_API_KEY"],
            completion_boundary: CompletionBoundary::GeneratedDesiredState,
            authored_source_assertions: &[("/spec/sandboxes/0/runtime/provider", "docker")],
        },
        Scenario {
            name: "hosted OpenClaw responses",
            variation: "same harness and provider with the OpenAI Responses API",
            direct_inputs: AnswerOverrides {
                deployment_name: Some("openclaw-responses".into()),
                api: Some(ApiChoice::OpenAiResponses),
                provider_name: Some("responses-nvidia".into()),
                credential_env: Some("NVIDIA_RESPONSES_API_KEY".into()),
                ..AnswerOverrides::default()
            },
            interactive_inputs: Answers {
                deployment_name: "openclaw-responses".into(),
                sandbox_name: "assistant".into(),
                agent_name: "primary".into(),
                harness: HarnessChoice::OpenClaw,
                runtime: RuntimeChoice::Docker,
                inference: InferenceChoice::NvidiaHosted,
                api: ApiChoice::OpenAiResponses,
                provider_name: "responses-nvidia".into(),
                model: NVIDIA_MODEL.into(),
                credential_env: "NVIDIA_RESPONSES_API_KEY".into(),
            },
            available_models: &[NVIDIA_MODEL],
            expected_harness: "openclaw",
            expected_api: InferenceApi::OpenaiResponses,
            expected_binary: "/usr/bin/openclaw",
            expected_read_only: "/app",
            credential_references: &["NVIDIA_RESPONSES_API_KEY"],
            completion_boundary: CompletionBoundary::GeneratedDesiredState,
            authored_source_assertions: &[("/spec/inferenceProviders/0/api", "openai-responses")],
        },
        Scenario {
            name: "hosted Hermes completions",
            variation: "Hermes harness policy and filesystem requirements",
            direct_inputs: AnswerOverrides {
                deployment_name: Some("hermes-nvidia-hosted".into()),
                sandbox_name: Some("hermes-assistant".into()),
                agent_name: Some("hermes".into()),
                harness: Some(HarnessChoice::Hermes),
                provider_name: Some("hermes-nvidia".into()),
                credential_env: Some("HERMES_INFERENCE_API_KEY".into()),
                ..AnswerOverrides::default()
            },
            interactive_inputs: Answers {
                deployment_name: "hermes-nvidia-hosted".into(),
                sandbox_name: "hermes-assistant".into(),
                agent_name: "hermes".into(),
                harness: HarnessChoice::Hermes,
                runtime: RuntimeChoice::Docker,
                inference: InferenceChoice::NvidiaHosted,
                api: ApiChoice::OpenAiCompletions,
                provider_name: "hermes-nvidia".into(),
                model: NVIDIA_MODEL.into(),
                credential_env: "HERMES_INFERENCE_API_KEY".into(),
            },
            available_models: &[NVIDIA_MODEL],
            expected_harness: "hermes",
            expected_api: InferenceApi::OpenaiCompletions,
            expected_binary: "/opt/fabric/bin/python",
            expected_read_only: "/opt/hermes",
            credential_references: &["HERMES_INFERENCE_API_KEY"],
            completion_boundary: CompletionBoundary::GeneratedDesiredState,
            authored_source_assertions: &[("/spec/sandboxes/0/harness/kind", "hermes")],
        },
    ];

    let capabilities = Capabilities::available();
    for scenario in scenarios {
        assert!(!scenario.variation.is_empty());
        let direct_answers =
            Answers::onboarding_defaults().with_overrides(scenario.direct_inputs.clone());
        let interactive_answers = scenario.interactive_inputs.clone();
        assert_eq!(direct_answers, interactive_answers, "{}", scenario.name);
        let capability = capabilities
            .scenario(
                direct_answers.harness,
                direct_answers.runtime,
                direct_answers.inference,
                direct_answers.api,
            )
            .unwrap_or_else(|| panic!("{}: capability is unavailable", scenario.name));
        assert_eq!(
            capability.models, scenario.available_models,
            "{}",
            scenario.name
        );
        let session = Session::with_uid(UID).unwrap();
        let authored = session
            .project(&capabilities, &direct_answers)
            .unwrap_or_else(|error| panic!("{} direct: {error}", scenario.name));
        let interactive = session
            .project(&capabilities, &interactive_answers)
            .unwrap_or_else(|error| panic!("{} interactive: {error}", scenario.name));
        assert_eq!(
            authored.yaml(),
            interactive.yaml(),
            "{} direct and interactive answers",
            scenario.name
        );
        assert_eq!(
            authored.completion_boundary(),
            scenario.completion_boundary,
            "{}",
            scenario.name
        );
        let reparsed = Document::parse(authored.yaml().as_bytes()).unwrap();
        assert_eq!(&reparsed, authored.document());
        let reopened = Draft::from_yaml(&capabilities, authored.yaml().as_bytes()).unwrap();
        let review = reopened.review(&capabilities).unwrap();
        assert_eq!(
            review.harness_kind(),
            scenario.expected_harness,
            "{}",
            scenario.name
        );
        assert_eq!(review.api(), scenario.expected_api, "{}", scenario.name);
        assert_eq!(reparsed.metadata.name, direct_answers.deployment_name);
        assert_eq!(reparsed.metadata.uid, UID);
        assert!(matches!(reparsed.spec.gateway, Gateway::Managed(_)));
        let provider = reparsed.inference_provider().unwrap();
        assert_eq!(provider.name, direct_answers.provider_name);
        assert_eq!(provider.provider, "openai");
        assert_eq!(
            provider.api,
            Some(scenario.expected_api),
            "{}",
            scenario.name
        );
        assert_eq!(provider.endpoint, "https://integrate.api.nvidia.com/v1");
        assert_eq!(
            provider.credential.as_ref().unwrap().env,
            direct_answers.credential_env
        );
        assert_eq!(
            reparsed.credential_names(),
            scenario.credential_references,
            "{}",
            scenario.name
        );
        let sandbox = &reparsed.spec.sandboxes[0];
        assert_eq!(sandbox.name, direct_answers.sandbox_name);
        assert_eq!(
            reparsed.sandbox_harness(sandbox).unwrap().kind,
            scenario.expected_harness,
            "{}",
            scenario.name
        );
        assert_eq!(sandbox.runtime.provider, "docker");
        let agent = &sandbox.agent;
        assert_eq!(agent.name, direct_answers.agent_name);
        let route = &reparsed.sandbox_inference(sandbox).unwrap().routes[0];
        assert_eq!(route.provider_ref.as_deref(), Some(provider.name.as_str()));
        assert_eq!(route.overrides.model, direct_answers.model);
        let policy = &sandbox.network.policy.as_ref().unwrap().explicit;
        let process = policy.process.as_ref().unwrap();
        assert_eq!(process.run_as_user.as_deref(), Some("1000"));
        assert_eq!(process.run_as_group.as_deref(), Some("1000"));
        let hosted = &policy.network_policies["hosted-inference"];
        assert_eq!(hosted.name, "hosted-inference");
        assert_eq!(
            hosted.endpoints[0].host.as_deref(),
            Some("integrate.api.nvidia.com")
        );
        assert_eq!(hosted.endpoints[0].port, Some(443));
        assert_eq!(
            hosted.binaries[0].path, scenario.expected_binary,
            "{}",
            scenario.name
        );
        let filesystem = policy.filesystem_policy.as_ref().unwrap();
        assert_eq!(filesystem.include_workdir, Some(true));
        assert_eq!(
            filesystem.read_only.as_ref().unwrap(),
            &[
                "/usr",
                "/opt/fabric",
                "/opt/nemoclaw",
                scenario.expected_read_only
            ]
        );
        assert_eq!(filesystem.read_write.as_ref().unwrap(), &["/sandbox"]);
        let source: serde_json::Value = serde_saphyr::from_str(authored.yaml()).unwrap();
        for (path, expected) in scenario.authored_source_assertions {
            assert_eq!(
                source.pointer(path).and_then(serde_json::Value::as_str),
                Some(*expected),
                "{} source path {path}",
                scenario.name
            );
        }
    }
}

#[test]
fn unsupported_answers_return_field_diagnostics_without_approximation() {
    let mut unsupported = answers();
    unsupported.model = "unoffered/model".into();
    let diagnostics = Session::with_uid(UID)
        .unwrap()
        .project(&Capabilities::available(), &unsupported)
        .unwrap_err();
    assert_eq!(diagnostics.items()[0].field(), "model");
    assert!(diagnostics.items()[0].message().contains("not available"));

    let mut unavailable_combination = answers();
    unavailable_combination.harness = HarnessChoice::Hermes;
    unavailable_combination.api = ApiChoice::OpenAiResponses;
    let diagnostics = Session::with_uid(UID)
        .unwrap()
        .project(&Capabilities::available(), &unavailable_combination)
        .unwrap_err();
    assert_eq!(diagnostics.items()[0].field(), "api");
    assert!(diagnostics.items()[0].message().contains("not available"));
}

#[test]
fn semantic_edits_preserve_uid_and_unaffected_answers() {
    let capabilities = Capabilities::available();
    let mut draft = Draft::new(Session::with_uid(UID).unwrap(), answers());
    let initial_answers = draft.answers.clone();
    let initial = draft.review(&capabilities).unwrap();
    assert_eq!(initial.uid(), UID);
    assert!(!initial.yaml().contains("nvapi-"));

    draft
        .edit_inference(
            &capabilities,
            InferenceEdits {
                provider_name: Some("edited-provider".into()),
                model: None,
                credential_env: Some("EDITED_INFERENCE_KEY".into()),
            },
        )
        .unwrap();
    let inference_edit = draft.review(&capabilities).unwrap();
    assert_eq!(inference_edit.uid(), UID);
    assert_eq!(inference_edit.deployment_name(), "openclaw-nvidia-hosted");
    assert_eq!(inference_edit.sandbox_name(), "assistant");
    assert_eq!(inference_edit.agent_name(), "primary");
    assert_eq!(inference_edit.provider_name(), "edited-provider");
    assert_eq!(
        draft.answers.deployment_name,
        initial_answers.deployment_name
    );
    assert_eq!(draft.answers.sandbox_name, initial_answers.sandbox_name);
    assert_eq!(draft.answers.agent_name, initial_answers.agent_name);
    assert_eq!(draft.answers.harness, initial_answers.harness);
    assert_eq!(draft.answers.runtime, initial_answers.runtime);
    assert_eq!(draft.answers.inference, initial_answers.inference);
    assert_eq!(draft.answers.api, initial_answers.api);
    assert_eq!(draft.answers.model, initial_answers.model);
    assert_eq!(
        inference_edit.credential_references(),
        ["EDITED_INFERENCE_KEY"]
    );
    assert!(
        draft
            .edit_inference(
                &capabilities,
                InferenceEdits {
                    provider_name: None,
                    model: Some("unsupported/model".into()),
                    credential_env: None,
                },
            )
            .is_err()
    );
    assert_eq!(
        draft.review(&capabilities).unwrap().provider_name(),
        "edited-provider"
    );

    draft
        .edit_identity(
            &capabilities,
            IdentityEdits {
                deployment_name: Some("edited-deployment".into()),
                sandbox_name: Some("edited-sandbox".into()),
                agent_name: None,
            },
        )
        .unwrap();
    let identity_edit = draft.review(&capabilities).unwrap();
    assert_eq!(identity_edit.uid(), UID);
    assert_eq!(identity_edit.deployment_name(), "edited-deployment");
    assert_eq!(identity_edit.sandbox_name(), "edited-sandbox");
    assert_eq!(identity_edit.agent_name(), "primary");
    assert_eq!(identity_edit.provider_name(), "edited-provider");
    assert_eq!(draft.answers.harness, initial_answers.harness);
    assert_eq!(draft.answers.runtime, initial_answers.runtime);
    assert_eq!(draft.answers.inference, initial_answers.inference);
    assert_eq!(draft.answers.api, initial_answers.api);
    assert_eq!(draft.answers.model, initial_answers.model);
    assert_eq!(draft.answers.provider_name, "edited-provider");
    assert_eq!(draft.answers.credential_env, "EDITED_INFERENCE_KEY");
    assert_eq!(
        identity_edit.credential_references(),
        ["EDITED_INFERENCE_KEY"]
    );
}

#[test]
fn existing_generated_yaml_reopens_as_a_semantic_draft_with_the_same_uid() {
    let capabilities = Capabilities::available();
    let generated = Session::with_uid(UID)
        .unwrap()
        .project(&capabilities, &answers())
        .unwrap();
    let reopened = Draft::from_yaml(&capabilities, generated.yaml().as_bytes()).unwrap();
    let review = reopened.review(&capabilities).unwrap();
    assert_eq!(review.uid(), UID);
    assert_eq!(review.deployment_name(), "openclaw-nvidia-hosted");
    assert_eq!(review.provider_name(), "hosted-nvidia-prod");
    assert_eq!(review.credential_references(), ["NVIDIA_INFERENCE_API_KEY"]);
}
