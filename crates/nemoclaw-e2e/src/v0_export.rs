// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
// Input contract adapted from NVIDIA/NemoClaw at
// f47724f29838fe08898993fad1c8c6b7fcb3e080: src/lib/domain/config/export-document.ts
// (Apache-2.0).
// 2026-09-15: translated the strict exported subset into v1alpha1 desired state
// and made v1-only runtime bindings explicit inputs.
// 2026-09-16: updated the target schema and made process-principal translation explicit.

//! Strict desired-state translation for manually curated v0 configuration exports.

use nemoclaw_sdk::config::{
    API_VERSION, Agent, AgentAuth, Credential, Document, Gateway, Harness, Image, Inference,
    InferenceApi, InferenceProvider, Metadata, Network, Runtime, Sandbox, Spec,
};
use serde::{Deserialize, Serialize};
use std::{fmt, io::Read};

const V0_EXPORT_API_VERSION: &str = "nemoclaw.nvidia.com/v1";
const V0_EXPORT_GATEWAY_MANAGEMENT: &str = "nemoclaw";
const MAX_EXPORT_BYTES: u64 = 1 << 20;

/// Runtime identities absent from a v0 export and required for a new v1 deployment.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct V1RuntimeBindings {
    pub gateway_engine: String,
    pub gateway_image: String,
    pub gateway_network_cidr: String,
    pub sandbox_image: String,
    pub process_principal: V1ProcessPrincipalBinding,
}

/// Explicit process-principal translation between the source and target images.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct V1ProcessPrincipalBinding {
    pub source_user: String,
    pub source_group: String,
    pub target_user: String,
    pub target_group: String,
}

/// A fixed diagnostic that never contains source configuration values.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct V0ExportError(&'static str);

impl fmt::Display for V0ExportError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.0)
    }
}

impl std::error::Error for V0ExportError {}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct V0Export {
    api_version: String,
    kind: String,
    metadata: Metadata,
    spec: V0Spec,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct V0Spec {
    gateway: V0Gateway,
    inference_providers: Vec<V0InferenceProvider>,
    sandboxes: Vec<V0Sandbox>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct V0Gateway {
    management: String,
    name: String,
    port: u16,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct V0InferenceProvider {
    name: String,
    provider: String,
    api: Option<InferenceApi>,
    endpoint: String,
    credential: Option<Credential>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct V0Sandbox {
    name: String,
    runtime: V0Runtime,
    network: Network,
    agents: Vec<V0Agent>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct V0Runtime {
    provider: String,
    image: Image,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct V0Agent {
    name: String,
    #[serde(rename = "type")]
    harness: String,
    inference: Inference,
    auth: Option<AgentAuth>,
}

fn parse(input: impl Read) -> Result<V0Export, V0ExportError> {
    let mut bytes = Vec::new();
    input
        .take(MAX_EXPORT_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| V0ExportError("cannot read v0 export"))?;
    if bytes.len() as u64 > MAX_EXPORT_BYTES {
        return Err(V0ExportError("v0 export exceeds 1 MiB"));
    }
    let text = std::str::from_utf8(&bytes).map_err(|_| V0ExportError("v0 export must be UTF-8"))?;
    let mut options = serde_saphyr::Options::default();
    let mut budget = serde_saphyr::Budget::default();
    budget.max_aliases = 0;
    budget.max_anchors = 0;
    budget.max_merge_keys = 0;
    options.budget = Some(budget);
    options.merge_keys = serde_saphyr::MergeKeyPolicy::Error;
    options.reject_unsupported_tags = true;
    serde_saphyr::from_str_with_options(text, options)
        .map_err(|_| V0ExportError("invalid or unsupported v0 export"))
}

/// Translate portable v0 export intent into a new v1 desired state.
///
/// This creates a new deployment. It does not adopt or migrate v0 runtime state.
/// Fields not represented by the strict input types are rejected instead of discarded.
pub fn desired_state_from_v0_export(
    input: impl Read,
    bindings: V1RuntimeBindings,
) -> Result<Document, V0ExportError> {
    let export = parse(input)?;
    if export.api_version != V0_EXPORT_API_VERSION
        || export.kind != "NemoClawConfig"
        || export.spec.gateway.management != V0_EXPORT_GATEWAY_MANAGEMENT
        || export.spec.gateway.name != "nemoclaw"
        || export.spec.inference_providers.len() != 1
        || export.spec.sandboxes.len() != 1
    {
        return Err(V0ExportError("unsupported v0 export contract"));
    }

    let mut providers = export.spec.inference_providers;
    let provider = providers.pop().unwrap();
    let mut sandboxes = export.spec.sandboxes;
    let mut sandbox = sandboxes.pop().unwrap();
    if sandbox.agents.len() != 1
        || sandbox.runtime.image.ref_.is_empty()
        || provider.provider.is_empty()
    {
        return Err(V0ExportError("unsupported v0 sandbox export"));
    }
    let mut agents = sandbox.agents;
    let agent = agents.pop().unwrap();
    let api = provider
        .api
        .ok_or(V0ExportError("unsupported v0 inference export"))?;
    let provider_driver = match (provider.provider.as_str(), api) {
        ("nvidia-prod", InferenceApi::OpenaiCompletions | InferenceApi::OpenaiResponses) => {
            "openai"
        }
        _ => return Err(V0ExportError("unsupported v0 inference export")),
    };
    let process = sandbox
        .network
        .policy
        .as_mut()
        .and_then(|selection| selection.explicit.process.as_mut())
        .ok_or(V0ExportError(
            "v0 process principal does not match the explicit binding",
        ))?;
    if process.run_as_user.as_deref() != Some(&bindings.process_principal.source_user)
        || process.run_as_group.as_deref() != Some(&bindings.process_principal.source_group)
    {
        return Err(V0ExportError(
            "v0 process principal does not match the explicit binding",
        ));
    }
    if bindings.process_principal.target_user.is_empty()
        || bindings.process_principal.target_group.is_empty()
    {
        return Err(V0ExportError("invalid v1 process principal binding"));
    }
    process.run_as_user = Some(bindings.process_principal.target_user.clone());
    process.run_as_group = Some(bindings.process_principal.target_group.clone());

    let document = Document {
        api_version: API_VERSION.into(),
        kind: export.kind,
        metadata: export.metadata,
        spec: Spec {
            gateway: Gateway {
                management: "managed".into(),
                endpoint: format!("http://127.0.0.1:{}", export.spec.gateway.port),
                engine: bindings.gateway_engine,
                image: bindings.gateway_image,
                network_cidr: bindings.gateway_network_cidr,
                ..Gateway::default()
            },
            inference_providers: vec![InferenceProvider {
                name: provider.name,
                provider: provider_driver.into(),
                api: Some(api),
                endpoint: provider.endpoint,
                credential: provider.credential,
                ..InferenceProvider::default()
            }],
            sandboxes: vec![Sandbox {
                name: sandbox.name,
                harness: Some(Harness {
                    kind: agent.harness,
                    ..Harness::default()
                }),
                image: Image {
                    ref_: bindings.sandbox_image,
                },
                runtime: Runtime {
                    provider: sandbox.runtime.provider,
                },
                network: sandbox.network,
                agents: vec![Agent {
                    name: agent.name,
                    inference: Some(agent.inference),
                    auth: agent.auth,
                    ..Agent::default()
                }],
                ..Sandbox::default()
            }],
            ..Spec::default()
        },
    };
    let yaml = document
        .yaml()
        .map_err(|_| V0ExportError("translated v0 export is not valid v1 desired state"))?;
    Document::parse(yaml.as_bytes())
        .map_err(|_| V0ExportError("translated v0 export is not valid v1 desired state"))
}
