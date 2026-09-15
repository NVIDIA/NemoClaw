// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[schemars(!default)]
#[serde(default, deny_unknown_fields)]
pub struct Document {
    #[serde(rename = "apiVersion")]
    pub api_version: String,
    #[serde(rename = "kind")]
    pub kind: String,
    #[serde(rename = "metadata")]
    pub metadata: Metadata,
    #[serde(rename = "spec")]
    pub spec: Spec,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[schemars(!default)]
#[serde(default, deny_unknown_fields)]
pub struct Metadata {
    #[serde(rename = "name")]
    pub name: String,
    #[serde(rename = "uid")]
    pub uid: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[schemars(!default)]
#[serde(default, deny_unknown_fields)]
pub struct Spec {
    #[serde(rename = "gateway")]
    pub gateway: Gateway,
    #[serde(rename = "inferenceProviders")]
    pub inference_providers: Vec<InferenceProvider>,
    #[serde(rename = "sandboxes")]
    pub sandboxes: Vec<Sandbox>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[schemars(!default)]
#[serde(default, deny_unknown_fields)]
pub struct Credential {
    #[serde(rename = "env")]
    pub env: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[schemars(!default)]
#[serde(default, deny_unknown_fields)]
pub struct TLS {
    #[serde(rename = "ca")]
    pub ca: Credential,
    #[serde(rename = "certificate")]
    pub certificate: Credential,
    #[serde(rename = "key")]
    pub key: Credential,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[schemars(!default)]
#[serde(default, deny_unknown_fields)]
pub struct Gateway {
    #[serde(rename = "management")]
    pub management: String,
    #[serde(rename = "endpoint")]
    #[schemars(default)]
    pub endpoint: String,
    #[serde(rename = "credential", skip_serializing_if = "Option::is_none")]
    #[schemars(default, with = "Credential")]
    pub credential: Option<Credential>,
    #[serde(rename = "tls", skip_serializing_if = "Option::is_none")]
    #[schemars(default, with = "TLS")]
    pub tls: Option<TLS>,
    #[serde(rename = "engine", skip_serializing_if = "String::is_empty")]
    #[schemars(default)]
    pub engine: String,
    #[serde(rename = "image", skip_serializing_if = "String::is_empty")]
    #[schemars(default)]
    pub image: String,
    #[serde(rename = "networkCIDR", skip_serializing_if = "String::is_empty")]
    #[schemars(default)]
    pub network_cidr: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[schemars(!default)]
#[serde(default, deny_unknown_fields)]
pub struct InferenceProvider {
    #[serde(rename = "name")]
    pub name: String,
    #[serde(rename = "provider")]
    pub provider: String,
    #[serde(rename = "endpoint", skip_serializing_if = "String::is_empty")]
    #[schemars(default)]
    pub endpoint: String,
    #[serde(rename = "credential", skip_serializing_if = "Option::is_none")]
    #[schemars(default, with = "Credential")]
    pub credential: Option<Credential>,
    #[serde(rename = "ollama", skip_serializing_if = "Option::is_none")]
    #[schemars(default, with = "ManagedOllama")]
    pub ollama: Option<ManagedOllama>,
    #[serde(rename = "service", skip_serializing_if = "Option::is_none")]
    #[schemars(default, with = "Service")]
    pub service: Option<Service>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[schemars(!default)]
#[serde(default, deny_unknown_fields)]
pub struct ManagedOllama {
    #[serde(rename = "engine")]
    pub engine: String,
    #[serde(rename = "image")]
    pub image: String,
    #[serde(rename = "network")]
    pub network: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[schemars(!default)]
#[serde(default, deny_unknown_fields)]
pub struct Sandbox {
    #[serde(rename = "name")]
    pub name: String,
    #[serde(rename = "image")]
    #[schemars(default)]
    pub image: Image,
    #[serde(rename = "runtime")]
    #[schemars(default)]
    pub runtime: Runtime,
    #[serde(rename = "network")]
    #[schemars(default)]
    pub network: Network,
    #[serde(rename = "agents")]
    pub agents: Vec<Agent>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[schemars(!default)]
#[serde(default, deny_unknown_fields)]
pub struct Image {
    #[serde(rename = "ref")]
    #[schemars(default)]
    pub ref_: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[schemars(!default)]
#[serde(default, deny_unknown_fields)]
pub struct Runtime {
    #[serde(rename = "provider")]
    #[schemars(default)]
    pub provider: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[schemars(!default)]
#[serde(default, deny_unknown_fields)]
pub struct Network {
    #[serde(rename = "tier")]
    #[schemars(default)]
    pub tier: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[schemars(!default)]
#[serde(default, deny_unknown_fields)]
pub struct Agent {
    #[serde(rename = "name")]
    pub name: String,
    #[serde(rename = "harness")]
    pub harness: String,
    #[serde(rename = "inference")]
    pub inference: Inference,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[schemars(!default)]
#[serde(default, deny_unknown_fields)]
pub struct Inference {
    #[serde(rename = "routes")]
    pub routes: Vec<Route>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[schemars(!default)]
#[serde(default, deny_unknown_fields)]
pub struct Route {
    #[serde(rename = "name")]
    pub name: String,
    #[serde(rename = "providerRef")]
    pub provider_ref: String,
    #[serde(rename = "overrides")]
    pub overrides: Overrides,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[schemars(!default)]
#[serde(default, deny_unknown_fields)]
pub struct Overrides {
    #[serde(rename = "model")]
    pub model: String,
    #[serde(rename = "piModel", skip_serializing_if = "Option::is_none")]
    #[schemars(default, with = "serde_json::Map<String, serde_json::Value>")]
    pub pi_model: Option<serde_json::Map<String, serde_json::Value>>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[schemars(!default)]
#[serde(default, deny_unknown_fields)]
pub struct Service {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(default, with = "Box<crate::recipes::inline::InlineRecipe>")]
    pub recipe: Option<Box<crate::recipes::inline::InlineRecipe>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(default, with = "ServicePlacement")]
    pub placement: Option<ServicePlacement>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(default, with = "ServicePublication")]
    pub publication: Option<ServicePublication>,
    #[serde(rename = "backend")]
    pub backend: String,
    #[serde(rename = "image")]
    pub image: String,
    #[serde(rename = "model")]
    pub model: Model,
    #[serde(rename = "serving")]
    #[schemars(default)]
    pub serving: Serving,
    #[serde(rename = "memory")]
    #[schemars(default)]
    pub memory: Memory,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[schemars(!default)]
#[serde(default, deny_unknown_fields)]
pub struct Model {
    #[serde(rename = "repository")]
    pub repository: String,
    #[serde(rename = "revision")]
    pub revision: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[schemars(!default)]
#[serde(default, deny_unknown_fields)]
pub struct Serving {
    #[serde(rename = "toolParser", skip_serializing_if = "String::is_empty")]
    #[schemars(default)]
    pub tool_parser: String,
    #[serde(rename = "reasoningParser", skip_serializing_if = "String::is_empty")]
    #[schemars(default)]
    pub reasoning_parser: String,
    #[serde(rename = "port")]
    #[schemars(default)]
    pub port: i64,
    #[serde(rename = "contextTokens")]
    #[schemars(default)]
    pub context_tokens: i64,
    #[serde(rename = "maxSequences")]
    #[schemars(default)]
    pub max_sequences: i64,
    #[serde(rename = "batchTokens")]
    #[schemars(default)]
    pub batch_tokens: i64,
    #[serde(rename = "speculativeTokens")]
    #[schemars(default)]
    pub speculative_tokens: i64,
    #[serde(rename = "startupTimeoutSeconds")]
    #[schemars(default)]
    pub startup_timeout_seconds: i64,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[schemars(!default)]
#[serde(default, deny_unknown_fields)]
pub struct Memory {
    #[serde(rename = "gpuMemoryGiB", skip_serializing_if = "is_zero")]
    #[schemars(default)]
    pub gpu_memory_gib: i64,
    #[serde(rename = "hostReserveGiB")]
    #[schemars(default)]
    pub host_reserve_gib: i64,
    #[serde(rename = "kvCacheGiB")]
    #[schemars(default)]
    pub kv_cache_gib: i64,
    #[serde(rename = "minAvailableGiB")]
    #[schemars(default)]
    pub min_available_gib: i64,
    #[serde(rename = "minFreeGiB")]
    #[schemars(default)]
    pub min_free_gib: i64,
    #[serde(rename = "freeGateGiB")]
    #[schemars(default)]
    pub free_gate_gib: i64,
    #[serde(rename = "consecutiveSamples")]
    #[schemars(default)]
    pub consecutive_samples: i64,
}

fn is_zero(value: &i64) -> bool {
    *value == 0
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ServicePlacement {
    pub engine: String,
    pub network_cidr: String,
}
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ServicePublication {
    pub endpoint: String,
    pub bind_address: String,
}
