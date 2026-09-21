// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use super::*;
use crate::{
    Error,
    managed::{GATEWAY_KIND, GATEWAY_STORAGE_KIND, Spec},
};

fn require_resolved_service_images(document: &Document) -> Result<(), Error> {
    if document.spec.services.values().any(|definition| {
        matches!(definition, crate::services::ServiceDefinition::Vllm(service) if service.image.is_empty())
    }) {
        return Err(ConfigError::new(
            "vLLM target image is unresolved; replace null with an immutable v1 runtime image reference",
        )
        .into());
    }
    Ok(())
}

pub fn runtime_targets(
    document: &Document,
    generations: &Generations,
) -> Result<Vec<Target>, Error> {
    document.validate()?;
    require_resolved_service_images(document)?;
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
    let gateway = Spec {
        layout: 2,
        compute_driver: document.spec.sandboxes[0].runtime.provider.clone(),
        kind: GATEWAY_KIND.into(),
        name: format!("{}-gateway", document.workspace()),
        owner: document.metadata.uid.clone(),
        generation: generation(generations, GATEWAY_KIND)?.into(),
        gateway: document.spec.gateway.runtime_settings(),
        process: None,
    };
    let mut storage = gateway.clone();
    storage.layout = if gateway.compute_driver == "docker" {
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
            && let Some(policy) = document.spec.gateway.image_pull_policy
        {
            values.insert("image_pull_policy".into(), policy.as_str().into());
        }
        Target {
            kind: kind.into(),
            address: format!("nemoclaw_{kind}.runtime"),
            values,
        }
    };
    let mut result = if document.spec.gateway.management == "managed" {
        vec![
            target(GATEWAY_STORAGE_KIND, storage.json()?),
            target(GATEWAY_KIND, gateway.json()?),
        ]
    } else {
        Vec::new()
    };
    result.extend(service_plans.targets().cloned());
    Ok(result)
}
pub(crate) fn runtime_graph(
    document: &Document,
    generations: &Generations,
    version: &str,
) -> Result<(Value, Vec<Target>), Error> {
    document.validate()?;
    require_resolved_service_images(document)?;
    let service_plans = service_plans(
        document,
        generations,
        crate::services::InstallStage::Runtime,
    )?;
    let mut graph = compile_with_plans(document, generations, version, &service_plans)?;
    // Readiness follows gateway reconciliation, including restart or replacement.
    // Keeping it in this stage allows recovery before OpenShell resource refresh.
    let readiness = &mut graph["data"]["nemoclaw_gateway_capabilities"]["current"];
    readiness["wait_timeout_seconds"] = json!(90);
    readiness["lifecycle"] = json!({"postcondition":[{
        "condition":"${self.compatible}",
        "error_message":"Gateway version or compute driver does not satisfy the configuration."
    }]});
    if document.spec.gateway.management == "managed" {
        readiness["depends_on"] = json!(["nemoclaw_managed_gateway.runtime"]);
    }
    graph["resource"] = json!({});
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
    let (mut graph, targets) = runtime_graph(document, generations, version)?;
    crate::docker_compute::configure(&mut graph, &targets)?;
    Ok(graph)
}
