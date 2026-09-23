// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use crate::diagnostics::diagnostic;
use crate::{Answers, AuthoredDocument, Capabilities, CompletionBoundary, Diagnostic, Diagnostics};
use nemoclaw_sdk::config::{
    API_VERSION, Agent, ComputeDriver, Credential, Document, Gateway, Harness, Inference,
    InferenceProvider, ManagedGateway, Metadata, Network, Overrides, Route, Runtime, Sandbox, Spec,
};

/// Holds one deployment identity across projections and draft edits.
#[derive(Clone, Debug)]
pub struct Session {
    uid: String,
}

impl Session {
    /// Generates a random UUID without creating deployment state.
    pub fn new() -> Result<Self, Diagnostics> {
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

    /// Uses an existing lowercase UUID, including when reopening generated YAML.
    pub fn with_uid(uid: &str) -> Result<Self, Diagnostics> {
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

    /// Builds YAML and validates it with the SDK parser without deploying resources.
    pub fn project(
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
            Some(scenario)
                if scenario.default_model != Some(answers.model.as_str())
                    && !(scenario.custom_model && valid_model(&answers.model)) =>
            {
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
        let gateway = if answers.runtime == ComputeDriver::Podman {
            Gateway::Managed(ManagedGateway {
                endpoint: "http://127.0.0.1:17681".into(),
                engine: "unix:///run/user/1000/podman/podman.sock".into(),
                ..ManagedGateway::default()
            })
        } else {
            Gateway::Managed(ManagedGateway::default())
        };
        let source = Document {
            api_version: API_VERSION.into(),
            kind: "NemoClawConfig".into(),
            metadata: Metadata {
                name: answers.deployment_name.clone(),
                uid: self.uid.clone(),
            },
            spec: Spec {
                gateway,
                inference_providers: vec![InferenceProvider {
                    name: answers.provider_name.clone(),
                    provider: scenario.provider_kind,
                    api: scenario.provider_api,
                    endpoint: if scenario.custom_endpoint {
                        answers.endpoint.clone()
                    } else {
                        scenario.endpoint.into()
                    },
                    credential: Some(Credential {
                        env: answers.credential_env.clone(),
                    }),
                    service_ref: None,
                }],
                sandboxes: vec![Sandbox {
                    harness: Some(Harness {
                        kind: scenario.harness,
                        observability: None,
                        execution: None,
                        interfaces: None,
                    }),
                    name: answers.sandbox_name.clone(),
                    runtime: Runtime {
                        provider: answers.runtime,
                    },
                    network: Network::default(),
                    agent: Agent {
                        name: answers.agent_name.clone(),
                        inference: Some(Inference {
                            default: None,
                            routes: vec![Route {
                                name: "primary".into(),
                                provider_ref: Some(answers.provider_name.clone()),
                                provider: None,
                                overrides: Overrides {
                                    model: answers.model.clone(),
                                    ..Overrides::default()
                                },
                            }],
                        }),
                        ..Agent::default()
                    },
                    ..Sandbox::default()
                }],
                ..Spec::default()
            },
        };
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

fn valid_slug(value: &str) -> bool {
    (1..=40).contains(&value.len())
        && value.as_bytes()[0].is_ascii_lowercase()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}

fn valid_model(value: &str) -> bool {
    (1..=256).contains(&value.len())
        && value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'/' | b'-')
        })
}

fn valid_environment_name(value: &str) -> bool {
    (1..=128).contains(&value.len())
        && (value.as_bytes()[0].is_ascii_uppercase() || value.as_bytes()[0] == b'_')
        && value
            .bytes()
            .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_')
}
