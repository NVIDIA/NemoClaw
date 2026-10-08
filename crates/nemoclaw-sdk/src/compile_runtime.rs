// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use super::*;
use crate::config::ComputeDriver;
use crate::{
    Error,
    managed::{GATEWAY_KIND, GATEWAY_STORAGE_KIND, Spec},
};
pub fn runtime_targets(
    document: &Document,
    generations: &Generations,
) -> Result<Vec<Target>, Error> {
    document.validate()?;
    let service_plans = service_plans(
        document,
        generations,
        crate::services::InstallStage::Runtime,
    )?;
    crate::docker_compute::targets(&runtime_targets_with_plans(
        document,
        generations,
        &service_plans,
    )?)
}

fn runtime_targets_with_plans(
    document: &Document,
    generations: &Generations,
    service_plans: &crate::services::InstallPlans,
) -> Result<Vec<Target>, Error> {
    if !document.has_runtime() {
        return Ok(Vec::new());
    }
    if document.spec.gateway.as_kubernetes().is_some() {
        let settings = document.spec.gateway.as_managed().ok_or(Error::State(
            "managed Kubernetes gateway settings are missing",
        ))?;
        let mut targets = [
            crate::kubernetes::STORAGE_KIND,
            crate::kubernetes::AUTH_KIND,
            crate::kubernetes::GATEWAY_KIND,
        ]
        .into_iter()
        .map(|kind| {
            let spec = crate::kubernetes::Spec {
                layout: 1,
                kind: kind.into(),
                name: format!("{}-gateway", document.workspace()),
                owner: document.metadata.uid.clone(),
                generation: generation(
                    generations,
                    if kind == crate::kubernetes::AUTH_KIND {
                        crate::kubernetes::GATEWAY_KIND
                    } else {
                        kind
                    },
                )?
                .into(),
                settings: settings.clone(),
            };
            Ok(Target {
                kind: kind.into(),
                address: format!("nemoclaw_{kind}.runtime"),
                values: spec.row()?,
            })
        })
        .collect::<Result<Vec<_>, Error>>()?;
        let namespace = &settings
            .kubernetes
            .as_ref()
            .expect("Kubernetes settings")
            .namespace;
        targets.push(Target {
            kind: "helm_release".into(),
            address: crate::kubernetes::gateway::ADDRESS.into(),
            values: Row::from([
                ("name".into(), format!("{}-gateway", document.workspace())),
                ("namespace".into(), namespace.clone()),
                ("chart".into(), crate::kubernetes::gateway::CHART.into()),
            ]),
        });
        return Ok(targets);
    }
    let Some(settings) = document.spec.gateway.as_managed() else {
        return Ok(service_plans.targets().cloned().collect());
    };
    let gateway = Spec {
        layout: 2,
        compute_driver: document.spec.gateway.runtime().provider,
        kind: GATEWAY_KIND.into(),
        name: format!("{}-gateway", document.workspace()),
        owner: document.metadata.uid.clone(),
        generation: generation(generations, GATEWAY_KIND)?.into(),
        gateway: settings.runtime_settings(),
        process: None,
    };
    // The listen port changes Docker compute, not initialized data or credentials.
    let storage = gateway.storage();
    let target = |kind: &str, spec: &Spec| -> Result<Target, Error> {
        let mut values = spec.gateway_row(kind)?;
        if (kind != GATEWAY_STORAGE_KIND || storage.layout == 0)
            && let Some(policy) = settings.image_pull_policy
        {
            values.insert("image_pull_policy".into(), policy.as_str().into());
        }
        Ok(Target {
            kind: kind.into(),
            address: format!("nemoclaw_{kind}.runtime"),
            values,
        })
    };
    let mut result = vec![
        target(GATEWAY_STORAGE_KIND, &storage)?,
        target(GATEWAY_KIND, &gateway)?,
    ];
    result.extend(service_plans.targets().cloned());
    Ok(result)
}
pub(crate) fn runtime_graph(
    document: &Document,
    generations: &Generations,
    version: &str,
) -> Result<(Value, Vec<Target>), Error> {
    document.validate()?;
    let service_plans = service_plans(
        document,
        generations,
        crate::services::InstallStage::Runtime,
    )?;
    let mut graph = graph_base(document, version)?;
    if document.spec.gateway.as_kubernetes().is_some() {
        // Platform resources must be plannable before their gateway credentials
        // exist, so this stage omits the providers that need them. The
        // following deployment stage verifies the authenticated API.
        for name in crate::compile::GATEWAY_PROVIDERS {
            graph["provider"].as_object_mut().unwrap().remove(name);
            graph["terraform"]["required_providers"]
                .as_object_mut()
                .unwrap()
                .remove(name);
        }
        graph.as_object_mut().unwrap().remove("data");
        graph.as_object_mut().unwrap().remove("output");
        graph["resource"] = json!({});
        let targets = runtime_targets_with_plans(document, generations, &service_plans)?;
        for target in targets
            .iter()
            .filter(|target| target.kind != "helm_release")
        {
            // The environment list travels as JSON in the target row.
            let mut attributes = json!({});
            for (name, value) in &target.values {
                if name == crate::kubernetes::ENVIRONMENT_FIELD {
                    attributes["environment"] = serde_json::from_str(value)
                        .map_err(|_| Error::State("invalid Kubernetes environment"))?;
                } else {
                    attributes[name] = json!(value.replace("${", "$${").replace("%{", "%%{"));
                }
            }
            attributes["lifecycle"] = json!({"postcondition": [{
                "condition": "${self.running == \"true\"}",
                "error_message": "Managed Kubernetes reconciliation is incomplete; retain the same configuration and state directory, resolve prerequisites, then run apply again."
            }]});
            if target.kind == crate::kubernetes::STORAGE_KIND {
                attributes["lifecycle"]["prevent_destroy"] = json!(true);
            } else if target.kind == crate::kubernetes::AUTH_KIND {
                attributes["depends_on"] = json!(["nemoclaw_kubernetes_storage.runtime"]);
            } else {
                attributes["depends_on"] = json!([crate::kubernetes::gateway::ADDRESS]);
            }
            let (kind, name) = target.address.split_once('.').unwrap();
            graph["resource"][kind][name] = attributes;
        }
        let gateway = targets
            .iter()
            .find(|target| target.kind == crate::kubernetes::GATEWAY_KIND)
            .expect("Kubernetes gateway target");
        let spec = crate::kubernetes::Spec::from_row(&gateway.kind, &gateway.values)?;
        crate::kubernetes::gateway::configure(&mut graph, &spec)?;
        return Ok((graph, targets));
    }
    // Readiness follows gateway reconciliation, including restart or replacement.
    // Keeping it in this stage allows recovery before OpenShell resource refresh.
    let readiness = &mut graph["data"]["openshell_gateway"]["current"];
    readiness["wait_timeout_seconds"] = json!(90);
    readiness["lifecycle"] = json!({"postcondition":[{
        "condition":"${self.compatible}",
        "error_message":super::gateway_error_message("self")
    }]});
    if document.spec.gateway.as_managed().is_some() {
        readiness["depends_on"] = json!(["nemoclaw_managed_gateway.runtime"]);
    }
    let targets = runtime_targets_with_plans(document, generations, &service_plans)?;
    for target in &targets {
        let mut attrs = json!(
            target
                .values
                .iter()
                .map(|(name, value)| (
                    name.clone(),
                    json!(value.replace("${", "$${").replace("%{", "%%{"))
                ))
                .collect::<serde_json::Map<_, _>>()
        );
        if target.kind == GATEWAY_STORAGE_KIND
            || crate::services::resource_behavior(&target.kind).retained_storage
        {
            attrs["lifecycle"] = json!({"prevent_destroy":true});
        }
        if target.kind == GATEWAY_KIND {
            attrs["depends_on"] = json!(["nemoclaw_gateway_storage.runtime"]);
        }
        if let Some(dependencies) = service_plans.dependencies(&target.address) {
            attrs["depends_on"] = json!(dependencies);
        }
        let (kind, logical) = target.address.split_once('.').unwrap();
        graph["resource"][kind][logical] = attrs;
    }
    Ok((graph, targets))
}

pub fn compile_runtime(
    document: &Document,
    generations: &Generations,
    version: &str,
) -> Result<Value, Error> {
    compiled_runtime(document, generations, version).map(|(graph, _)| graph)
}

pub(crate) fn compiled_runtime(
    document: &Document,
    generations: &Generations,
    version: &str,
) -> Result<(Value, Vec<Target>), Error> {
    let (mut graph, targets) = runtime_graph(document, generations, version)?;
    crate::docker_compute::configure(&mut graph, &targets)?;
    if let Some(gateway) = targets.iter().find(|target| target.kind == GATEWAY_KIND)
        && document.spec.gateway.runtime().provider == ComputeDriver::Docker
    {
        // The process must serve its API before the authenticated capability
        // read; its readiness fails quickly when the container stops.
        let spec = Spec::from_values(GATEWAY_KIND, &gateway.values)?;
        let literal = |value: &str| json!(value.replace("${", "$${").replace("%{", "%%{"));
        graph["data"]["nemoclaw_gateway_readiness"]["current"] = json!({
            "engine": literal(spec.engine()),
            "container_id": "${docker_container.managed_gateway_runtime.id}",
            "name": literal(&spec.name),
            "owner": literal(&spec.owner),
            "endpoint": literal(&spec.gateway.endpoint),
            "wait_timeout_seconds": 90,
        });
        let capabilities = &mut graph["data"]["openshell_gateway"]["current"];
        let mut dependencies = capabilities["depends_on"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        dependencies.push(json!("data.nemoclaw_gateway_readiness.current"));
        capabilities["depends_on"] = json!(dependencies);
    }
    for target in targets
        .iter()
        .filter(|target| matches!(target.kind.as_str(), "inference_service" | "ollama_service"))
    {
        let container = crate::docker_compute::address(&target.address);
        let logical = container.split_once('.').unwrap().1;
        let spec = Spec::from_values(&target.kind, &target.values)?;
        let literal = |value: &str| value.replace("${", "$${").replace("%{", "%%{");
        let source = if target.kind == "inference_service" {
            crate::services::installers::vllm::RUNTIME_DATA_SOURCE
        } else {
            crate::services::installers::ollama::RUNTIME_DATA_SOURCE
        };
        // Readiness checks the contract the container runs with.
        graph["data"]["nemoclaw_service_readiness"][logical] = json!({
            "engine":literal(spec.engine()),
            "name":literal(&spec.name),
            "contract":format!("${{data.nemoclaw_{source}.{logical}.spec}}"),
            "container_id":format!("${{{container}.id}}"),
            "read_trigger":"${timestamp() != \"\"}",
            "wait_timeout_seconds":9 * 3600
        });
    }
    Ok((graph, crate::docker_compute::targets(&targets)?))
}
