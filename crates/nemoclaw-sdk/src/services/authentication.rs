// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use crate::ObservationError;
use serde::{Deserialize, Serialize};
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum Source {
    ClusterService {
        storage: Box<crate::kubernetes::services::StorageSpec>,
        endpoint: String,
    },
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
    pub fn fields(&self) -> Option<(&crate::managed::Storage, &str, &str)> {
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
            } => Some((storage, container, endpoint)),
            Self::ClusterService { .. } => None,
        }
    }
    pub fn parse(value: &str, owner: &str, endpoint: &str) -> Result<Self, ObservationError> {
        let source: Self = serde_json::from_str(value).map_err(|_| ObservationError::Incomplete)?;
        use sha2::{Digest, Sha256};
        let prefix = format!(
            "nc-{}-",
            Sha256::digest(owner.as_bytes())[..8]
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>()
        );
        if let Self::ClusterService {
            storage,
            endpoint: published,
        } = &source
        {
            storage
                .validate()
                .map_err(|_| ObservationError::BindingMismatch)?;
            let url = url::Url::parse(published).map_err(|_| ObservationError::BindingMismatch)?;
            let host =
                crate::kubernetes::services::service_host(&storage.name, storage.namespace());
            if storage.owner != owner
                || !storage.authenticated
                || !storage.name.starts_with(&format!("{prefix}model-"))
                || published != endpoint
                || url.scheme() != "http"
                || url.host_str() != Some(host.as_str())
                || url.port().is_none_or(|port| port == 0)
                || url.path() != "/v1"
                || !url.username().is_empty()
                || url.password().is_some()
                || url.query().is_some()
                || url.fragment().is_some()
            {
                return Err(ObservationError::BindingMismatch);
            }
            return Ok(source);
        }
        nemoclaw_docker::credentials::Source::parse(value, owner, endpoint)?;
        Ok(source)
    }
}

/// The credential source as a registration annotation value.
pub(crate) fn source_json(source: &Source) -> Result<String, crate::config::ConfigError> {
    let source = serde_json::to_string(source).expect("typed credential source");
    crate::config::credential_metadata::pack(&source).map_err(|_| {
        crate::config::ConfigError::new(
            "managed credential reference exceeds gateway annotation capacity",
        )
    })?;
    Ok(source)
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
            "kubernetes_storage",
            "kubernetes_gateway",
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
    fn cluster_source() -> (Source, crate::backend::Row) {
        let document = crate::config::Document::parse(
            include_bytes!("../../../../examples/kubernetes/local-vllm.yaml").as_slice(),
        )
        .unwrap();
        let row = provider(&document);
        let source =
            Source::parse(&row["credential_source"], &row["owner"], &row["endpoint"]).unwrap();
        (source, row)
    }

    #[test]
    fn cluster_source_rejects_a_foreign_owner_with_the_expected_model_name() {
        let (mut source, row) = cluster_source();
        let Source::ClusterService { storage, .. } = &mut source else {
            panic!("compiled cluster credential source")
        };
        // Keep storage internally consistent and preserve the expected name prefix,
        // so only the registration's owner binding rejects this source.
        storage.owner = "11111111-1111-4111-8111-111111111111".into();
        storage.gateway.owner = storage.owner.clone();
        storage.validate().unwrap();
        assert_eq!(
            Source::parse(
                &serde_json::to_string(&source).unwrap(),
                &row["owner"],
                &row["endpoint"]
            ),
            Err(ObservationError::BindingMismatch)
        );
    }

    #[test]
    fn cluster_source_rejects_a_foreign_model_name_with_the_expected_owner() {
        let (mut source, row) = cluster_source();
        let Source::ClusterService { storage, endpoint } = &mut source else {
            panic!("compiled cluster credential source")
        };
        storage.name = "nc-0000000000000000-model-0000000000000000".into();
        storage.validate().unwrap();
        let mut url = url::Url::parse(endpoint).unwrap();
        url.set_host(Some(&crate::kubernetes::services::service_host(
            &storage.name,
            storage.namespace(),
        )))
        .unwrap();
        *endpoint = url.to_string();
        let endpoint = endpoint.clone();
        assert_eq!(
            Source::parse(
                &serde_json::to_string(&source).unwrap(),
                &row["owner"],
                &endpoint
            ),
            Err(ObservationError::BindingMismatch)
        );
    }

    #[test]
    fn cluster_source_rejects_each_invalid_endpoint_component() {
        let (source, row) = cluster_source();
        for case in [
            "scheme",
            "host",
            "missing port",
            "zero port",
            "path",
            "username",
            "password",
            "query",
            "fragment",
        ] {
            let mut changed = source.clone();
            let Source::ClusterService { endpoint, .. } = &mut changed else {
                panic!("compiled cluster credential source")
            };
            let mut url = url::Url::parse(endpoint).unwrap();
            match case {
                "scheme" => url.set_scheme("https").unwrap(),
                "host" => url
                    .set_host(Some("foreign.default.svc.cluster.local"))
                    .unwrap(),
                "missing port" => url.set_port(None).unwrap(),
                "zero port" => url.set_port(Some(0)).unwrap(),
                "path" => url.set_path("/v1/completions"),
                "username" => url.set_username("foreign").unwrap(),
                "password" => url.set_password(Some("foreign")).unwrap(),
                "query" => url.set_query(Some("foreign=value")),
                "fragment" => url.set_fragment(Some("foreign")),
                _ => unreachable!(),
            }
            *endpoint = url.to_string();
            // Matching the published URL to the registration prevents its equality
            // check from masking a missing check on an individual URL component.
            let endpoint = endpoint.clone();
            assert_eq!(
                Source::parse(
                    &serde_json::to_string(&changed).unwrap(),
                    &row["owner"],
                    &endpoint
                ),
                Err(ObservationError::BindingMismatch),
                "{case}"
            );
        }
    }

    #[test]
    fn cluster_source_rejects_invalid_storage_before_using_its_cluster_target() {
        let (source, row) = cluster_source();
        let original = serde_json::to_value(source).unwrap();
        for (case, pointer, invalid) in [
            ("layout", "/storage/layout", json!(0)),
            ("kind", "/storage/kind", json!("kubernetes_service")),
            ("generation", "/storage/generation", json!("invalid")),
            ("capacity", "/storage/storageGib", json!(0)),
            ("gateway kind", "/storage/gateway/kind", json!("foreign")),
            (
                "missing cluster target",
                "/storage/gateway/settings/kubernetes",
                Value::Null,
            ),
            (
                "empty cluster context",
                "/storage/gateway/settings/kubernetes/context",
                json!(""),
            ),
        ] {
            let mut changed = original.clone();
            *changed
                .pointer_mut(pointer)
                .unwrap_or_else(|| panic!("missing {case} fixture field: {pointer}")) = invalid;
            assert_eq!(
                Source::parse(&changed.to_string(), &row["owner"], &row["endpoint"]),
                Err(ObservationError::BindingMismatch),
                "{case}"
            );
        }
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
        assert!(source.fields().unwrap().0.engine.starts_with("ssh://"));
        assert_eq!(source.fields().unwrap().2, row["endpoint"]);
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
