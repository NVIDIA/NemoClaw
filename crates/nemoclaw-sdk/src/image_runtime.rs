// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Image runtime metadata, with the Fabric adapter and deployment policy rules
//! that only the SDK applies.
use crate::{config::ExplicitPolicy, fabric_catalog::FabricAdapter};
use std::collections::BTreeMap;

pub use nemoclaw_openshell::runtime::{ImageRuntime, PolicyInput, RuntimeBinding, path_is_granted};

/// Whether `runtime` is well formed and resolves every installed adapter.
pub(crate) fn valid_for(runtime: &ImageRuntime, adapters: &[FabricAdapter]) -> bool {
    runtime.valid_layout()
        && runtime.binaries.len() == adapters.len()
        && adapters
            .iter()
            .all(|adapter| runtime.binaries.contains_key(adapter.adapter_id()))
}

/// Authored policy and deployment-owned endpoint grants for a sandbox.
pub fn policy_input(
    document: &crate::config::Document,
    sandbox: &crate::config::Sandbox,
) -> Result<PolicyInput, crate::config::ConfigError> {
    use crate::config::{ConfigError, NetworkPolicy};
    let explicit = match &sandbox.network.policy {
        NetworkPolicy::Isolated => None,
        NetworkPolicy::Explicit(policy) => Some(policy.clone()),
    };
    let mut managed = BTreeMap::new();
    if let Some(search) = document.web_search(sandbox)? {
        if explicit.as_ref().is_some_and(|policy| {
            policy.network_policies.keys().any(|name| {
                name == search.provider.profile()
                    || name.starts_with(&format!("{}-", search.provider.profile()))
            })
        }) {
            return Err(ConfigError::new(
                "the managed search policy name is reserved for web search",
            ));
        }
        let mut rule = crate::config::search_policy(search.provider);
        rule.name = search
            .provider
            .image_profile(&document.image_scope(sandbox)?);
        rule.binaries.clear();
        managed.insert(rule.name.clone(), rule);
    }
    for provider in document.sandbox_inference_providers(sandbox)? {
        let connection = document.provider_connection(provider.definition)?;
        let profile = crate::config::inference_profile(
            &provider.key,
            &connection.endpoint,
            provider.definition.provider,
            false,
        )
        .map_err(|_| ConfigError::new("invalid native inference policy"))?;
        let policy = openshell_core::proto::SandboxPolicy {
            version: 1,
            network_policies: [(
                profile.id.clone(),
                openshell_core::proto::NetworkPolicyRule {
                    name: profile.id,
                    endpoints: profile.endpoints,
                    binaries: vec![],
                },
            )]
            .into(),
            ..Default::default()
        };
        let value = crate::config::policy_json(&policy)
            .map_err(|_| ConfigError::new("cannot encode inference policy"))?;
        let policy: ExplicitPolicy = serde_json::from_str(&value)
            .map_err(|_| ConfigError::new("cannot represent inference policy"))?;
        managed.extend(policy.network_policies);
    }
    if explicit.as_ref().is_some_and(|policy| {
        managed
            .keys()
            .any(|name| policy.network_policies.contains_key(name))
    }) {
        return Err(ConfigError::new(
            "managed inference and search policy names are reserved",
        ));
    }
    Ok(PolicyInput { explicit, managed })
}
