// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use nemoclaw_sdk::config::{Document, InferenceApi};
use serde_json::json;
use std::fmt;

const NVIDIA_MODEL: &str = "nvidia/nemotron-3-super-120b-a12b";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum HarnessChoice {
    OpenClaw,
    Hermes,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum RuntimeChoice {
    Docker,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum InferenceChoice {
    NvidiaHosted,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ApiChoice {
    OpenAiCompletions,
    OpenAiResponses,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Answers {
    pub(crate) deployment_name: String,
    pub(crate) sandbox_name: String,
    pub(crate) agent_name: String,
    pub(crate) harness: HarnessChoice,
    pub(crate) runtime: RuntimeChoice,
    pub(crate) inference: InferenceChoice,
    pub(crate) api: ApiChoice,
    pub(crate) provider_name: String,
    pub(crate) model: String,
    pub(crate) credential_env: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct DirectInputs {
    pub(crate) deployment_name: Option<String>,
    pub(crate) sandbox_name: Option<String>,
    pub(crate) agent_name: Option<String>,
    pub(crate) harness: Option<HarnessChoice>,
    pub(crate) runtime: Option<RuntimeChoice>,
    pub(crate) inference: Option<InferenceChoice>,
    pub(crate) api: Option<ApiChoice>,
    pub(crate) provider_name: Option<String>,
    pub(crate) model: Option<String>,
    pub(crate) credential_env: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct InteractiveInputs {
    pub(crate) deployment_name: String,
    pub(crate) sandbox_name: String,
    pub(crate) agent_name: String,
    pub(crate) harness: HarnessChoice,
    pub(crate) runtime: RuntimeChoice,
    pub(crate) inference: InferenceChoice,
    pub(crate) api: ApiChoice,
    pub(crate) provider_name: String,
    pub(crate) model: String,
    pub(crate) credential_env: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CompletionBoundary {
    GeneratedDesiredState,
}

#[derive(Clone, Debug)]
struct ScenarioCapability {
    harness: HarnessChoice,
    runtime: RuntimeChoice,
    inference: InferenceChoice,
    api: ApiChoice,
    harness_kind: &'static str,
    provider_kind: &'static str,
    provider_api: &'static str,
    endpoint: &'static str,
    network_binary: &'static str,
    filesystem_read_only: &'static str,
    models: &'static [&'static str],
}

#[derive(Clone, Debug)]
pub(crate) struct Capabilities {
    scenarios: Vec<ScenarioCapability>,
}

impl Capabilities {
    pub(crate) fn available() -> Self {
        Self {
            scenarios: vec![
                ScenarioCapability {
                    harness: HarnessChoice::OpenClaw,
                    runtime: RuntimeChoice::Docker,
                    inference: InferenceChoice::NvidiaHosted,
                    api: ApiChoice::OpenAiCompletions,
                    harness_kind: "openclaw",
                    provider_kind: "openai",
                    provider_api: "openai-completions",
                    endpoint: "https://integrate.api.nvidia.com/v1",
                    network_binary: "/usr/bin/openclaw",
                    filesystem_read_only: "/app",
                    models: &[NVIDIA_MODEL],
                },
                ScenarioCapability {
                    harness: HarnessChoice::OpenClaw,
                    runtime: RuntimeChoice::Docker,
                    inference: InferenceChoice::NvidiaHosted,
                    api: ApiChoice::OpenAiResponses,
                    harness_kind: "openclaw",
                    provider_kind: "openai",
                    provider_api: "openai-responses",
                    endpoint: "https://integrate.api.nvidia.com/v1",
                    network_binary: "/usr/bin/openclaw",
                    filesystem_read_only: "/app",
                    models: &[NVIDIA_MODEL],
                },
                ScenarioCapability {
                    harness: HarnessChoice::Hermes,
                    runtime: RuntimeChoice::Docker,
                    inference: InferenceChoice::NvidiaHosted,
                    api: ApiChoice::OpenAiCompletions,
                    harness_kind: "hermes",
                    provider_kind: "openai",
                    provider_api: "openai-completions",
                    endpoint: "https://integrate.api.nvidia.com/v1",
                    network_binary: "/opt/fabric/bin/python",
                    filesystem_read_only: "/opt/hermes",
                    models: &[NVIDIA_MODEL],
                },
            ],
        }
    }

    fn scenario(
        &self,
        harness: HarnessChoice,
        runtime: RuntimeChoice,
        inference: InferenceChoice,
        api: ApiChoice,
    ) -> Option<&ScenarioCapability> {
        self.scenarios.iter().find(|scenario| {
            scenario.harness == harness
                && scenario.runtime == runtime
                && scenario.inference == inference
                && scenario.api == api
        })
    }

    fn unavailable_field(&self, answers: &Answers) -> &'static str {
        if !self
            .scenarios
            .iter()
            .any(|row| row.harness == answers.harness)
        {
            return "harness";
        }
        if !self
            .scenarios
            .iter()
            .any(|row| row.harness == answers.harness && row.runtime == answers.runtime)
        {
            return "runtime";
        }
        if !self.scenarios.iter().any(|row| {
            row.harness == answers.harness
                && row.runtime == answers.runtime
                && row.inference == answers.inference
        }) {
            return "inference";
        }
        "api"
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Diagnostic {
    field: &'static str,
    message: String,
}

impl Diagnostic {
    #[cfg(test)]
    pub(crate) fn field(&self) -> &str {
        self.field
    }

    #[cfg(test)]
    pub(crate) fn message(&self) -> &str {
        &self.message
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Diagnostics {
    items: Vec<Diagnostic>,
}

impl Diagnostics {
    #[cfg(test)]
    pub(crate) fn items(&self) -> &[Diagnostic] {
        &self.items
    }
}

impl fmt::Display for Diagnostics {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        for (index, diagnostic) in self.items.iter().enumerate() {
            if index > 0 {
                formatter.write_str("; ")?;
            }
            write!(formatter, "{}: {}", diagnostic.field, diagnostic.message)?;
        }
        Ok(())
    }
}

impl std::error::Error for Diagnostics {}

#[derive(Debug)]
pub(crate) struct AuthoredDocument {
    yaml: String,
    document: Document,
    completion_boundary: CompletionBoundary,
}

impl AuthoredDocument {
    pub(crate) fn yaml(&self) -> &str {
        &self.yaml
    }

    pub(crate) fn document(&self) -> &Document {
        &self.document
    }

    pub(crate) fn completion_boundary(&self) -> CompletionBoundary {
        self.completion_boundary
    }
}

impl Answers {
    pub(crate) fn first_slice() -> Self {
        Self {
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
        }
    }

    pub(crate) fn from_direct(mut defaults: Self, inputs: DirectInputs) -> Self {
        defaults.deployment_name = inputs.deployment_name.unwrap_or(defaults.deployment_name);
        defaults.sandbox_name = inputs.sandbox_name.unwrap_or(defaults.sandbox_name);
        defaults.agent_name = inputs.agent_name.unwrap_or(defaults.agent_name);
        defaults.harness = inputs.harness.unwrap_or(defaults.harness);
        defaults.runtime = inputs.runtime.unwrap_or(defaults.runtime);
        defaults.inference = inputs.inference.unwrap_or(defaults.inference);
        defaults.api = inputs.api.unwrap_or(defaults.api);
        defaults.provider_name = inputs.provider_name.unwrap_or(defaults.provider_name);
        defaults.model = inputs.model.unwrap_or(defaults.model);
        defaults.credential_env = inputs.credential_env.unwrap_or(defaults.credential_env);
        defaults
    }

    pub(crate) fn from_interactive(inputs: InteractiveInputs) -> Self {
        Self {
            deployment_name: inputs.deployment_name,
            sandbox_name: inputs.sandbox_name,
            agent_name: inputs.agent_name,
            harness: inputs.harness,
            runtime: inputs.runtime,
            inference: inputs.inference,
            api: inputs.api,
            provider_name: inputs.provider_name,
            model: inputs.model,
            credential_env: inputs.credential_env,
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct IdentityEdits {
    pub(crate) deployment_name: Option<String>,
    pub(crate) sandbox_name: Option<String>,
    pub(crate) agent_name: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct InferenceEdits {
    pub(crate) provider_name: Option<String>,
    pub(crate) model: Option<String>,
    pub(crate) credential_env: Option<String>,
}

#[derive(Clone, Debug)]
pub(crate) struct Draft {
    session: Session,
    answers: Answers,
}

impl Draft {
    pub(crate) fn new(session: Session, answers: Answers) -> Self {
        Self { session, answers }
    }

    pub(crate) fn from_yaml(
        capabilities: &Capabilities,
        bytes: &[u8],
    ) -> Result<Self, Diagnostics> {
        let document =
            Document::parse(bytes).map_err(|error| diagnostic("document", &error.to_string()))?;
        let [sandbox] = document.spec.sandboxes.as_slice() else {
            return Err(diagnostic(
                "document",
                "editing requires one generated onboarding sandbox",
            ));
        };
        let agent = &sandbox.agent;
        let harness = match document
            .sandbox_harness(sandbox)
            .map(|value| value.kind.as_str())
        {
            Ok("openclaw") => HarnessChoice::OpenClaw,
            Ok("hermes") => HarnessChoice::Hermes,
            _ => {
                return Err(diagnostic(
                    "document",
                    "editing requires a supported harness",
                ));
            }
        };
        if sandbox.runtime.provider != "docker" {
            return Err(diagnostic(
                "document",
                "editing requires the Docker runtime",
            ));
        }
        let provider = document
            .inference_provider()
            .map_err(|_| diagnostic("document", "editing requires one selected provider"))?;
        let inference = document
            .agent_inference(agent)
            .map_err(|_| diagnostic("document", "editing requires inline agent inference"))?;
        let [route] = inference.routes.as_slice() else {
            return Err(diagnostic(
                "document",
                "editing requires one generated model route",
            ));
        };
        let credential_env = provider
            .credential
            .as_ref()
            .ok_or_else(|| diagnostic("document", "editing requires a credential reference"))?
            .env
            .clone();
        let api = match provider.api.unwrap_or_else(|| {
            InferenceApi::for_harness(match harness {
                HarnessChoice::OpenClaw => "openclaw",
                HarnessChoice::Hermes => "hermes",
            })
        }) {
            InferenceApi::OpenaiCompletions => ApiChoice::OpenAiCompletions,
            InferenceApi::OpenaiResponses => ApiChoice::OpenAiResponses,
            InferenceApi::AnthropicMessages => {
                return Err(diagnostic(
                    "document",
                    "editing requires a supported inference API",
                ));
            }
        };
        let answers = Answers {
            deployment_name: document.metadata.name.clone(),
            sandbox_name: sandbox.name.clone(),
            agent_name: agent.name.clone(),
            harness,
            runtime: RuntimeChoice::Docker,
            inference: InferenceChoice::NvidiaHosted,
            api,
            provider_name: provider.name.clone(),
            model: route.overrides.model.clone(),
            credential_env,
        };
        let draft = Self::new(Session::with_uid(&document.metadata.uid)?, answers);
        if draft.review(capabilities)?.document() != &document {
            return Err(diagnostic(
                "document",
                "editing supports only YAML generated by this onboarding scenario",
            ));
        }
        Ok(draft)
    }

    pub(crate) fn review(&self, capabilities: &Capabilities) -> Result<Review, Diagnostics> {
        Ok(Review {
            authored: self.session.project(capabilities, &self.answers)?,
        })
    }

    pub(crate) fn edit_identity(
        &mut self,
        capabilities: &Capabilities,
        edits: IdentityEdits,
    ) -> Result<(), Diagnostics> {
        let mut candidate = self.answers.clone();
        if let Some(value) = edits.deployment_name {
            candidate.deployment_name = value;
        }
        if let Some(value) = edits.sandbox_name {
            candidate.sandbox_name = value;
        }
        if let Some(value) = edits.agent_name {
            candidate.agent_name = value;
        }
        self.session.project(capabilities, &candidate)?;
        self.answers = candidate;
        Ok(())
    }

    pub(crate) fn edit_inference(
        &mut self,
        capabilities: &Capabilities,
        edits: InferenceEdits,
    ) -> Result<(), Diagnostics> {
        let mut candidate = self.answers.clone();
        if let Some(value) = edits.provider_name {
            candidate.provider_name = value;
        }
        if let Some(value) = edits.model {
            candidate.model = value;
        }
        if let Some(value) = edits.credential_env {
            candidate.credential_env = value;
        }
        self.session.project(capabilities, &candidate)?;
        self.answers = candidate;
        Ok(())
    }
}

#[derive(Debug)]
pub(crate) struct Review {
    authored: AuthoredDocument,
}

impl Review {
    pub(crate) fn uid(&self) -> &str {
        &self.authored.document.metadata.uid
    }

    pub(crate) fn deployment_name(&self) -> &str {
        &self.authored.document.metadata.name
    }

    pub(crate) fn sandbox_name(&self) -> &str {
        &self.authored.document.spec.sandboxes[0].name
    }

    pub(crate) fn agent_name(&self) -> &str {
        &self.authored.document.spec.sandboxes[0].agent.name
    }

    pub(crate) fn provider_name(&self) -> &str {
        &self.authored.document.spec.inference_providers[0].name
    }

    pub(crate) fn model(&self) -> &str {
        &self.authored.document.spec.sandboxes[0]
            .agent
            .inference
            .as_ref()
            .expect("generated review has inline inference")
            .routes[0]
            .overrides
            .model
    }

    pub(crate) fn credential_env(&self) -> &str {
        self.authored.document.spec.inference_providers[0]
            .credential
            .as_ref()
            .expect("generated review has a credential reference")
            .env
            .as_str()
    }

    pub(crate) fn credential_references(&self) -> Vec<&str> {
        self.authored.document.credential_names()
    }

    pub(crate) fn yaml(&self) -> &str {
        self.authored.yaml()
    }

    pub(crate) fn document(&self) -> &Document {
        self.authored.document()
    }

    pub(crate) fn render(&self) -> String {
        let route = &self.authored.document.spec.sandboxes[0]
            .agent
            .inference
            .as_ref()
            .expect("generated review has inline inference")
            .routes[0];
        let sandbox = &self.authored.document.spec.sandboxes[0];
        let harness = self
            .authored
            .document
            .sandbox_harness(sandbox)
            .expect("generated review has a harness");
        let api = match self.authored.document.spec.inference_providers[0]
            .api
            .unwrap_or_else(|| InferenceApi::for_harness(&harness.kind))
        {
            InferenceApi::OpenaiCompletions => "openai-completions",
            InferenceApi::OpenaiResponses => "openai-responses",
            InferenceApi::AnthropicMessages => "anthropic-messages",
        };
        format!(
            "Deployment: {}\nUID: {}\nSandbox: {}\nHarness: {}\nAgent: {}\nProvider: {}\nAPI: {}\nModel: {}\nCredential references: {}\n",
            self.deployment_name(),
            self.uid(),
            self.sandbox_name(),
            harness.kind,
            self.agent_name(),
            self.provider_name(),
            api,
            route.overrides.model,
            self.credential_references().join(", ")
        )
    }

    pub(crate) fn into_authored(self) -> AuthoredDocument {
        self.authored
    }
}

#[derive(Clone, Debug)]
pub(crate) struct Session {
    uid: String,
}

impl Session {
    pub(crate) fn new() -> Result<Self, Diagnostics> {
        let mut bytes = [0_u8; 16];
        getrandom::fill(&mut bytes)
            .map_err(|_| diagnostic("uid", "could not generate identity"))?;
        bytes[6] = (bytes[6] & 0x0f) | 0x40;
        bytes[8] = (bytes[8] & 0x3f) | 0x80;
        Self::with_uid(&format!(
            "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
            bytes[0],
            bytes[1],
            bytes[2],
            bytes[3],
            bytes[4],
            bytes[5],
            bytes[6],
            bytes[7],
            bytes[8],
            bytes[9],
            bytes[10],
            bytes[11],
            bytes[12],
            bytes[13],
            bytes[14],
            bytes[15]
        ))
    }

    pub(crate) fn with_uid(uid: &str) -> Result<Self, Diagnostics> {
        let valid = uid.len() == 36
            && uid.bytes().enumerate().all(|(index, byte)| match index {
                8 | 13 | 18 | 23 => byte == b'-',
                _ => byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase(),
            });
        if !valid {
            return Err(diagnostic("uid", "must be a lowercase UUID"));
        }
        Ok(Self { uid: uid.into() })
    }

    pub(crate) fn project(
        &self,
        capabilities: &Capabilities,
        answers: &Answers,
    ) -> Result<AuthoredDocument, Diagnostics> {
        let mut items = Vec::new();
        for (field, value) in [
            ("deployment-name", answers.deployment_name.as_str()),
            ("sandbox-name", answers.sandbox_name.as_str()),
            ("agent-name", answers.agent_name.as_str()),
            ("provider-name", answers.provider_name.as_str()),
        ] {
            if !valid_slug(value) {
                items.push(Diagnostic {
                    field,
                    message: "must be a lowercase name of at most 40 characters".into(),
                });
            }
        }
        if !valid_environment_name(&answers.credential_env) {
            items.push(Diagnostic {
                field: "credential-env",
                message: "must be an uppercase environment variable name".into(),
            });
        }
        let scenario = capabilities.scenario(
            answers.harness,
            answers.runtime,
            answers.inference,
            answers.api,
        );
        match scenario {
            Some(scenario) if !scenario.models.contains(&answers.model.as_str()) => {
                items.push(Diagnostic {
                    field: "model",
                    message: "is not available for the selected harness, runtime, inference provider, and API"
                        .into(),
                });
            }
            None => items.push(Diagnostic {
                field: capabilities.unavailable_field(answers),
                message:
                    "the selected harness, runtime, inference provider, and API are not available"
                        .into(),
            }),
            Some(_) => {}
        }
        if !items.is_empty() {
            return Err(Diagnostics { items });
        }
        let scenario = scenario.expect("validated scenario capability");
        let read_only = [
            "/usr",
            "/opt/fabric",
            "/opt/nemoclaw",
            scenario.filesystem_read_only,
        ];

        let source = json!({
            "apiVersion": nemoclaw_sdk::config::API_VERSION,
            "kind": "NemoClawConfig",
            "metadata": {"name": answers.deployment_name, "uid": self.uid},
            "spec": {
                "gateway": {"management": "managed"},
                "inferenceProviders": [{
                    "name": answers.provider_name,
                    "provider": scenario.provider_kind,
                    "api": scenario.provider_api,
                    "endpoint": scenario.endpoint,
                    "credential": {"env": answers.credential_env}
                }],
                "sandboxes": [{
                    "name": answers.sandbox_name,
                    "harness": {"kind": scenario.harness_kind},
                    "runtime": {"provider": "docker"},
                    "network": {"policy": {"explicit": {
                        "version": 1,
                        "process": {"run_as_user": "1000", "run_as_group": "1000"},
                        "network_policies": {"hosted-inference": {
                            "name": "hosted-inference",
                            "endpoints": [{"host": "integrate.api.nvidia.com", "port": 443}],
                            "binaries": [{"path": scenario.network_binary}]
                        }},
                        "filesystem_policy": {
                            "include_workdir": true,
                            "read_only": read_only,
                            "read_write": ["/sandbox"]
                        }
                    }}},
                    "agent": {
                        "name": answers.agent_name,
                        "inference": {"routes": [{
                            "name": "primary",
                            "providerRef": answers.provider_name,
                            "overrides": {"model": answers.model}
                        }]}
                    }
                }]
            }
        });
        let yaml = serde_saphyr::to_string(&source)
            .map_err(|_| diagnostic("document", "could not serialize configuration"))?;
        let document = Document::parse(yaml.as_bytes())
            .map_err(|error| diagnostic("document", &error.to_string()))?;
        Ok(AuthoredDocument {
            yaml,
            document,
            completion_boundary: CompletionBoundary::GeneratedDesiredState,
        })
    }
}

fn diagnostic(field: &'static str, message: &str) -> Diagnostics {
    Diagnostics {
        items: vec![Diagnostic {
            field,
            message: message.into(),
        }],
    }
}

fn valid_slug(value: &str) -> bool {
    (1..=40).contains(&value.len())
        && value.as_bytes()[0].is_ascii_lowercase()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}

fn valid_environment_name(value: &str) -> bool {
    (1..=128).contains(&value.len())
        && (value.as_bytes()[0].is_ascii_uppercase() || value.as_bytes()[0] == b'_')
        && value
            .bytes()
            .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_')
}

#[cfg(test)]
mod tests {
    use super::*;

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
        assert_eq!(document.spec.gateway.management, "managed");
        assert_eq!(
            document.spec.gateway.image,
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
        let route = &document.agent_inference(&sandbox.agent).unwrap().routes[0];
        assert_eq!(route.provider_ref.as_deref(), Some("hosted-nvidia-prod"));
        assert_eq!(route.overrides.model, "nvidia/nemotron-3-super-120b-a12b");
    }

    #[test]
    fn representable_scenarios_share_one_parser_validated_table() {
        struct Scenario {
            name: &'static str,
            variation: &'static str,
            direct_inputs: DirectInputs,
            interactive_inputs: InteractiveInputs,
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
                direct_inputs: DirectInputs::default(),
                interactive_inputs: InteractiveInputs {
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
                direct_inputs: DirectInputs {
                    deployment_name: Some("openclaw-responses".into()),
                    api: Some(ApiChoice::OpenAiResponses),
                    provider_name: Some("responses-nvidia".into()),
                    credential_env: Some("NVIDIA_RESPONSES_API_KEY".into()),
                    ..DirectInputs::default()
                },
                interactive_inputs: InteractiveInputs {
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
                authored_source_assertions: &[(
                    "/spec/inferenceProviders/0/api",
                    "openai-responses",
                )],
            },
            Scenario {
                name: "hosted Hermes completions",
                variation: "Hermes harness policy and filesystem requirements",
                direct_inputs: DirectInputs {
                    deployment_name: Some("hermes-nvidia-hosted".into()),
                    sandbox_name: Some("hermes-assistant".into()),
                    agent_name: Some("hermes".into()),
                    harness: Some(HarnessChoice::Hermes),
                    provider_name: Some("hermes-nvidia".into()),
                    credential_env: Some("HERMES_INFERENCE_API_KEY".into()),
                    ..DirectInputs::default()
                },
                interactive_inputs: InteractiveInputs {
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
                Answers::from_direct(Answers::first_slice(), scenario.direct_inputs.clone());
            let interactive_answers =
                Answers::from_interactive(scenario.interactive_inputs.clone());
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
            assert!(
                review
                    .render()
                    .contains(&format!("Harness: {}", scenario.expected_harness)),
                "{}",
                scenario.name
            );
            let expected_api_name = match scenario.expected_api {
                InferenceApi::OpenaiCompletions => "openai-completions",
                InferenceApi::OpenaiResponses => "openai-responses",
                InferenceApi::AnthropicMessages => "anthropic-messages",
            };
            assert!(
                review
                    .render()
                    .contains(&format!("API: {expected_api_name}")),
                "{}",
                scenario.name
            );
            assert_eq!(reparsed.metadata.name, direct_answers.deployment_name);
            assert_eq!(reparsed.metadata.uid, UID);
            assert_eq!(reparsed.spec.gateway.management, "managed");
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
            let route = &reparsed.agent_inference(agent).unwrap().routes[0];
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
        assert!(!initial.render().contains("nvapi-"));

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
}
