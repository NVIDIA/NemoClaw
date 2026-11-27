// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Managed model services on Docker Desktop (#14903).
//!
//! Docker Desktop also opens each published port on macOS or Windows, which
//! have no address on the engine's bridges, so a managed service published on
//! its bridge address never starts there. Plan asks the engine once whether
//! it is Docker Desktop and keeps the answer for the deployment's lifetime.

#![cfg(unix)]

use crate::scripted_tofu::{Scripted, placeholder_generations, plan_json};
use nemoclaw_sdk::{
    CancellationToken, EngineProbe,
    compile::{self, Target},
    config::Document,
};
use serde_json::Value;
use std::sync::{Arc, Mutex};

/// An engine probe whose answer a test sets, and the engines it was asked about.
#[derive(Default)]
struct Probe {
    answer: Mutex<Option<bool>>,
    asked: Mutex<Vec<String>>,
}

impl EngineProbe for Probe {
    fn docker_desktop<'a>(
        &'a self,
        engine: &'a str,
    ) -> futures_util::future::BoxFuture<'a, Option<bool>> {
        self.asked.lock().unwrap().push(engine.to_owned());
        let answer = *self.answer.lock().unwrap();
        Box::pin(async move { answer })
    }
}

fn document() -> Document {
    Document::parse(include_str!("fixtures/config/spark.yaml").as_bytes()).unwrap()
}

/// A scripted OpenTofu whose plan creates every resource of `document`,
/// including the Docker objects only its graph declares.
fn fresh(document: &Document) -> Scripted {
    let scripted = Scripted::new();
    let mut generations = placeholder_generations();
    generations.insert("inference_service".into(), "a".repeat(32));
    let mut targets: Vec<Target> = compile::runtime_targets(document, &generations)
        .unwrap()
        .into_iter()
        .chain(compile::targets(document, &generations).unwrap())
        .filter(|target| !target.address.starts_with("data."))
        .collect();
    let graph = compile::compile(document, &generations, "0.1.0").unwrap();
    for (kind, resources) in graph["resource"].as_object().unwrap() {
        for (name, attributes) in resources.as_object().unwrap() {
            let address = format!("{kind}.{name}");
            if !targets.iter().any(|target| target.address == address) {
                let values = attributes
                    .as_object()
                    .unwrap()
                    .iter()
                    .filter_map(|(key, value)| Some((key.clone(), value.as_str()?.to_owned())))
                    .collect();
                targets.push(Target {
                    kind: kind.clone(),
                    address,
                    values,
                });
            }
        }
    }
    scripted.set("root.apply.plan", plan_json(&targets, "create"));
    scripted
}

/// The host addresses the compiled graph publishes the model's port on.
fn published(scripted: &Scripted) -> Vec<String> {
    let graph: Value =
        serde_json::from_slice(&std::fs::read(scripted.state().join("main.tf.json")).unwrap())
            .unwrap();
    graph["resource"]["docker_container"]
        .as_object()
        .unwrap()
        .values()
        .flat_map(|container| container["ports"].as_array().cloned().unwrap_or_default())
        .filter(|port| port["internal"] == 18888)
        .map(|port| port["ip"].as_str().unwrap().to_owned())
        .collect()
}

#[tokio::test]
async fn plan_publishes_managed_models_on_loopback_on_docker_desktop_for_the_deployment_lifetime() {
    let document = document();
    let scripted = fresh(&document);
    let probe = Arc::new(Probe::default());
    *probe.answer.lock().unwrap() = Some(true);
    let deployment = scripted
        .deployment(&scripted.path("kubeconfig"))
        .with_engine_probe(probe.clone());

    deployment
        .plan(&document, &CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(published(&scripted), ["127.0.0.1"]);
    assert_eq!(
        *probe.asked.lock().unwrap(),
        ["unix:///var/run/docker.sock"]
    );

    // A later answer, or none, doesn't move an established deployment's model.
    *probe.answer.lock().unwrap() = None;
    deployment
        .plan(&document, &CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(published(&scripted), ["127.0.0.1"]);
    assert_eq!(probe.asked.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn plan_keeps_the_bridge_address_on_other_engines_and_asks_again_when_unanswered() {
    let document = document();
    let scripted = fresh(&document);
    let probe = Arc::new(Probe::default());
    let deployment = scripted
        .deployment(&scripted.path("kubeconfig"))
        .with_engine_probe(probe.clone());

    // An engine that can't be read leaves the bridge address and no record of it.
    deployment
        .plan(&document, &CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(published(&scripted), ["172.30.110.1"]);
    *probe.answer.lock().unwrap() = Some(false);
    deployment
        .plan(&document, &CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(published(&scripted), ["172.30.110.1"]);
    assert_eq!(probe.asked.lock().unwrap().len(), 2);
}
