// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use nemoclaw_sdk::config::Document;
use serde_json::json;
use std::fmt;

const NVIDIA_MODEL: &str = "nvidia/nemotron-3-super-120b-a12b";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum HarnessChoice {
    OpenClaw,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum RuntimeChoice {
    Docker,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum InferenceChoice {
    NvidiaHosted,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Answers {
    pub(crate) deployment_name: String,
    pub(crate) sandbox_name: String,
    pub(crate) agent_name: String,
    pub(crate) harness: HarnessChoice,
    pub(crate) runtime: RuntimeChoice,
    pub(crate) inference: InferenceChoice,
    pub(crate) provider_name: String,
    pub(crate) model: String,
    pub(crate) credential_env: String,
}

#[derive(Clone, Debug)]
struct ScenarioCapability {
    harness: HarnessChoice,
    runtime: RuntimeChoice,
    inference: InferenceChoice,
    models: &'static [&'static str],
}

#[derive(Clone, Debug)]
pub(crate) struct Capabilities {
    scenarios: Vec<ScenarioCapability>,
}

impl Capabilities {
    pub(crate) fn first_slice() -> Self {
        Self {
            scenarios: vec![ScenarioCapability {
                harness: HarnessChoice::OpenClaw,
                runtime: RuntimeChoice::Docker,
                inference: InferenceChoice::NvidiaHosted,
                models: &[NVIDIA_MODEL],
            }],
        }
    }

    pub(crate) fn models(
        &self,
        harness: HarnessChoice,
        runtime: RuntimeChoice,
        inference: InferenceChoice,
    ) -> &[&'static str] {
        self.scenarios
            .iter()
            .find(|scenario| {
                scenario.harness == harness
                    && scenario.runtime == runtime
                    && scenario.inference == inference
            })
            .map_or(&[], |scenario| scenario.models)
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
}

impl AuthoredDocument {
    pub(crate) fn yaml(&self) -> &str {
        &self.yaml
    }

    pub(crate) fn document(&self) -> &Document {
        &self.document
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
            provider_name: "hosted-nvidia-prod".into(),
            model: NVIDIA_MODEL.into(),
            credential_env: "NVIDIA_INFERENCE_API_KEY".into(),
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
        let [agent] = sandbox.agents.as_slice() else {
            return Err(diagnostic(
                "document",
                "editing requires one generated onboarding agent",
            ));
        };
        if !matches!(
            document.sandbox_harness(sandbox),
            Ok(harness) if harness.kind == "openclaw"
        ) || sandbox.runtime.provider != "docker"
        {
            return Err(diagnostic(
                "document",
                "editing requires the supported OpenClaw Docker scenario",
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
        let answers = Answers {
            deployment_name: document.metadata.name.clone(),
            sandbox_name: sandbox.name.clone(),
            agent_name: agent.name.clone(),
            harness: HarnessChoice::OpenClaw,
            runtime: RuntimeChoice::Docker,
            inference: InferenceChoice::NvidiaHosted,
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
        &self.authored.document.spec.sandboxes[0].agents[0].name
    }

    pub(crate) fn provider_name(&self) -> &str {
        &self.authored.document.spec.inference_providers[0].name
    }

    pub(crate) fn model(&self) -> &str {
        &self.authored.document.spec.sandboxes[0].agents[0]
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
        let route = &self.authored.document.spec.sandboxes[0].agents[0]
            .inference
            .as_ref()
            .expect("generated review has inline inference")
            .routes[0];
        format!(
            "Deployment: {}\nUID: {}\nSandbox: {}\nAgent: {}\nProvider: {}\nModel: {}\nCredential references: {}\n",
            self.deployment_name(),
            self.uid(),
            self.sandbox_name(),
            self.agent_name(),
            self.provider_name(),
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
        let models = capabilities.models(answers.harness, answers.runtime, answers.inference);
        if !models.contains(&answers.model.as_str()) {
            items.push(Diagnostic {
                field: "model",
                message:
                    "is not available for the selected harness, runtime, and inference provider"
                        .into(),
            });
        }
        if !items.is_empty() {
            return Err(Diagnostics { items });
        }

        let source = json!({
            "apiVersion": nemoclaw_sdk::config::API_VERSION,
            "kind": "NemoClawConfig",
            "metadata": {"name": answers.deployment_name, "uid": self.uid},
            "spec": {
                "gateway": {"management": "managed"},
                "inferenceProviders": [{
                    "name": answers.provider_name,
                    "provider": "openai",
                    "api": "openai-completions",
                    "endpoint": "https://integrate.api.nvidia.com/v1",
                    "credential": {"env": answers.credential_env}
                }],
                "sandboxes": [{
                    "name": answers.sandbox_name,
                    "harness": {"kind": "openclaw"},
                    "runtime": {"provider": "docker"},
                    "network": {"policy": {"explicit": {
                        "version": 1,
                        "process": {"run_as_user": "1000", "run_as_group": "1000"},
                        "network_policies": {"hosted-inference": {
                            "name": "hosted-inference",
                            "endpoints": [{"host": "integrate.api.nvidia.com", "port": 443}],
                            "binaries": [{"path": "/usr/bin/openclaw"}]
                        }},
                        "filesystem_policy": {
                            "include_workdir": true,
                            "read_only": ["/usr", "/opt/fabric", "/opt/nemoclaw", "/app"],
                            "read_write": ["/sandbox"]
                        }
                    }}},
                    "agents": [{
                        "name": answers.agent_name,
                        "inference": {"routes": [{
                            "name": "primary",
                            "providerRef": answers.provider_name,
                            "overrides": {"model": answers.model}
                        }]}
                    }]
                }]
            }
        });
        let yaml = serde_saphyr::to_string(&source)
            .map_err(|_| diagnostic("document", "could not serialize configuration"))?;
        let document = Document::parse(yaml.as_bytes())
            .map_err(|error| diagnostic("document", &error.to_string()))?;
        Ok(AuthoredDocument { yaml, document })
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
            provider_name: "hosted-nvidia-prod".into(),
            model: "nvidia/nemotron-3-super-120b-a12b".into(),
            credential_env: "NVIDIA_INFERENCE_API_KEY".into(),
        }
    }

    #[test]
    fn fixed_hosted_openclaw_answers_project_to_parser_accepted_intent() {
        let capabilities = Capabilities::first_slice();
        assert_eq!(
            capabilities.models(
                HarnessChoice::OpenClaw,
                RuntimeChoice::Docker,
                InferenceChoice::NvidiaHosted,
            ),
            ["nvidia/nemotron-3-super-120b-a12b"]
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
        let route = &document.agent_inference(&sandbox.agents[0]).unwrap().routes[0];
        assert_eq!(route.provider_ref.as_deref(), Some("hosted-nvidia-prod"));
        assert_eq!(route.overrides.model, "nvidia/nemotron-3-super-120b-a12b");
    }

    #[test]
    fn unsupported_answers_return_field_diagnostics_without_approximation() {
        let mut unsupported = answers();
        unsupported.model = "unoffered/model".into();
        let diagnostics = Session::with_uid(UID)
            .unwrap()
            .project(&Capabilities::first_slice(), &unsupported)
            .unwrap_err();
        assert_eq!(diagnostics.items()[0].field(), "model");
        assert!(diagnostics.items()[0].message().contains("not available"));
    }

    #[test]
    fn semantic_edits_preserve_uid_and_unaffected_answers() {
        let capabilities = Capabilities::first_slice();
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
        let capabilities = Capabilities::first_slice();
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
