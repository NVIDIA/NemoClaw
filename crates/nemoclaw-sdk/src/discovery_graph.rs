// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Discovery reads have no dependency on resource creation or image acquisition.
use crate::{
    config::{ConfigError, Document},
    discovery::{DiscoveryQuery, FabricRequest, plan_queries},
};
use serde_json::{Map, Value, json};

/// The data source and inputs that answer `query` in a plan. An image read on
/// a platform takes it from the plan's one engine read, `current`.
fn inputs(query: &DiscoveryQuery) -> Result<(&'static str, Value), ConfigError> {
    Ok(match query {
        DiscoveryQuery::Engine(request) => (
            "engine_capabilities",
            json!({"engine":literal(&request.engine),"compute_driver":request.compute_driver}),
        ),
        DiscoveryQuery::Hardware(request) => (
            "target_hardware",
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
                        "${{jsondecode(data.nemoclaw_engine_capabilities.current.observation_json).{field}}}"
                    ));
                }
            }
            ("fabric_capabilities", inputs)
        }
        DiscoveryQuery::Inference(request) => {
            request
                .validate()
                .map_err(|_| ConfigError::new("discovery inputs are invalid"))?;
            (
                "inference_capabilities",
                json!({"endpoint":literal(&request.endpoint),"api":request.api,"credential_env":request.credential_env}),
            )
        }
        DiscoveryQuery::Gateway(_) | DiscoveryQuery::Credential(_) => {
            unreachable!("a plan reads the gateway and credentials outside its discovery reads")
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
    let (kind, mut inputs) = inputs(query)?;
    extend(&mut inputs);
    // Fabric image reads belong to the fabric provider; the others to nemoclaw.
    let source = if kind == "fabric_capabilities" {
        kind.to_owned()
    } else {
        format!("nemoclaw_{kind}")
    };
    graph["data"][&source][name] = inputs;
    observations.insert(
        key.into(),
        json!(format!("${{data.{source}.{name}.observation_json}}")),
    );
    Ok(())
}

pub(crate) fn populate(graph: &mut Value, document: &Document) -> Result<(), ConfigError> {
    let mut observations = Map::new();
    let mut sandboxes: Vec<_> = document.spec.sandboxes.iter().collect();
    sandboxes.sort_by(|left, right| left.name.cmp(&right.name));
    let mut sandboxes = sandboxes.into_iter();
    let (mut endpoints, mut targets, mut images) = (0, 0, 0);
    for query in plan_queries(document)? {
        match &query {
            DiscoveryQuery::Gateway(_) => {
                // Reuse the existing strict gateway read rather than probing it twice.
                observations.insert(
                    "gateway".into(),
                    json!("${data.openshell_gateway.current.observation_json}"),
                );
            }
            DiscoveryQuery::Inference(_) => {
                let name = format!("endpoint_{endpoints}");
                read(graph, &mut observations, &query, &name, &name, |_| {})?;
                endpoints += 1;
            }
            DiscoveryQuery::Hardware(_) => {
                let name = format!("target_{targets}");
                read(graph, &mut observations, &query, &name, &name, |_| {})?;
                targets += 1;
            }
            DiscoveryQuery::Engine(_) => {
                read(
                    graph,
                    &mut observations,
                    &query,
                    "current",
                    "engine",
                    |inputs| {
                        inputs["lifecycle"] = json!({ "postcondition": [{
                        "condition": "${self.status != \"unavailable\"}",
                        "error_message": "The selected engine does not meet gateway prerequisites. Correct the runtime or target configuration."
                    }] });
                    },
                )?;
            }
            DiscoveryQuery::Fabric(FabricRequest {
                requirements,
                metadata_env,
                ..
            }) => {
                let sandbox = sandboxes.next().expect("one image read per sandbox");
                let name = format!("sandbox_{images}");
                images += 1;
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
                read(graph, &mut observations, &query, &name, &name, |inputs| {
                    inputs["lifecycle"] = json!({ "postcondition": [{
                        "condition": "${self.compatibility_status != \"unsupported\"}",
                        "error_message": rejection
                    }, {
                        "condition": "${self.runtime_json != \"\"}",
                        "error_message": if metadata_env.is_some() || document.spec.gateway.runtime().provider.is_kubernetes() {
                            format!("sandbox/{}: image runtime metadata is unavailable. Set image.metadata.env to an absolute metadata bundle path and verify that it matches the immutable image digest. Resources retained.", sandbox.name)
                        } else {
                            format!("sandbox/{}: image runtime metadata is unavailable. Set spec.gateway.engine to the sandbox image engine, load an image built with its runtime manifest, and use its immutable digest. Resources retained.", sandbox.name)
                        }
                    }] });
                })?;
            }
            DiscoveryQuery::Credential(_) => {
                unreachable!("a plan reads credentials separately from its provider reads")
            }
        }
    }
    graph["output"]["discovery"] = json!({ "value": observations });
    Ok(())
}
