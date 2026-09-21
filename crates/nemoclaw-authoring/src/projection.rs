// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use crate::diagnostics::diagnostic;
use crate::{Answers, AuthoredDocument, Capabilities, CompletionBoundary, Diagnostic, Diagnostics};
use nemoclaw_sdk::config::Document;
use serde_json::json;

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
