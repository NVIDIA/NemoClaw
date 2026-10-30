// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
pub mod authentication;
mod registry;
pub use registry::BackendRegistry;
pub(crate) mod capacity;
pub use capacity::{
    ServiceCapacity, observe_service_capacity, validate_capacity_contracts, validate_capacity_gpu,
};
mod readiness;
mod status;
pub use readiness::{Readiness, wait_service_ready};
pub mod installers;

/// Provider definition for an installer-owned SDK resource schema.
pub(crate) fn schema_definition(kind: &str) -> crate::Definition {
    let schema = nemoclaw_sdk::services::resource_schemas()
        .into_iter()
        .find(|schema| schema.kind == kind)
        .unwrap_or_else(|| panic!("the SDK defines no {kind} resource schema"));
    crate::Definition::new(schema.kind, schema.fields, schema.mutable)
}

/// Omitted owner and generation are generated on create.
fn generated_identity(definition: crate::Definition) -> crate::Definition {
    definition
        .generated("owner", nemoclaw_backend::generate_owner)
        .generated("generation", nemoclaw_backend::generate_generation)
}

/// Service storage whose omitted identity the provider generates on create.
fn storage_definition(kind: &str) -> crate::Definition {
    generated_identity(schema_definition(kind).validate_attribute(crate::managed::Storage::check))
}

/// The runtime a service contract describes, and so which provider reads it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ServiceRuntime {
    Vllm,
    Ollama,
    OllamaProxy,
}

impl ServiceRuntime {
    /// The runtime `contract` describes: runtime contracts name their kind;
    /// the Ollama proxy contract does not.
    ///
    /// # Errors
    /// Returns an error when `contract` is not a runtime contract.
    pub fn of_contract(contract: &str) -> Result<Self, crate::Error> {
        let invalid =
            || crate::Error::Conflict("contract must be a runtime contract data source's spec");
        let value: serde_json::Value = serde_json::from_str(contract).map_err(|_| invalid())?;
        match value.get("kind").map(|kind| kind.as_str()) {
            None => Ok(Self::OllamaProxy),
            Some(Some("vllm")) => Ok(Self::Vllm),
            Some(Some("ollama")) => Ok(Self::Ollama),
            Some(_) => Err(invalid()),
        }
    }

    /// Reject a contract for another runtime, naming the runtime it is for.
    ///
    /// # Errors
    /// Returns an error when `contract` is invalid or for another runtime.
    pub fn check(self, contract: &str) -> Result<(), crate::Error> {
        match Self::of_contract(contract)? {
            found if found == self => Ok(()),
            Self::Vllm => Err(crate::Error::Conflict(
                "contract is a vLLM contract; read it with the vllm provider's data sources",
            )),
            Self::Ollama => Err(crate::Error::Conflict(
                "contract is an Ollama contract; read it with the ollama provider's ollama_* data sources",
            )),
            Self::OllamaProxy => Err(crate::Error::Conflict(
                "contract is an Ollama proxy contract; read it with ollama_proxy_readiness",
            )),
        }
    }
}

/// Installer-owned credential storage resources.
pub(crate) fn definitions() -> [crate::Definition; 2] {
    use nemoclaw_sdk::services::installers::{ollama, vllm};
    [
        generated_identity(schema_definition(ollama::proxy::STORAGE)),
        storage_definition(vllm::STORAGE_KIND),
    ]
}
