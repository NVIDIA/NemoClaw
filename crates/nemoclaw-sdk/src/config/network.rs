// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
// Input contract adapted from NVIDIA/NemoClaw at be46805b51b0d626466538e9f8fe56c8ad157549:
// schemas/network-policy.schema.json and src/lib/config/model.ts (Apache-2.0).
// 2026-09-15: represented the export fields as strict Rust types, added explicit
// preset selection, and delegated policy semantics to pinned openshell-policy.
// 2026-09-19: removed the main-branch Landlock spelling translation and the
// redundant external-proxy ownership annotation.
// 2026-09-21: made policy selection exclusive in Rust while preserving the input shape.
// 2026-09-28: use owner policy types independently of the transport client.
use super::ConfigError;
pub use nemoclaw_openshell::policy::{
    ExplicitPolicy, PolicyAllowRule, PolicyAnyMatcher, PolicyBinary, PolicyEndpoint,
    PolicyFilesystem, PolicyJsonRpc, PolicyLandlock, PolicyMatcher, PolicyMcp, PolicyProcess,
    PolicyRule, PolicyValueMatcher,
};
use openshell_core::proto;
use serde::{Deserialize, Serialize};

/// Sandbox policy selection.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(try_from = "NetworkInput", into = "NetworkInput")]
#[schemars(with = "NetworkInput")]
pub struct Network {
    /// Isolated preset or a complete authored policy; the two cannot coexist.
    pub policy: NetworkPolicy,
}

/// Sandbox policy source. Explicit policies replace the isolated preset completely.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub enum NetworkPolicy {
    /// SDK-provided isolated policy.
    #[default]
    Isolated,
    /// Complete authored OpenShell policy; no isolated defaults are merged.
    Explicit(ExplicitPolicy),
}

// Keep the authored YAML shape at the serialization boundary. Runtime code
// receives one policy choice, never independently mutable tier and policy fields.
#[derive(Default, Serialize, Deserialize, schemars::JsonSchema)]
#[schemars(!default, rename = "Network")]
#[serde(default, deny_unknown_fields)]
/// Sandbox policy selection.
struct NetworkInput {
    #[serde(rename = "tier")]
    #[schemars(default)]
    /// Isolated policy preset. Omit when declaring policy.explicit; omission without policy selects isolated.
    #[serde(skip_serializing_if = "String::is_empty")]
    tier: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(default, with = "ExplicitPolicySelection")]
    /// Complete authored OpenShell policy, replacing the isolated preset.
    policy: Option<ExplicitPolicySelection>,
}

impl TryFrom<NetworkInput> for Network {
    type Error = ConfigError;

    fn try_from(input: NetworkInput) -> Result<Self, Self::Error> {
        let policy = match (input.tier.as_str(), input.policy) {
            ("", Some(policy)) => NetworkPolicy::Explicit(policy.explicit),
            ("" | super::constraints::NETWORK_TIER, None) => NetworkPolicy::Isolated,
            _ => {
                return Err(ConfigError::new(
                    "choose either isolated tier or an explicit policy",
                ));
            }
        };
        Ok(Self { policy })
    }
}

impl From<Network> for NetworkInput {
    fn from(network: Network) -> Self {
        let (tier, policy) = match network.policy {
            NetworkPolicy::Isolated => (super::constraints::NETWORK_TIER.into(), None),
            NetworkPolicy::Explicit(explicit) => {
                (String::new(), Some(ExplicitPolicySelection { explicit }))
            }
        };
        Self { tier, policy }
    }
}

/// Select an explicit policy; no isolated defaults are merged into it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct ExplicitPolicySelection {
    /// Complete sandbox policy in OpenShell YAML field names.
    explicit: ExplicitPolicy,
}

impl Network {
    pub fn validate(&self) -> Result<(), ConfigError> {
        super::schema::validate_definition("Network", self)?;
        if let NetworkPolicy::Explicit(policy) = &self.policy {
            policy.to_proto()?;
        }
        Ok(())
    }
    pub fn policy_proto(&self) -> Result<proto::SandboxPolicy, ConfigError> {
        match &self.policy {
            NetworkPolicy::Isolated => Err(ConfigError::new(
                "isolated policy requires the selected image runtime metadata",
            )),
            NetworkPolicy::Explicit(policy) => policy.to_proto(),
        }
    }
}
