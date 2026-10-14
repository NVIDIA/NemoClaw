// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use super::installers::ollama;
use crate::Error;
use serde_json::{Value, json};
pub(crate) fn configure_proxy_readiness(
    graph: &mut Value,
    targets: &[crate::compile::Target],
) -> Result<(), Error> {
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
