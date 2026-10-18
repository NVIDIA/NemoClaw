// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use super::installers::ollama;
use crate::Error;
use serde_json::{Value, json};
pub(crate) fn configure_readiness(
    graph: &mut Value,
    targets: &[crate::compile::Target],
) -> Result<(), Error> {
    for target in targets
        .iter()
        .filter(|target| super::resource_behavior(&target.kind).runtime_process)
    {
        let container = crate::docker_compute::address(&target.address);
        let logical = container.split_once('.').unwrap().1;
        let spec = crate::managed::Spec::from_values(&target.kind, &target.values)?;
        let literal = |value: &str| value.replace("${", "$${").replace("%{", "%%{");
        if target.kind == super::installers::container::SERVICE_KIND {
            // Labels bind the observation to this deployment's container and
            // its compiled launch.
            let labels: std::collections::BTreeMap<_, _> = spec
                .labels()?
                .into_iter()
                .map(|(key, value)| (key, literal(&value)))
                .collect();
            let readiness: super::installers::container::ContainerReadiness = target
                .values
                .get("readiness")
                .map(|value| serde_json::from_str(value))
                .transpose()
                .map_err(|_| Error::State("invalid container readiness"))?
                .unwrap_or_default();
            let mut attributes = json!({
                "engine":literal(spec.engine()), "name":literal(&spec.name),
                "container_id":format!("${{{container}.id}}"), "labels":labels,
                "read_trigger":"${timestamp() != \"\"}",
                "wait_timeout_seconds":readiness.timeout_seconds
            });
            if let Some(path) = &readiness.runtime_status {
                attributes["runtime_status"] = json!(literal(path));
            }
            if let Some(path) = &readiness.path {
                let process = spec
                    .process
                    .as_ref()
                    .ok_or(Error::State("missing container process"))?;
                attributes["http_url"] = if process.bind_address.is_empty() {
                    json!(format!(
                        "http://${{{container}.network_data[0].ip_address}}:{}{}",
                        process.port,
                        literal(path)
                    ))
                } else {
                    json!(format!(
                        "http://{}:{}{}",
                        process.bind_address,
                        process.port,
                        literal(path)
                    ))
                };
            }
            graph["data"][super::installers::container::HEALTH_DATA_SOURCE][logical] = attributes;
            continue;
        }
        let source = if target.kind == super::installers::vllm::SERVICE_KIND {
            super::installers::vllm::RUNTIME_DATA_SOURCE
        } else {
            ollama::RUNTIME_DATA_SOURCE
        };
        let readiness = super::provider_types::readiness_type(&target.kind)
            .expect("service containers have readiness");
        let source = crate::compile::data_source_type(source);
        // Readiness checks the contract the container runs with.
        graph["data"][readiness][logical] = json!({
            "engine":literal(spec.engine()),
            "name":literal(&spec.name),
            "contract":format!("${{data.{source}.{logical}.spec}}"),
            "container_id":format!("${{{container}.id}}"),
            "read_trigger":"${timestamp() != \"\"}",
            "wait_timeout_seconds":9 * 3600
        });
    }
    for target in targets
        .iter()
        .filter(|target| target.kind == ollama::proxy::PROXY)
    {
        let container = crate::docker_compute::address(&target.address);
        let logical = container.split_once('.').unwrap().1;
        let readiness = super::provider_types::readiness_type(ollama::proxy::PROXY)
            .expect("the proxy has readiness");
        let address = format!("data.{readiness}.{logical}");
        let source = crate::compile::data_source_type(ollama::proxy::RUNTIME_DATA_SOURCE);
        let proxy = ollama::proxy::row_spec(&target.values)?;
        let literal = |value: &str| value.replace("${", "$${").replace("%{", "%%{");
        // Readiness checks the contract the container runs with.
        graph["data"][readiness][logical] = json!({
            "engine":literal(&target.values["engine"]),
            "name":literal(&proxy.name),
            "contract":format!("${{data.{source}.{logical}.spec}}"),
            "container_id":format!("${{{container}.id}}"),
            "read_trigger":"${timestamp() != \"\"}", "wait_timeout_seconds":30
        });
        // The proxy starts only after its upstream model passes the digest check.
        let model = crate::compile::data_source_type(ollama::proxy::MODEL);
        let service = target.address.split_once('.').unwrap().1;
        graph["data"][model.as_str()][service] = json!({
            "upstream":literal(&target.values["upstream"]),
            "name":literal(&target.values["model"]),
            "digest":literal(&target.values["digest"]),
        });
        let (kind, label) = container.split_once('.').unwrap();
        let started = &mut graph["resource"][kind][label]["depends_on"];
        let mut dependencies = started.as_array().cloned().unwrap_or_default();
        dependencies.push(json!(format!("data.{model}.{service}")));
        *started = json!(dependencies);
        for instances in graph["resource"].as_object_mut().unwrap().values_mut() {
            for resource in instances.as_object_mut().unwrap().values_mut() {
                if let Some(dependencies) = resource["depends_on"].as_array_mut()
                    && dependencies.contains(&json!(container))
                {
                    dependencies.push(json!(address));
                }
            }
        }
    }
    Ok(())
}
