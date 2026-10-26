// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Discovery reads have no dependency on resource creation or image acquisition.
use crate::{
    config::{ConfigError, Document},
    discovery::{DiscoveryQuery, FabricRequest, GATEWAY_PREREQUISITES, plan_queries},
};
use serde_json::{Map, Value, json};

/// The data source type, the attribute holding its observation, and the
/// inputs that answer `query` in a plan. One `host_engine` read answers both
/// engine facts and advertised hardware. An image read on a platform takes it
/// from the plan's one engine read, `current`.
fn inputs(query: &DiscoveryQuery) -> Result<(&'static str, &'static str, Value), ConfigError> {
    Ok(match query {
        DiscoveryQuery::Engine(request) => (
            "host_engine",
            "engine_json",
            json!({"engine":literal(&request.engine)}),
        ),
        DiscoveryQuery::Hardware(request) => (
            "host_engine",
            "hardware_json",
            json!({"engine":literal(&request.engine)}),
        ),
        DiscoveryQuery::Fabric(FabricRequest {
            engine,
            image,
            requirements,
            platform,
            metadata_env,
        }) => {
            let mut inputs = json!({
                "engine": literal(engine),
                "image": literal(image),
                "config_json": literal(
                    &serde_json::to_string(&requirements.configuration)
                        .expect("Fabric configuration")
                ),
            });
            if let Some(paths) = &requirements.filesystem_read {
                inputs["filesystem_read"] =
                    json!(paths.iter().map(|path| literal(path)).collect::<Vec<_>>());
            }
            if let Some(metadata_env) = metadata_env {
                inputs["metadata_env"] = json!(metadata_env);
            }
            if platform.is_some() {
                for field in ["architecture", "operating_system"] {
                    inputs[field] = json!(format!(
                        "${{jsondecode(data.host_engine.current.engine_json).{field}}}"
                    ));
                }
            }
            ("fabric_harnesses", "observation_json", inputs)
        }
        DiscoveryQuery::Gateway(_)
        | DiscoveryQuery::Credential(_)
        | DiscoveryQuery::Inference(_) => {
            unreachable!(
                "a plan reads the gateway, credentials, and model catalogs outside its discovery reads"
            )
        }
    })
}

fn literal(value: &str) -> String {
    value.replace("${", "$${").replace("%{", "%%{")
}

/// Add `query`'s data source under `name` and report its observation as `key`;
/// `extend` adds what only a plan needs.
fn read(
    graph: &mut Value,
    observations: &mut Map<String, Value>,
    query: &DiscoveryQuery,
    name: &str,
    key: &str,
    extend: impl FnOnce(&mut Value),
) -> Result<(), ConfigError> {
    let (source, attribute, mut inputs) = inputs(query)?;
    extend(&mut inputs);
    graph["data"][source][name] = inputs;
    observations.insert(
        key.into(),
        json!(format!("${{data.{source}.{name}.{attribute}}}")),
    );
    Ok(())
}

/// Name of a sandbox's Fabric harness read. It follows the sandbox's name, not
/// its position, so adding or removing a sandbox leaves other sandboxes' reads
/// and the resources that use them unchanged. Sandbox names have no
/// underscores, so the prefix keeps it apart from the other reads' names.
pub(crate) fn harness_read(sandbox: &str) -> String {
    format!("sandbox_{sandbox}")
}

pub(crate) fn populate(graph: &mut Value, document: &Document) -> Result<(), ConfigError> {
    let mut observations = Map::new();
    let mut sandboxes = document.sandboxes();
    let mut targets = 0;
    for query in plan_queries(document)? {
        match &query {
            DiscoveryQuery::Gateway(_) => {
                // Reuse the existing strict gateway read rather than probing it twice.
                observations.insert(
                    "gateway".into(),
                    json!("${data.openshell_gateway.current.observation_json}"),
                );
            }
            // The SDK reads model catalogs itself; they are advisory, not graph reads.
            DiscoveryQuery::Inference(_) => {}
            DiscoveryQuery::Hardware(_) => {
                let name = format!("target_{targets}");
                read(graph, &mut observations, &query, &name, &name, |_| {})?;
                targets += 1;
            }
            DiscoveryQuery::Engine(request) => {
                read(
                    graph,
                    &mut observations,
                    &query,
                    "current",
                    "engine",
                    |_| {},
                )?;
                // The openshell provider judges whether the engine can host
                // the managed gateway; its installation types enforce the
                // same check.
                let source = crate::compile::data_source_type(GATEWAY_PREREQUISITES);
                graph["data"][&source]["current"] = json!({
                    "engine": literal(&request.engine),
                    "compute_driver": request.compute_driver,
                    "lifecycle": { "postcondition": [{
                        "condition": "${self.status != \"unavailable\"}",
                        "error_message": "The selected engine does not meet gateway prerequisites. Correct the runtime or target configuration."
                    }] },
                });
                observations.insert(
                    GATEWAY_PREREQUISITES.into(),
                    json!(format!("${{data.{source}.current.observation_json}}")),
                );
            }
            DiscoveryQuery::Fabric(FabricRequest {
                requirements,
                metadata_env,
                engine,
                ..
            }) => {
                let sandbox = sandboxes.next().expect("one image read per sandbox");
                let name = harness_read(sandbox.name);
                let adapter = requirements.configuration["harness"]["adapter_id"]
                    .as_str()
                    .expect("resolved adapter");
                let context = literal(&format!(
                    "sandbox/{}: adapter/{} compatibility rejected",
                    sandbox.name,
                    crate::fabric_capabilities::diagnostic_field(adapter)
                ));
                let rejection = format!(
                    r#"${{join("; ", concat([{}], [for check in jsondecode(self.observation_json).compatibility.checks : format("%s: %s", check.requirement, check.reason) if check.status == "unsupported"]))}}"#,
                    serde_json::to_string(&context).expect("diagnostic context"),
                );
                // As `compile::sandbox_image_pulls` selects them.
                let pulled = metadata_env.is_none()
                    && !engine.is_empty()
                    && !document.spec.gateway.runtime().provider.is_kubernetes();
                // The plan pulls this image before the reads that need its
                // label, so an engine that doesn't hold it yet passes here.
                let condition = if pulled {
                    "${self.runtime_json != \"\" || self.status == \"unavailable\"}"
                } else {
                    "${self.runtime_json != \"\"}"
                };
                read(graph, &mut observations, &query, &name, &name, |inputs| {
                    inputs["lifecycle"] = json!({ "postcondition": [{
                        "condition": "${self.compatibility_status != \"unsupported\"}",
                        "error_message": rejection
                    }, {
                        "condition": condition,
                        "error_message": if metadata_env.is_some() || document.spec.gateway.runtime().provider.is_kubernetes() {
                            format!("sandbox/{}: image runtime metadata is unavailable. Set image.metadata.env to an absolute metadata bundle path and verify that it matches the immutable image digest. Resources retained.", sandbox.name)
                        } else {
                            format!("sandbox/{}: image runtime metadata is unavailable. Set spec.gateway.engine to the sandbox image engine, and use an image built with its runtime manifest, its io.nemoclaw.fabric.catalog label, by its immutable digest; a derived image must keep its base image's labels. Resources retained.", sandbox.name)
                        }
                    }] });
                })?;
                // The harness the sandbox launches, which its agent takes by ref.
                let read = &graph["data"]["fabric_harnesses"][&name];
                let mut harness = json!({
                    "image": read["image"],
                    "adapter_id": literal(adapter),
                    "agent_name": literal(&sandbox.agent.name),
                });
                for field in ["engine", "metadata_env"] {
                    if !read[field].is_null() {
                        harness[field] = read[field].clone();
                    }
                }
                // Named by sandbox, so adding a sandbox changes no agent's ref.
                // A pulled image's harness is read after its pull instead.
                if !pulled {
                    graph["data"]["fabric_harness"][sandbox.name] = harness;
                }
            }
            DiscoveryQuery::Credential(_) => {
                unreachable!("a plan reads credentials separately from its provider reads")
            }
        }
    }
    graph["output"]["discovery"] = json!({ "value": observations });
    Ok(())
}
