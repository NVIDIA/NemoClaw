// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use crate::ObservationError;
use serde::{Deserialize, Serialize};
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum Source {
    OllamaProxy {
        storage: crate::managed::Storage,
        container: String,
        endpoint: String,
    },
    ManagedService {
        storage: crate::managed::Storage,
        container: String,
        endpoint: String,
    },
}
impl Source {
    pub fn fields(&self) -> (&crate::managed::Storage, &str, &str) {
        match self {
            Self::OllamaProxy {
                storage,
                container,
                endpoint,
            }
            | Self::ManagedService {
                storage,
                container,
                endpoint,
            } => (storage, container, endpoint),
        }
    }
    pub(crate) fn json(&self) -> Result<String, crate::config::ConfigError> {
        let source = serde_json::to_string(self).expect("typed credential source");
        crate::config::credential_metadata::pack(&source).map_err(|_| {
            crate::config::ConfigError::new(
                "managed credential reference exceeds gateway annotation capacity",
            )
        })?;
        Ok(source)
    }

    pub fn parse(value: &str, owner: &str, endpoint: &str) -> Result<Self, ObservationError> {
        let source: Self = serde_json::from_str(value).map_err(|_| ObservationError::Incomplete)?;
        use sha2::{Digest, Sha256};
        let (storage, container, published) = source.fields();
        let prefix = format!(
            "nc-{}-",
            Sha256::digest(owner.as_bytes())[..8]
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>()
        );
        let (kind, suffix, local) = match source {
            Self::OllamaProxy { .. } => ("ollama-proxy-", "auth", true),
            Self::ManagedService { .. } => ("inference-", "auth", false),
        };
        let namespace = format!("{prefix}{kind}");
        let name = container.strip_prefix(&namespace);
        let address = published
            .strip_prefix("http://")
            .and_then(|s| s.strip_suffix("/v1"))
            .and_then(|s| s.parse::<std::net::SocketAddr>().ok());
        let private = address.is_some_and(|address| {
            address.port() != 0
                && match address.ip() {
                    std::net::IpAddr::V4(ip) => ip.is_private() || ip.is_loopback(),
                    std::net::IpAddr::V6(ip) => local && (ip.is_unique_local() || ip.is_loopback()),
                }
        });
        if storage.validate().is_err()
            || storage.owner != owner
            || published != endpoint
            || !private
            || (local && !storage.engine.starts_with("unix:///"))
            || !name.is_some_and(|name| {
                regex::Regex::new(r"^[a-z][a-z0-9-]*$")
                    .unwrap()
                    .is_match(name)
            })
            || storage.name != format!("{container}-{suffix}")
        {
            return Err(ObservationError::BindingMismatch);
        }
        Ok(source)
    }
}

#[cfg(test)]
mod durable_source_tests {
    use super::*;
    use serde_json::{Value, json};
    fn document(proxy: bool) -> crate::config::Document {
        let text = if proxy {
            include_str!("../../tests/fixtures/config/managed-ollama.yaml")
        } else {
            include_str!("../../tests/fixtures/config/spark.yaml")
        };
        let mut value: Value = serde_saphyr::from_str(text).unwrap();
        if proxy {
            value["spec"]["inferenceProviders"][0]["serviceRef"] = json!("ollama-auth");
            value["spec"]["services"] = json!({"ollama-auth":{"kind":"ollamaProxy","image":format!("proxy@sha256:{}","a".repeat(64)),"endpoint":"http://172.20.0.1:11435/v1","upstream":{"endpoint":"http://127.0.0.1:11434/v1","model":{"name":"qwen3:0.6b","digest":"a".repeat(64)}}}});
        } else {
            value["spec"]["services"]["qwen"]["authentication"] = json!("bearer");
        }
        crate::config::Document::parse(value.to_string().as_bytes()).unwrap()
    }
    fn provider(document: &crate::config::Document) -> crate::backend::Row {
        let generations = [
            "workspace",
            "provider",
            "sandbox",
            "managed_gateway",
            "inference_service",
            "ollama_proxy",
        ]
        .map(|kind| (kind.into(), "a".repeat(32)))
        .into();
        crate::compile::targets(document, &generations)
            .unwrap()
            .into_iter()
            .find(|target| target.kind == "provider")
            .unwrap()
            .values
    }
    #[test]
    fn remote_source_retains_published_endpoint_without_compute_configuration() {
        let mut document = crate::config::Document::parse(
            include_bytes!("../../../../examples/spark/remote-vllm.yaml").as_slice(),
        )
        .unwrap();
        let crate::services::ServiceDefinition::Vllm(service) =
            document.spec.services.get_mut("qwen").unwrap()
        else {
            panic!("vLLM example")
        };
        service.authentication =
            Some(crate::services::installers::vllm::ServiceAuthentication::Bearer);
        let row = provider(&document);
        let source = Source::parse(
            &row["credential_source"],
            &document.metadata.uid,
            &row["endpoint"],
        )
        .unwrap();
        assert!(source.fields().0.engine.starts_with("ssh://"));
        assert_eq!(source.fields().2, row["endpoint"]);
        assert!(!row["credential_source"].contains("sha256:"));
    }
    #[test]
    fn authenticated_image_replacement_preserves_registration_source() {
        for proxy in [false, true] {
            let original = document(proxy);
            let before = provider(&original);
            let mut value = serde_json::to_value(&original).unwrap();
            let name = if proxy { "ollama-auth" } else { "qwen" };
            value["spec"]["services"][name]["image"] =
                json!(format!("replacement@sha256:{}", "b".repeat(64)));
            let changed = crate::config::Document::parse(value.to_string().as_bytes()).unwrap();
            let after = provider(&changed);
            assert_eq!(
                before["credential_source"], after["credential_source"],
                "disposable image changes must not change durable registration identity"
            );
            Source::parse(
                &after["credential_source"],
                &changed.metadata.uid,
                &after["endpoint"],
            )
            .unwrap();
        }
    }
    #[test]
    fn durable_source_rejects_namespace_endpoint_and_unknown_fields() {
        for proxy in [false, true] {
            let document = document(proxy);
            let row = provider(&document);
            let text = &row["credential_source"];
            Source::parse(text, &document.metadata.uid, &row["endpoint"]).unwrap();
            assert!(Source::parse(text, "foreign", &row["endpoint"]).is_err());
            assert!(
                Source::parse(text, &document.metadata.uid, "http://127.0.0.1:1234/v1").is_err()
            );
            let original: Value = serde_json::from_str(text).unwrap();
            for field in ["container", "endpoint", "unknown"] {
                let mut changed = original.clone();
                changed[field] = json!("foreign");
                assert!(
                    Source::parse(
                        &changed.to_string(),
                        &document.metadata.uid,
                        &row["endpoint"]
                    )
                    .is_err()
                );
            }
            for field in ["Name", "Owner", "Generation", "Engine"] {
                let mut changed = original.clone();
                changed["storage"][field] = json!("foreign");
                assert!(
                    Source::parse(
                        &changed.to_string(),
                        &document.metadata.uid,
                        &row["endpoint"]
                    )
                    .is_err()
                );
            }
        }
    }
}
