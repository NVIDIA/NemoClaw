// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use super::*;
use crate::{
    Error,
    managed::{GATEWAY_KIND, GATEWAY_STORAGE_KIND, Spec},
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
        compute_driver: document.spec.sandboxes[0].runtime.provider.clone(),
        kind: GATEWAY_KIND.into(),
        name: format!("{}-gateway", document.workspace()),
        owner: document.metadata.uid.clone(),
        generation: generation(generations, GATEWAY_KIND)?.into(),
        gateway: document.spec.gateway.runtime_settings(),
        process: None,
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
    result.extend(crate::services::runtime_targets(document, generations)?);
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
        if target.kind == GATEWAY_STORAGE_KIND
            || crate::services::resource_behavior(&target.kind).retained_storage
        {
            attrs["lifecycle"] = json!({"prevent_destroy":true});
        }
        if target.kind == GATEWAY_KIND {
            attrs["depends_on"] = json!(["nemoclaw_gateway_storage.runtime"]);
        }
        if let Some(dependencies) = crate::services::dependencies(
            document,
            generations,
            crate::services::InstallStage::Runtime,
            &target.address,
        )? {
            attrs["depends_on"] = json!(dependencies);
        }
        let (kind, logical) = target.address.split_once('.').unwrap();
        graph["resource"][kind][logical] = attrs;
    }
    Ok(graph)
}
