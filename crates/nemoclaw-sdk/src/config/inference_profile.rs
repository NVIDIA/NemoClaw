// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use crate::{ObservationError, config::InferenceProviderKind};
use nemoclaw_openshell::profile::definition;
use openshell_core::proto;

/// Project a document-owned service before its cluster address exists. This does
/// not grant private destinations; the provider adds verified Service addresses.
pub fn for_provider(
    document: &crate::config::Document,
    provider: &crate::config::InferenceProvider,
    name: &str,
    authenticated: bool,
) -> Result<proto::ProviderProfile, ObservationError> {
    let endpoint = document
        .provider_connection(provider)
        .map_err(|_| ObservationError::Query)?
        .endpoint;
    if provider
        .service_ref
        .as_ref()
        .and_then(|name| document.spec.services.get(name))
        .is_some_and(|service| service.kubernetes().is_some())
    {
        nemoclaw_openshell::profile::cluster_definition(
            name,
            &endpoint,
            provider.provider,
            authenticated,
            &[],
        )
    } else {
        definition(name, &endpoint, provider.provider, authenticated)
    }
}

/// Build a policy for a bound cluster service using only its observed addresses.
/// Callers must verify the Service identity before supplying these addresses.
pub fn cluster_definition(
    name: &str,
    endpoint: &str,
    kind: InferenceProviderKind,
    authenticated: bool,
    storage: &crate::kubernetes::services::StorageSpec,
    addresses: &[std::net::IpAddr],
) -> Result<proto::ProviderProfile, ObservationError> {
    storage
        .validate()
        .map_err(|_| ObservationError::BindingMismatch)?;
    let url = url::Url::parse(endpoint).map_err(|_| ObservationError::Query)?;
    let host = crate::kubernetes::services::service_host(&storage.name, storage.namespace());
    if authenticated != storage.authenticated || url.host_str() != Some(host.as_str()) {
        return Err(ObservationError::BindingMismatch);
    }
    nemoclaw_openshell::profile::cluster_definition(name, endpoint, kind, authenticated, addresses)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_inference_policy_input_bytes_do_not_name_cluster_grants() {
        let document = crate::config::Document::parse(
            include_bytes!("../../../../examples/spark/vllm.yaml").as_slice(),
        )
        .unwrap();
        let input =
            crate::image_runtime::policy_input(&document, &document.spec.sandboxes[0]).unwrap();
        let prior_wire_format = format!(
            "{{\"explicit\":{},\"managed\":{}}}",
            serde_json::to_string(&input.explicit).unwrap(),
            serde_json::to_string(&input.managed).unwrap()
        );
        assert_eq!(serde_json::to_string(&input).unwrap(), prior_wire_format);
    }

    #[test]
    fn cluster_model_endpoints_resolve_without_pod_search_domains() {
        for example in [
            include_bytes!("../../../../examples/kubernetes/local-vllm.yaml").as_slice(),
            include_bytes!("../../../../examples/kubernetes/local-ollama.yaml").as_slice(),
        ] {
            let document = crate::config::Document::parse(example).unwrap();
            let generations = [
                "workspace",
                "provider",
                "sandbox",
                "kubernetes_storage",
                "kubernetes_gateway",
                "inference_service",
                "ollama_service",
            ]
            .map(|kind| (kind.into(), "a".repeat(32)))
            .into();
            let runtime = crate::compile::runtime_targets(&document, &generations).unwrap();
            let spec = crate::kubernetes::services::Spec::decode(
                &runtime
                    .iter()
                    .find(|target| target.kind == crate::kubernetes::services::SERVICE_KIND)
                    .unwrap()
                    .values["spec"],
            )
            .unwrap();
            let targets = crate::compile::targets(&document, &generations).unwrap();
            let provider = &targets
                .iter()
                .find(|target| target.kind == "provider")
                .unwrap()
                .values;
            assert_eq!(provider["endpoint"], spec.endpoint());
            assert_eq!(
                url::Url::parse(&provider["endpoint"])
                    .unwrap()
                    .host_str()
                    .unwrap(),
                format!("{}.{}.svc.cluster.local", spec.name, spec.namespace())
            );
            if spec.authenticated() {
                crate::services::authentication::Source::parse(
                    &provider["credential_source"],
                    &document.metadata.uid,
                    &provider["endpoint"],
                )
                .unwrap();
            }
            let short = spec.endpoint().replace(".svc.cluster.local:", ".svc:");
            assert!(
                cluster_definition(
                    "model",
                    &short,
                    InferenceProviderKind::Openai,
                    spec.authenticated(),
                    &spec.storage(),
                    &["10.96.0.42".parse().unwrap()]
                )
                .is_err()
            );
        }
    }

    #[test]
    fn cluster_model_projection_accepts_owned_dns_without_allowing_authored_http_dns() {
        assert!(
            crate::config::validate_endpoint("http://arbitrary.default.svc:8000/v1", false)
                .is_err()
        );
        let document = crate::config::Document::parse(
            include_bytes!("../../../../examples/kubernetes/local-vllm.yaml").as_slice(),
        )
        .unwrap();
        let sandbox = &document.spec.sandboxes[0];
        let projected = crate::fabric_config::for_sandbox(&document, sandbox).unwrap();
        assert!(
            projected["models"]["default"]["base_url"]
                .as_str()
                .unwrap()
                .contains(".nemoclaw-local-vllm.svc.cluster.local:")
        );
        assert_eq!(projected["models"]["default"]["api"], "openai-completions");
        let policy = crate::image_runtime::policy_input(&document, sandbox).unwrap();
        let encoded = serde_json::to_value(policy).unwrap();
        assert!(!encoded["managed"].as_object().unwrap().is_empty());
        assert!(
            encoded["managed"]
                .as_object()
                .unwrap()
                .values()
                .all(|rule| rule["endpoints"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .all(|endpoint| endpoint["allowed_ips"].as_array().is_none_or(Vec::is_empty)))
        );
    }
}
