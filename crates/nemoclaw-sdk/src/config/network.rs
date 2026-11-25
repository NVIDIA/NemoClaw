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
// 2026-10-17: added named grants on top of the isolated preset.
// 2026-11-05: added references to deployment-level policies and grants.
use super::ConfigError;
pub use nemoclaw_openshell::policy::{
    ExplicitPolicy, PolicyAllowRule, PolicyAnyMatcher, PolicyBinary, PolicyEndpoint,
    PolicyFilesystem, PolicyJsonRpc, PolicyLandlock, PolicyMatcher, PolicyMcp, PolicyMiddleware,
    PolicyMiddlewareEndpoints, PolicyProcess, PolicyRule, PolicyValueMatcher,
};
use openshell_core::proto;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// Sandbox policy selection.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(try_from = "NetworkInput", into = "NetworkInput")]
#[schemars(with = "NetworkInput")]
pub struct Network {
    /// Isolated preset, a complete authored policy, or a reference to one; only one applies.
    pub policy: NetworkPolicy,
    /// Named grants added to the isolated preset.
    pub grants: BTreeMap<String, Grant>,
    /// Names of deployment-level grants added to the isolated preset.
    pub grant_refs: Vec<String>,
}

/// Endpoint grants added to the isolated preset, restricted to executables.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Grant {
    /// Allowed destinations and optional application-protocol restrictions, in OpenShell's endpoint shape.
    pub endpoints: Vec<PolicyEndpoint>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    /// Executables allowed to use the endpoints. Omitted or empty selects the harness's executables.
    pub binaries: Vec<PolicyBinary>,
}

/// Sandbox policy source. Explicit policies replace the isolated preset completely.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub enum NetworkPolicy {
    /// SDK-provided isolated policy.
    #[default]
    Isolated,
    /// Complete authored OpenShell policy; no isolated defaults are merged.
    Explicit(ExplicitPolicy),
    /// Name of a complete policy in spec.policies; it applies as if written inline.
    Reference(String),
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
    /// Isolated policy preset. Omit when declaring policy or policyRef; omitting all three selects isolated.
    #[serde(skip_serializing_if = "String::is_empty")]
    tier: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(default, with = "ExplicitPolicySelection")]
    /// Complete authored OpenShell policy, replacing the isolated preset. Excludes tier and policyRef.
    policy: Option<ExplicitPolicySelection>,
    #[serde(rename = "policyRef", default, skip_serializing_if = "Option::is_none")]
    #[schemars(default, with = "String")]
    /// Name of a policy in spec.policies, applied as if written in policy.explicit. Excludes tier and policy.
    policy_ref: Option<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    #[schemars(default)]
    /// Named grants added to the isolated preset, each like an OpenShell network policy rule without its name. An explicit policy holds its own grants.
    grants: BTreeMap<String, Grant>,
    #[serde(rename = "grantRefs", default, skip_serializing_if = "Vec::is_empty")]
    #[schemars(default)]
    /// Names of grants in spec.grants added to the isolated preset, alongside grants. Names must be unique across both. Excluded by policy and policyRef.
    grant_refs: Vec<String>,
}

impl TryFrom<NetworkInput> for Network {
    type Error = ConfigError;

    fn try_from(input: NetworkInput) -> Result<Self, Self::Error> {
        let policy = match (input.tier.as_str(), input.policy, input.policy_ref) {
            ("", Some(policy), None) => NetworkPolicy::Explicit(policy.explicit),
            ("", None, Some(name)) => NetworkPolicy::Reference(name),
            ("" | super::constraints::NETWORK_TIER, None, None) => NetworkPolicy::Isolated,
            _ => {
                return Err(ConfigError::new(
                    "choose at most one of the isolated tier, an explicit policy, and policyRef",
                ));
            }
        };
        if (!input.grants.is_empty() || !input.grant_refs.is_empty())
            && !matches!(policy, NetworkPolicy::Isolated)
        {
            return Err(ConfigError::new(
                "network grants add to the isolated preset; list them in the explicit policy instead",
            ));
        }
        Ok(Self {
            policy,
            grants: input.grants,
            grant_refs: input.grant_refs,
        })
    }
}

impl From<Network> for NetworkInput {
    fn from(network: Network) -> Self {
        let (tier, policy, policy_ref) = match network.policy {
            NetworkPolicy::Isolated => (super::constraints::NETWORK_TIER.into(), None, None),
            NetworkPolicy::Explicit(explicit) => (
                String::new(),
                Some(ExplicitPolicySelection { explicit }),
                None,
            ),
            NetworkPolicy::Reference(name) => (String::new(), None, Some(name)),
        };
        Self {
            tier,
            policy,
            policy_ref,
            grants: network.grants,
            grant_refs: network.grant_refs,
        }
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
            NetworkPolicy::Reference(_) => Err(ConfigError::new(
                "a referenced policy resolves through the document",
            )),
        }
    }
}

/// A sandbox network with its references resolved against spec.policies and spec.grants.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ResolvedNetwork<'a> {
    /// The complete policy that replaces the isolated preset, written inline or referenced.
    pub explicit: Option<&'a ExplicitPolicy>,
    /// Grants added to the isolated preset, inline and referenced, keyed by rule name.
    pub grants: BTreeMap<&'a str, &'a Grant>,
}

impl super::Document {
    /// Resolve a sandbox's policy and grant references without changing its authored form.
    pub fn sandbox_network<'a>(
        &'a self,
        sandbox: super::NamedSandbox<'a>,
    ) -> Result<ResolvedNetwork<'a>, ConfigError> {
        use super::references::{diagnostic_name, missing_reference};
        fn select<'a, T>(
            definitions: &'a BTreeMap<String, T>,
            pointer: &str,
            kind: &str,
            name: &str,
        ) -> Result<&'a T, ConfigError> {
            definitions.get(name).ok_or_else(|| {
                missing_reference(kind, name, definitions.keys().map(String::as_str)).or_at(pointer)
            })
        }
        let path = format!("/spec/sandboxes/{}/network", sandbox.name);
        let network = &sandbox.definition.network;
        let explicit = match &network.policy {
            NetworkPolicy::Isolated => None,
            NetworkPolicy::Explicit(policy) => Some(policy),
            NetworkPolicy::Reference(name) => Some(select(
                &self.spec.policies,
                &format!("{path}/policyRef"),
                "policy",
                name,
            )?),
        };
        let mut grants: BTreeMap<&str, &Grant> = network
            .grants
            .iter()
            .map(|(name, grant)| (name.as_str(), grant))
            .collect();
        for (index, name) in network.grant_refs.iter().enumerate() {
            let pointer = format!("{path}/grantRefs/{index}");
            let grant = select(&self.spec.grants, &pointer, "grant", name)?;
            if grants.insert(name, grant).is_some() {
                return Err(ConfigError::at(
                    pointer,
                    format!(
                        "grant {:?} is also defined in grants",
                        diagnostic_name(name)
                    ),
                ));
            }
        }
        Ok(ResolvedNetwork { explicit, grants })
    }

    pub(super) fn validate_network_references(&self) -> Result<(), ConfigError> {
        let mut errors = super::validation::Errors::default();
        // Unused definitions are validated as if a sandbox selected them.
        for (name, policy) in &self.spec.policies {
            errors.check(&format!("/spec/policies/{name}"), policy.to_proto());
        }
        for sandbox in self.sandboxes() {
            errors.check(
                &format!("/spec/sandboxes/{}/network", sandbox.name),
                self.sandbox_network(sandbox),
            );
        }
        errors.finish()
    }
}
