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
    if !document.has_runtime() {
        return Ok(Vec::new());
    }
    let gateway = Spec {
        layout: 2,
        kind: GATEWAY_KIND.into(),
        name: format!("{}-gateway", document.workspace()),
        owner: document.metadata.uid.clone(),
        generation: generation(generations, GATEWAY_KIND)?.into(),
        gateway: document.spec.gateway.runtime_settings(),
        service: None,
    };
    let mut storage = gateway.clone();
    storage.layout = 0;
    let target = |kind: &str, spec: String| Target {
        kind: kind.into(),
        address: format!("nemoclaw_{kind}.runtime"),
        values: Row::from([("spec".into(), spec)]),
    };
    let mut result = if document.spec.gateway.management == "managed" {
        vec![
            target(GATEWAY_STORAGE_KIND, storage.json()?),
            target(GATEWAY_KIND, gateway.json()?),
        ]
    } else {
        Vec::new()
    };
    for provider in document.selected_inference_providers()? {
        let Some(service) = provider.service.as_ref() else {
            continue;
        };
        let key = document.provider_key(provider);
        let spec = Spec {
            layout: 0,
            kind: SERVICE_KIND.into(),
            name: format!("{}-inference-{key}", document.workspace()),
            owner: document.metadata.uid.clone(),
            generation: generation(generations, SERVICE_KIND)?.into(),
            gateway: if service.placement.is_some() {
                Default::default()
            } else {
                document.spec.gateway.runtime_settings()
            },
            service: Some(service.runtime_settings()),
        };
        let storage = Storage {
            name: format!("{}-data", spec.name),
            owner: spec.owner.clone(),
            generation: spec.generation.clone(),
            engine: spec.engine().to_owned(),
        };
        for (kind, spec) in [
            (STORAGE_KIND, storage.json()?),
            (SERVICE_KIND, spec.json()?),
        ] {
            result.push(Target {
                kind: kind.into(),
                address: format!("nemoclaw_{kind}.inference_{key}"),
                values: Row::from([("spec".into(), spec)]),
            });
        }
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
        let mut attrs =
            json!({"spec":target.values["spec"].replace("${", "$${").replace("%{", "%%{")});
        match target.kind.as_str() {
            GATEWAY_STORAGE_KIND | STORAGE_KIND => {
                attrs["lifecycle"] = json!({"prevent_destroy":true})
            }
            GATEWAY_KIND => attrs["depends_on"] = json!(["nemoclaw_gateway_storage.runtime"]),
            SERVICE_KIND => {
                let spec: Spec = serde_json::from_str(&target.values["spec"])
                    .map_err(|_| Error::State("invalid compiled runtime"))?;
                let logical = target.address.split_once('.').unwrap().1;
                let mut dependencies = vec![format!("nemoclaw_inference_storage.{logical}")];
                if document.spec.gateway.management == "managed"
                    && spec.service.as_ref().is_some_and(|s| s.placement.is_none())
                {
                    dependencies.insert(0, "nemoclaw_managed_gateway.runtime".into());
                }
                attrs["depends_on"] = json!(dependencies);
            }
            _ => unreachable!(),
        }
        let (kind, logical) = target.address.split_once('.').unwrap();
        graph["resource"][kind][logical] = attrs;
    }
    Ok(graph)
}
