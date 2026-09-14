// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use super::*;
use crate::{
    Error,
    managed::{GATEWAY_KIND, GATEWAY_STORAGE_KIND, SERVICE_KIND, STORAGE_KIND, Spec, Storage},
};
pub fn runtime_targets(
    document: &Document,
    generations: &Generations,
) -> Result<Vec<Target>, Error> {
    document.validate()?;
    if document.spec.gateway.management != "managed" {
        return Ok(Vec::new());
    }
    let gateway = Spec {
        layout: 2,
        kind: GATEWAY_KIND.into(),
        name: format!("{}-gateway", document.workspace()),
        owner: document.metadata.uid.clone(),
        generation: generation(generations, GATEWAY_KIND)?.into(),
        gateway: document.spec.gateway.clone(),
        service: None,
    };
    let mut storage = gateway.clone();
    storage.layout = 0;
    let target = |kind: &str, spec: String| Target {
        kind: kind.into(),
        address: format!("nemoclaw_{kind}.runtime"),
        values: Row::from([("spec".into(), spec)]),
    };
    let mut result = vec![
        target(GATEWAY_STORAGE_KIND, storage.json()?),
        target(GATEWAY_KIND, gateway.json()?),
    ];
    if let Some(service) = document.spec.inference_providers[0].service.as_ref() {
        let spec = Spec {
            layout: 0,
            kind: SERVICE_KIND.into(),
            name: format!("{}-inference", document.workspace()),
            owner: document.metadata.uid.clone(),
            generation: generation(generations, SERVICE_KIND)?.into(),
            gateway: document.spec.gateway.clone(),
            service: Some(service.clone()),
        };
        let storage = Storage {
            name: format!("{}-inference-data", document.workspace()),
            owner: spec.owner.clone(),
            generation: spec.generation.clone(),
            engine: spec.gateway.engine.clone(),
        };
        result.push(target(STORAGE_KIND, storage.json()?));
        result.push(target(SERVICE_KIND, spec.json()?));
    }
    Ok(result)
}
pub fn compile_runtime(
    document: &Document,
    generations: &Generations,
    version: &str,
) -> Result<Value, Error> {
    let mut graph = compile(document, generations, version)?;
    graph["resource"] = json!({});
    for target in runtime_targets(document, generations)? {
        let mut attrs = json!({"spec":target.values["spec"]});
        match target.kind.as_str() {
            GATEWAY_STORAGE_KIND | STORAGE_KIND => {
                attrs["lifecycle"] = json!({"prevent_destroy":true})
            }
            GATEWAY_KIND => attrs["depends_on"] = json!(["nemoclaw_gateway_storage.runtime"]),
            SERVICE_KIND => {
                attrs["depends_on"] = json!([
                    "nemoclaw_managed_gateway.runtime",
                    "nemoclaw_inference_storage.runtime"
                ])
            }
            _ => unreachable!(),
        }
        graph["resource"][format!("nemoclaw_{}", target.kind)]["runtime"] = attrs;
    }
    Ok(graph)
}
