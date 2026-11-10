// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! The Service that publishes a managed Kubernetes gateway's endpoint; the
//! bundled Kubernetes provider owns it.
//!
//! Like a Docker gateway's published port, the Service forwards the
//! endpoint's port to the gateway's own TLS listener, so TLS and client
//! certificates pass through unchanged. It publishes only the gateway's
//! `grpc` port; metrics stay on the chart's ClusterIP Service.

use super::{
    Spec,
    cluster::OWNER_LABEL,
    gateway::{KUBECONFIG_VARIABLE, literal},
};
use crate::{
    Error, artifact_pins as pins,
    backend::Row,
    compile::Target,
    config::{Document, ExposureServiceType},
};
use serde_json::{Value, json};
use std::collections::BTreeMap;

pub const PROVIDER_ADDRESS: &str = "registry.opentofu.org/hashicorp/kubernetes";
pub use pins::KUBERNETES_PROVIDER_VERSION as PROVIDER_VERSION;
/// The OpenTofu resource type of the exposure Service.
pub const RESOURCE_TYPE: &str = "kubernetes_service_v1";
/// The exposure Service's address in the runtime graph.
pub const ADDRESS: &str = "kubernetes_service_v1.gateway_exposure";

/// What selects the address a managed Kubernetes gateway's endpoint names:
/// its exposure Service's type and annotations. Like the endpoint, it stays
/// as first planned; source ranges only admit clients and may change.
pub fn binding(document: &Document) -> Option<(ExposureServiceType, &BTreeMap<String, String>)> {
    let service = &document
        .spec
        .gateway
        .as_managed()?
        .kubernetes
        .as_ref()?
        .expose
        .as_ref()?
        .service;
    Some((service.service_type, &service.annotations))
}

/// How long the gateway reads wait for an exposed endpoint to answer, in
/// seconds. A node port is programmed within seconds; a load balancer's
/// address may route only after its health checks pass. 300 seconds is the
/// gateway data source's limit.
pub fn read_wait(document: &Document) -> Option<u64> {
    binding(document).map(|(service_type, _)| match service_type {
        ExposureServiceType::NodePort => 90,
        ExposureServiceType::LoadBalancer => 300,
    })
}

/// The Service's name: the release's, with `-exposure`.
fn name(release: &str) -> String {
    format!("{release}-exposure")
}

/// The runtime target of an exposed gateway's Service.
pub(crate) fn target(document: &Document) -> Option<Target> {
    let kubernetes = document.spec.gateway.as_managed()?.kubernetes.as_ref()?;
    kubernetes.expose.as_ref()?;
    Some(Target {
        kind: RESOURCE_TYPE.into(),
        address: ADDRESS.into(),
        values: Row::from([
            (
                "name".into(),
                name(&format!("{}-gateway", document.workspace())),
            ),
            ("namespace".into(), kubernetes.namespace.clone()),
        ]),
    })
}

/// Declare an exposed gateway's Service and the provider that owns it. The
/// Helm provider's configuration, written first, declares the kubeconfig
/// variable both use.
pub(crate) fn configure(graph: &mut Value, spec: &Spec) -> Result<(), Error> {
    let target = spec.settings.kubernetes.as_ref().ok_or(Error::State(
        "managed Kubernetes gateway settings are missing",
    ))?;
    let Some(expose) = &target.expose else {
        return Ok(());
    };
    // The schema requires an explicit port; the URL omits HTTPS's 443.
    let port = url::Url::parse(&spec.settings.endpoint)
        .ok()
        .and_then(|endpoint| endpoint.port_or_known_default())
        .ok_or(Error::State("managed Kubernetes endpoint has no port"))?;
    graph["terraform"]["required_providers"]["kubernetes"] = json!({
        "source": PROVIDER_ADDRESS, "version": format!("= {PROVIDER_VERSION}")
    });
    // Annotations a load-balancer controller adds stay unmanaged; authored
    // annotations are still compared.
    let mut provider = json!({"ignore_annotations": [".*"]});
    // Without a kubeconfig, the provider's client loads the service account
    // of the pod that runs NemoClaw.
    if let Some(context) = &target.context {
        provider["config_path"] = json!(format!("${{var.{KUBECONFIG_VARIABLE}}}"));
        provider["config_context"] = json!(literal(context));
    }
    graph["provider"]["kubernetes"] = provider;
    let service = &expose.service;
    let mut labels = serde_json::Map::new();
    labels.insert(OWNER_LABEL.into(), json!(literal(&spec.owner)));
    let mut metadata = json!({
        "name": literal(&name(&spec.name)),
        "namespace": literal(&target.namespace),
        "labels": labels,
    });
    let mut grpc = json!({"name": "grpc", "protocol": "TCP", "port": port, "target_port": "grpc"});
    let mut resource = json!({"depends_on": ["openshell_kubernetes_auth.runtime"]});
    let mut service_spec = json!({
        "type": service.service_type.as_str(),
        "selector": {
            "app.kubernetes.io/name": "openshell",
            "app.kubernetes.io/instance": literal(&spec.name),
        },
    });
    match service.service_type {
        ExposureServiceType::NodePort => grpc["node_port"] = json!(port),
        ExposureServiceType::LoadBalancer => {
            if !service.annotations.is_empty() {
                metadata["annotations"] = json!(
                    service
                        .annotations
                        .iter()
                        .map(|(key, value)| (key.clone(), json!(literal(value))))
                        .collect::<serde_json::Map<_, _>>()
                );
            }
            if !service.load_balancer_source_ranges.is_empty() {
                service_spec["load_balancer_source_ranges"] =
                    json!(service.load_balancer_source_ranges);
            }
            resource["wait_for_load_balancer"] = json!(true);
            // Some controllers, such as the AWS Load Balancer Controller's
            // webhook, set a class on create; the field forces replacement.
            resource["lifecycle"] = json!({"ignore_changes": ["spec[0].load_balancer_class"]});
        }
    }
    service_spec["port"] = json!([grpc]);
    resource["metadata"] = json!([metadata]);
    resource["spec"] = json!([service_spec]);
    graph["resource"][RESOURCE_TYPE]["gateway_exposure"] = resource;
    Ok(())
}
