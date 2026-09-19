// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use nemoclaw_authoring::{
    AnswerOverrides, Answers, ApiChoice, AuthoredDocument, Capabilities, HarnessChoice, Session,
};
use nemoclaw_sdk::config::{Document, MAX_DOCUMENT_BYTES};
use serde_json::{Value, json};

#[test]
fn default_onboarding_authors_openclaw_with_hosted_nvidia() {
    let authored = author_onboarding(AnswerOverrides::default());
    let reparsed = Document::parse(authored.yaml().as_bytes()).unwrap();
    let desired = normalized(&reparsed);
    assert!(authored.yaml().len() as u64 <= MAX_DOCUMENT_BYTES);
    assert_eq!(&reparsed, authored.document());
    assert_eq!(reparsed.metadata.name, "openclaw-nvidia-hosted");
    assert_eq!(
        desired["spec"]["sandboxes"][0]["harness"]["kind"],
        "openclaw"
    );
    assert_eq!(
        desired["spec"]["sandboxes"][0]["runtime"]["provider"],
        "docker"
    );
    assert_eq!(
        desired["spec"]["inferenceProviders"][0]["provider"],
        "openai"
    );
    assert_eq!(
        desired["spec"]["inferenceProviders"][0]["api"],
        "openai-completions"
    );
    assert_eq!(
        desired["spec"]["inferenceProviders"][0]["endpoint"],
        "https://integrate.api.nvidia.com/v1"
    );
    assert_eq!(reparsed.credential_names(), ["NVIDIA_INFERENCE_API_KEY"]);
}

#[test]
fn onboarding_authors_openclaw_with_the_responses_api() {
    let authored = author_onboarding(AnswerOverrides {
        deployment_name: Some("openclaw-responses".into()),
        api: Some(ApiChoice::OpenAiResponses),
        credential_env: Some("NVIDIA_RESPONSES_API_KEY".into()),
        ..AnswerOverrides::default()
    });
    let document = Document::parse(authored.yaml().as_bytes()).unwrap();
    let desired = normalized(&document);
    assert_eq!(document.metadata.name, "openclaw-responses");
    assert_eq!(
        desired["spec"]["sandboxes"][0]["harness"]["kind"],
        "openclaw"
    );
    assert_eq!(
        desired["spec"]["inferenceProviders"][0]["api"],
        "openai-responses"
    );
    assert_eq!(document.credential_names(), ["NVIDIA_RESPONSES_API_KEY"]);
}

#[test]
fn onboarding_authors_hermes_with_hosted_nvidia() {
    let authored = author_onboarding(AnswerOverrides {
        deployment_name: Some("hermes-nvidia-hosted".into()),
        harness: Some(HarnessChoice::Hermes),
        ..AnswerOverrides::default()
    });
    let document = Document::parse(authored.yaml().as_bytes()).unwrap();
    let desired = normalized(&document);
    assert_eq!(document.metadata.name, "hermes-nvidia-hosted");
    assert_eq!(desired["spec"]["sandboxes"][0]["harness"]["kind"], "hermes");
    assert_eq!(
        desired["spec"]["inferenceProviders"][0]["api"],
        "openai-completions"
    );
    assert_eq!(document.credential_names(), ["NVIDIA_INFERENCE_API_KEY"]);
}

#[test]
fn anthropic_with_claude_should_work() {
    let desired = DesiredState::from_yaml(include_bytes!("../../../examples/fabric-claude.yaml"))
        .provider_endpoint("https://api.anthropic.com/v1")
        .provider_credential("ANTHROPIC_API_KEY");
    let document = Document::parse(desired.yaml().as_bytes()).unwrap();
    let desired = normalized(&document);
    assert_eq!(
        desired["spec"]["inferenceProviders"][0]["provider"],
        "anthropic"
    );
    assert_eq!(
        desired["spec"]["inferenceProviders"][0]["endpoint"],
        "https://api.anthropic.com/v1"
    );
    assert_eq!(desired["spec"]["sandboxes"][0]["harness"]["kind"], "claude");
    assert_eq!(document.credential_names(), ["ANTHROPIC_API_KEY"]);
}

#[test]
fn anthropic_compatible_endpoint_should_work() {
    let desired = DesiredState::from_yaml(include_bytes!("../../../examples/fabric-claude.yaml"))
        .provider_endpoint("https://anthropic.example.com/v1")
        .provider_credential("COMPATIBLE_ANTHROPIC_API_KEY");
    let document = Document::parse(desired.yaml().as_bytes()).unwrap();
    let desired = normalized(&document);
    assert_eq!(
        desired["spec"]["inferenceProviders"][0]["provider"],
        "anthropic"
    );
    assert_eq!(
        desired["spec"]["inferenceProviders"][0]["endpoint"],
        "https://anthropic.example.com/v1"
    );
    assert_eq!(
        document.credential_names(),
        ["COMPATIBLE_ANTHROPIC_API_KEY"]
    );
}

#[test]
fn openai_compatible_endpoint_with_tuning_should_work() {
    let desired =
        DesiredState::from_yaml(include_bytes!("../../../examples/inference-tuning.yaml"))
            .provider_credential("COMPATIBLE_API_KEY");
    let document = Document::parse(desired.yaml().as_bytes()).unwrap();
    let desired = normalized(&document);
    let overrides =
        &desired["spec"]["sandboxes"][0]["agent"]["inference"]["routes"][0]["overrides"];
    assert_eq!(
        desired["spec"]["inferenceProviders"][0]["api"],
        "openai-responses"
    );
    assert_eq!(
        desired["spec"]["inferenceProviders"][0]["endpoint"],
        "https://inference.example.com/v1"
    );
    assert_eq!(document.credential_names(), ["COMPATIBLE_API_KEY"]);
    assert_eq!(overrides["reasoningEffort"], "high");
    assert_eq!(overrides["contextWindow"], 65536);
    assert_eq!(overrides["maxTokens"], 8192);
    assert_eq!(overrides["reasoning"], true);
}

#[test]
fn openai_endpoint_should_work() {
    let desired =
        DesiredState::from_yaml(include_bytes!("../../../examples/inference-tuning.yaml"))
            .provider_endpoint("https://api.openai.com/v1")
            .provider_credential("OPENAI_API_KEY");
    let document = Document::parse(desired.yaml().as_bytes()).unwrap();
    let desired = normalized(&document);
    assert_eq!(
        desired["spec"]["inferenceProviders"][0]["endpoint"],
        "https://api.openai.com/v1"
    );
    assert_eq!(document.credential_names(), ["OPENAI_API_KEY"]);
}

#[test]
fn openrouter_endpoint_should_work() {
    let desired =
        DesiredState::from_yaml(include_bytes!("../../../examples/inference-tuning.yaml"))
            .provider_endpoint("https://openrouter.ai/api/v1")
            .provider_credential("OPENROUTER_API_KEY");
    let document = Document::parse(desired.yaml().as_bytes()).unwrap();
    let desired = normalized(&document);
    assert_eq!(
        desired["spec"]["inferenceProviders"][0]["endpoint"],
        "https://openrouter.ai/api/v1"
    );
    assert_eq!(document.credential_names(), ["OPENROUTER_API_KEY"]);
}

#[test]
fn deep_agents_should_work() {
    let yaml = include_bytes!("../../../examples/fabric.yaml");
    let document = Document::parse(yaml.as_slice()).unwrap();
    let desired = normalized(&document);
    assert_eq!(
        desired["spec"]["sandboxes"][0]["harness"]["kind"],
        "deepagents"
    );
}

#[test]
fn multiple_openclaw_sandboxes_with_policy_tools_and_observability_should_work() {
    let yaml = include_bytes!("../../../examples/full-featured-openclaw.yaml");
    let document = Document::parse(yaml.as_slice()).unwrap();
    let desired = normalized(&document);
    let sandboxes = desired["spec"]["sandboxes"].as_array().unwrap();
    assert_eq!(sandboxes.len(), 3);
    assert_eq!(sandboxes[0]["agent"]["name"], "researcher");
    assert_eq!(sandboxes[1]["agent"]["name"], "writer");
    assert_eq!(sandboxes[2]["agent"]["name"], "reader");
    assert_eq!(sandboxes[2]["agent"]["tools"]["allow"], json!(["read"]));
    assert_eq!(sandboxes[0]["agent"]["tools"]["disclosure"], "progressive");
    assert_eq!(sandboxes[0]["network"]["proxy"]["host"], "10.200.0.1");
    assert_eq!(sandboxes[0]["network"]["proxy"]["port"], 3128);
    assert_eq!(
        desired["spec"]["harnesses"]["assistant"]["observability"]["otlp"]["enabled"],
        true
    );
    assert_eq!(
        desired["spec"]["harnesses"]["assistant"]["execution"]["timeoutSeconds"],
        900
    );
}

#[test]
fn pi_with_native_model_metadata_should_work() {
    let yaml = include_bytes!("../../../examples/fabric-pi.yaml");
    let document = Document::parse(yaml.as_slice()).unwrap();
    let desired = normalized(&document);
    assert_eq!(desired["spec"]["sandboxes"][0]["harness"]["kind"], "pi");
    assert_eq!(
        desired["spec"]["sandboxes"][0]["agent"]["inference"]["routes"][0]["overrides"]["piModel"]
            ["api"],
        "openai-completions"
    );
}

#[test]
fn managed_ollama_should_work() {
    let yaml = include_bytes!("../../../examples/managed-ollama.yaml");
    let document = Document::parse(yaml.as_slice()).unwrap();
    let desired = normalized(&document);
    assert!(desired["spec"]["inferenceProviders"][0]["ollama"].is_object());
}

#[test]
fn managed_vllm_should_work() {
    let yaml = include_bytes!("../../../examples/nemotron-amd64.yaml");
    let document = Document::parse(yaml.as_slice()).unwrap();
    let desired = normalized(&document);
    assert_eq!(
        desired["spec"]["inferenceProviders"][0]["service"]["backend"],
        "vllm"
    );
    assert_eq!(
        desired["spec"]["inferenceProviders"][0]["service"]["hardware"]["minComputeCapability"],
        90
    );
}

#[test]
fn external_ollama_proxy_should_work() {
    let desired = DesiredState::from_yaml(include_bytes!("../../../examples/managed-ollama.yaml"))
        .external_ollama_proxy();
    let document = Document::parse(desired.yaml().as_bytes()).unwrap();
    let desired = normalized(&document);
    assert_eq!(
        desired["spec"]["inferenceProviders"][0]["endpoint"],
        "http://127.0.0.1:11434/v1"
    );
    assert_eq!(
        desired["spec"]["inferenceProviders"][0]["ollamaProxy"]["endpoint"],
        "http://172.20.0.1:11435/v1"
    );
}

#[test]
fn managed_podman_with_an_explicit_gateway_port_should_work() {
    let desired = DesiredState::from_yaml(include_bytes!("../../../examples/managed-podman.yaml"))
        .gateway_endpoint("http://127.0.0.1:17891");
    let document = Document::parse(desired.yaml().as_bytes()).unwrap();
    let desired = normalized(&document);
    assert_eq!(desired["spec"]["gateway"]["management"], "managed");
    assert_eq!(
        desired["spec"]["gateway"]["engine"],
        "unix:///run/user/1000/podman/podman.sock"
    );
    assert_eq!(
        desired["spec"]["gateway"]["endpoint"],
        "http://127.0.0.1:17891"
    );
    assert_eq!(
        desired["spec"]["sandboxes"][0]["runtime"]["provider"],
        "podman"
    );
}

#[test]
fn openclaw_dashboard_should_work() {
    let yaml = include_bytes!("../../../examples/openclaw-dashboard.yaml");
    let document = Document::parse(yaml.as_slice()).unwrap();
    let desired = normalized(&document);
    assert_eq!(
        desired["spec"]["sandboxes"][0]["harness"]["interfaces"]["dashboard"]["port"],
        18800
    );
}

#[test]
fn hermes_api_dashboard_and_tui_should_work() {
    let yaml = include_bytes!("../../../examples/hermes-interfaces.yaml");
    let document = Document::parse(yaml.as_slice()).unwrap();
    let desired = normalized(&document);
    let interfaces = &desired["spec"]["sandboxes"][0]["harness"]["interfaces"];
    assert_eq!(desired["spec"]["sandboxes"][0]["harness"]["kind"], "hermes");
    assert_eq!(interfaces["api"]["port"], 8643);
    assert_eq!(interfaces["dashboard"]["enabled"], true);
    assert_eq!(interfaces["dashboard"]["port"], 18800);
    assert_eq!(interfaces["dashboard"]["internalPort"], 19120);
    assert_eq!(interfaces["dashboard"]["tui"]["enabled"], true);
}

#[test]
fn brave_web_search_should_work() {
    let yaml = include_bytes!("../../../examples/openclaw-web-search.yaml");
    let document = Document::parse(yaml.as_slice()).unwrap();
    let desired = normalized(&document);
    assert_eq!(
        desired["spec"]["integrations"]["search"]["kind"],
        "webSearch"
    );
    assert_eq!(
        desired["spec"]["integrations"]["search"]["credential"]["env"],
        "BRAVE_API_KEY"
    );
    assert_eq!(document.credential_names(), ["BRAVE_API_KEY"]);
}

#[test]
fn invalid_sandbox_names_are_rejected() {
    let desired = DesiredState::from_onboarding().sandbox_name("Not A DNS Label");
    let result = Document::parse(desired.yaml().as_bytes());
    assert!(
        result.is_err(),
        "sandbox names must remain valid DNS labels"
    );
}

#[test]
fn image_input_modalities_are_not_supported_yet() {
    let desired = DesiredState::from_onboarding().inference_inputs(&["text", "image"]);
    let result = Document::parse(desired.yaml().as_bytes());
    assert!(
        result.is_err(),
        "onboarding should eventually preserve model input modalities"
    );
}

#[test]
fn gemini_is_not_supported_yet() {
    let desired = DesiredState::from_onboarding().provider_kind("google", "gemini-generate");
    let result = Document::parse(desired.yaml().as_bytes());
    assert!(
        result.is_err(),
        "onboarding should eventually support Gemini providers"
    );
}

#[test]
fn llama_cpp_is_not_supported_yet() {
    let desired = DesiredState::from_yaml(include_bytes!("../../../examples/nemotron-amd64.yaml"))
        .service_backend("llamacpp");
    let result = Document::parse(desired.yaml().as_bytes());
    assert!(
        result.is_err(),
        "onboarding should eventually support llama.cpp services"
    );
}

#[test]
fn model_routing_is_not_supported_yet() {
    let desired = DesiredState::from_onboarding().model_router();
    let result = Document::parse(desired.yaml().as_bytes());
    assert!(
        result.is_err(),
        "onboarding should eventually preserve model-routing intent"
    );
}

#[test]
fn sandbox_resource_sizing_is_not_supported_yet() {
    let desired = DesiredState::from_onboarding().sandbox_resources();
    let result = Document::parse(desired.yaml().as_bytes());
    assert!(
        result.is_err(),
        "onboarding should eventually preserve sandbox resource sizing"
    );
}

#[test]
fn serving_profile_provenance_is_not_supported_yet() {
    let desired = DesiredState::from_onboarding().serving_profile();
    let result = Document::parse(desired.yaml().as_bytes());
    assert!(
        result.is_err(),
        "onboarding should eventually preserve serving-profile provenance"
    );
}

#[test]
fn sandbox_gpu_selection_is_not_supported_yet() {
    let desired = DesiredState::from_onboarding().sandbox_gpu();
    let result = Document::parse(desired.yaml().as_bytes());
    assert!(
        result.is_err(),
        "onboarding should eventually preserve sandbox GPU selection"
    );
}

#[test]
fn host_mounts_are_not_supported_yet() {
    let desired = DesiredState::from_onboarding().host_mount();
    let result = Document::parse(desired.yaml().as_bytes());
    assert!(
        result.is_err(),
        "onboarding should eventually preserve read-only host mounts"
    );
}

#[test]
fn hermes_provider_tools_are_not_supported_yet() {
    let desired = DesiredState::from_onboarding().hermes_provider_tools();
    let result = Document::parse(desired.yaml().as_bytes());
    assert!(
        result.is_err(),
        "onboarding should eventually preserve Hermes provider tools"
    );
}

#[test]
fn trusted_private_hosts_are_not_supported_yet() {
    let desired = DesiredState::from_onboarding().trusted_private_hosts();
    let result = Document::parse(desired.yaml().as_bytes());
    assert!(
        result.is_err(),
        "onboarding should eventually preserve trusted private hosts"
    );
}

#[test]
fn tavily_search_is_not_supported_yet() {
    let desired =
        DesiredState::from_yaml(include_bytes!("../../../examples/openclaw-web-search.yaml"))
            .search_provider("tavily", "TAVILY_API_KEY");
    let result = Document::parse(desired.yaml().as_bytes());
    assert!(
        result.is_err(),
        "onboarding should eventually support Tavily search"
    );
}

#[test]
fn messaging_channels_are_not_supported_yet() {
    let desired = DesiredState::from_onboarding().messaging_channel();
    let result = Document::parse(desired.yaml().as_bytes());
    assert!(
        result.is_err(),
        "onboarding should eventually preserve messaging channels"
    );
}

const UID: &str = "12345678-1234-4234-9234-123456789abc";

fn author_onboarding(inputs: AnswerOverrides) -> AuthoredDocument {
    Session::with_uid(UID)
        .unwrap()
        .project(
            &Capabilities::available(),
            &Answers::onboarding_defaults().with_overrides(inputs),
        )
        .unwrap()
}

fn normalized(document: &Document) -> Value {
    serde_json::to_value(document).unwrap()
}

struct DesiredState {
    value: Value,
}

impl DesiredState {
    fn from_onboarding() -> Self {
        Self::from_yaml(
            author_onboarding(AnswerOverrides::default())
                .yaml()
                .as_bytes(),
        )
    }

    fn from_yaml(yaml: &[u8]) -> Self {
        Self {
            value: serde_saphyr::from_slice(yaml).unwrap(),
        }
    }

    fn provider_endpoint(mut self, endpoint: &str) -> Self {
        self.value["spec"]["inferenceProviders"][0]["endpoint"] = json!(endpoint);
        self
    }

    fn provider_credential(mut self, environment_variable: &str) -> Self {
        self.value["spec"]["inferenceProviders"][0]["credential"] =
            json!({"env": environment_variable});
        self
    }

    fn provider_kind(mut self, provider: &str, api: &str) -> Self {
        self.value["spec"]["inferenceProviders"][0]["provider"] = json!(provider);
        self.value["spec"]["inferenceProviders"][0]["api"] = json!(api);
        self
    }

    fn inference_inputs(mut self, inputs: &[&str]) -> Self {
        self.value["spec"]["sandboxes"][0]["agent"]["inference"]["routes"][0]["overrides"]["input"] =
            json!(inputs);
        self
    }

    fn sandbox_name(mut self, name: &str) -> Self {
        self.value["spec"]["sandboxes"][0]["name"] = json!(name);
        self
    }

    fn service_backend(mut self, backend: &str) -> Self {
        self.value["spec"]["inferenceProviders"][0]["service"]["backend"] = json!(backend);
        self
    }

    fn model_router(mut self) -> Self {
        self.value["spec"]["modelRouter"] =
            json!({"profile": "balanced", "routes": ["hosted", "local"]});
        self
    }

    fn sandbox_resources(mut self) -> Self {
        self.value["spec"]["sandboxes"][0]["resources"] = json!({"cpu": "4", "memory": "16Gi"});
        self
    }

    fn serving_profile(mut self) -> Self {
        self.value["spec"]["servingProfile"] =
            json!({"id": "vllm.dgx-spark.example", "catalogDigest": "sha256:proposal"});
        self
    }

    fn sandbox_gpu(mut self) -> Self {
        self.value["spec"]["sandboxes"][0]["runtime"]["gpu"] =
            json!({"required": true, "device": "nvidia.com/gpu=0"});
        self
    }

    fn host_mount(mut self) -> Self {
        self.value["spec"]["sandboxes"][0]["runtime"]["hostMounts"] = json!([{
            "source": "/home/user/project",
            "target": "/sandbox/project",
            "readOnly": true
        }]);
        self
    }

    fn hermes_provider_tools(mut self) -> Self {
        self.value["spec"]["sandboxes"][0]["harness"]["providerAuthentication"] =
            json!({"method": "oauth"});
        self.value["spec"]["sandboxes"][0]["harness"]["toolGateways"] = json!(["nous-web"]);
        self.value["spec"]["sandboxes"][0]["credentialPlaceholderExtensions"] =
            json!(["TELEGRAM_BOT_TOKEN_AGENT_A"]);
        self
    }

    fn trusted_private_hosts(mut self) -> Self {
        self.value["spec"]["sandboxes"][0]["network"]["trustedPrivateHosts"] =
            json!(["10.10.0.12", "inference.corp.example"]);
        self
    }

    fn search_provider(mut self, provider: &str, credential: &str) -> Self {
        self.value["spec"]["integrations"]["search"]["provider"] = json!(provider);
        self.value["spec"]["integrations"]["search"]["credential"]["env"] = json!(credential);
        self
    }

    fn messaging_channel(mut self) -> Self {
        self.value["spec"]["sandboxes"][0]["channels"] =
            json!([{"kind": "slack", "credential": {"env": "SLACK_BOT_TOKEN"}}]);
        self
    }

    fn external_ollama_proxy(mut self) -> Self {
        let provider = &mut self.value["spec"]["inferenceProviders"][0];
        provider.as_object_mut().unwrap().remove("ollama");
        provider["management"] = json!("external");
        provider["endpoint"] = json!("http://127.0.0.1:11434/v1");
        provider["ollamaProxy"] = json!({
            "engine": "unix:///var/run/docker.sock",
            "image": format!("nc-ollama-proxy@sha256:{}", "a".repeat(64)),
            "endpoint": "http://172.20.0.1:11435/v1",
            "model": {"digest": "a".repeat(64)}
        });
        self
    }

    fn gateway_endpoint(mut self, endpoint: &str) -> Self {
        self.value["spec"]["gateway"]["endpoint"] = json!(endpoint);
        self
    }

    fn yaml(&self) -> String {
        serde_saphyr::to_string(&self.value).unwrap()
    }
}
