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
}
