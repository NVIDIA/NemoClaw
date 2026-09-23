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
    let Some(settings) = document.spec.gateway.as_managed() else {
        return Ok(service_plans.targets().cloned().collect());
    };
    let gateway = Spec {
        layout: 2,
        compute_driver: document.spec.sandboxes[0].runtime.provider,
        kind: GATEWAY_KIND.into(),
        name: format!("{}-gateway", document.workspace()),
        owner: document.metadata.uid.clone(),
        generation: generation(generations, GATEWAY_KIND)?.into(),
        gateway: settings.runtime_settings(),
        process: None,
    };
    let mut storage = gateway.clone();
    storage.layout = if gateway.compute_driver == ComputeDriver::Docker {
        1
    } else {
        0
    };
    if storage.layout == 1 {
        // The listen port changes compute, not initialized data or credentials.
        storage.gateway.endpoint = "http://127.0.0.1:8080".into();
    }
    let target = |kind: &str, spec: String| {
        let mut values = Row::from([("spec".into(), spec)]);
        if (kind != GATEWAY_STORAGE_KIND || storage.layout == 0)
            && let Some(policy) = settings.image_pull_policy
        {
            values.insert("image_pull_policy".into(), policy.as_str().into());
        }
        Target {
            kind: kind.into(),
            address: format!("nemoclaw_{kind}.runtime"),
            values,
        }
    };
    let mut result = vec![
        target(GATEWAY_STORAGE_KIND, storage.json()?),
        target(GATEWAY_KIND, gateway.json()?),
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
    let mut graph = graph_base(document, version);
    // Readiness follows gateway reconciliation, including restart or replacement.
    // Keeping it in this stage allows recovery before OpenShell resource refresh.
    let readiness = &mut graph["data"]["nemoclaw_gateway_capabilities"]["current"];
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
        let mut attrs =
            json!({"spec":target.values["spec"].replace("${", "$${").replace("%{", "%%{")});
        if let Some(policy) = target.values.get("image_pull_policy") {
            attrs["image_pull_policy"] = json!(policy);
        }
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
    for target in targets
        .iter()
        .filter(|target| matches!(target.kind.as_str(), "inference_service" | "ollama_service"))
    {
        let container = crate::docker_compute::address(&target.address);
        let logical = container.split_once('.').unwrap().1;
        graph["data"]["nemoclaw_service_readiness"][logical] = json!({
            "spec":target.values["spec"].replace("${", "$${").replace("%{", "%%{"),
            "container_id":format!("${{{container}.id}}"),
            "read_trigger":"${timestamp() != \"\"}",
            "wait_timeout_seconds":9 * 3600
        });
    }
    Ok((graph, crate::docker_compute::targets(&targets)?))
}
