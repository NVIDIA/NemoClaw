// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! The application-container example and the `kind: container` boundary in
//! internal-docs/design/container-contract.md: the example's literal connection
//! settings name its own deployment, options outside the contract are refused,
//! and export and reapply keep the authored service.

use nemoclaw_sdk::{
    compile::{Generations, compile},
    config::{Document, schema::input_schema},
};
use serde_json::{Value, json};

const EXAMPLE: &str = "application-container.yaml";

fn example() -> Value {
    crate::support::example(EXAMPLE)
}

fn parse(value: &Value) -> Result<Document, nemoclaw_sdk::config::ConfigError> {
    Document::parse(value.to_string().as_bytes())
}

fn generations() -> Generations {
    [
        "workspace",
        "provider",
        "sandbox",
        "managed_gateway",
        "container_service",
    ]
    .map(|kind| (kind.into(), "a".repeat(32)))
    .into()
}

/// The contract gives the application its connection only through literal
/// environment values the operator copies from the deployment. The example's
/// values must name this document's workspace, sandbox, agent, and gateway,
/// or an operator who copies it connects to nothing.
#[test]
fn the_example_application_names_its_own_workspace_sandbox_agent_and_gateway() {
    let document = parse(&example()).unwrap();
    let value = example();
    let service = &value["spec"]["services"]["application"];
    assert_eq!(service["kind"], "container");
    let environment = &service["environment"];
    assert_eq!(environment["APP_WORKSPACE"], json!(document.workspace()));
    let sandbox = environment["APP_SANDBOX_NAME"].as_str().unwrap();
    assert_eq!(
        environment["APP_AGENT_NAME"], value["spec"]["sandboxes"][sandbox]["agent"]["name"],
        "the agent must run in the named sandbox"
    );
    // The managed gateway listens on its endpoint's port at host 2 of its network.
    let gateway = &value["spec"]["gateway"];
    let port = url::Url::parse(gateway["endpoint"].as_str().unwrap())
        .unwrap()
        .port()
        .unwrap();
    let network = gateway["networkCIDR"].as_str().unwrap();
    let host = network
        .split('/')
        .next()
        .unwrap()
        .rsplit_once('.')
        .unwrap()
        .0;
    assert_eq!(
        environment["APP_GATEWAY_URL"],
        json!(format!("http://{host}.2:{port}"))
    );
    assert_eq!(
        environment["APP_PORT"],
        json!(service["publication"]["port"].to_string())
    );

    // The settings reach the container unchanged, and readiness probes the
    // published listener.
    let graph = compile(&document, &generations(), "0.1.0").unwrap();
    let container = &graph["resource"]["docker_container"]["container_service_application"];
    for (name, setting) in environment.as_object().unwrap() {
        let entry = json!(format!("{name}={}", setting.as_str().unwrap()));
        assert!(
            container["env"].as_array().unwrap().contains(&entry),
            "{entry} missing from {}",
            container["env"]
        );
    }
    assert_eq!(
        graph["data"]["host_container_health"]["container_service_application"]["http_url"],
        "http://127.0.0.1:18790/health"
    );
}

/// The contract rejects environment reference objects, a generic secrets
/// field, agentConnection, generated connection descriptors, and service
/// placement apart from the managed gateway's engine.
#[test]
fn a_container_service_refuses_options_outside_the_contract() {
    for (field, setting) in [
        ("environment", json!({"APP_KEY": {"env": "APP_KEY"}})),
        ("environment", json!({"APP_KEY": {"from": "gateway"}})),
        ("secrets", json!({"APP_KEY": {"env": "APP_KEY"}})),
        (
            "agentConnection",
            json!({"sandbox": "assistant", "agent": "main"}),
        ),
        (
            "connection",
            json!({"path": "/run/nemoclaw/agent-connection.json"}),
        ),
        (
            "placement",
            json!({"engine": "ssh://gpu-box", "networkCIDR": "172.30.119.0/24"}),
        ),
        ("imagePullPolicy", json!("Always")),
        (
            "files",
            json!({"/run/nemoclaw/agent-connection.json": "{}"}),
        ),
        // Optional settings are omitted, not null, so authoring tools offer
        // them as their own types rather than as arbitrary JSON.
        ("command", Value::Null),
        ("readiness", json!({"path": null})),
        ("readiness", json!({"runtimeStatus": null})),
    ] {
        let mut value = example();
        value["spec"]["services"]["application"][field] = setting;
        assert!(parse(&value).is_err(), "accepted {field}: {value}");
        if field != "files" {
            let validator = jsonschema::validator_for(&input_schema()).unwrap();
            assert!(!validator.is_valid(&value), "the schema accepts {field}");
        }
    }
}

/// The initial placement is the managed local Docker gateway's engine and
/// network; another gateway does not imply application support.
#[test]
fn a_container_service_requires_a_managed_local_docker_gateway() {
    for gateway in [
        json!({"management": "external", "runtime": {"provider": "docker"},
            "endpoint": "http://127.0.0.1:17671"}),
        json!({"management": "managed", "runtime": {"provider": "podman"},
            "engine": "unix:///run/user/1000/podman/podman.sock",
            "endpoint": "http://127.0.0.1:17681"}),
        json!({"management": "managed", "runtime": {"provider": "kubernetes"},
            "endpoint": "https://127.0.0.1:17671",
            "kubernetes": {"kubeconfig": {"env": "TEST_KUBECONFIG"}, "context": "test-cluster",
                "namespace": "nemoclaw", "authentication": {"profile": "development"}}}),
    ] {
        let mut value = example();
        if gateway["runtime"]["provider"] == "kubernetes" {
            value["spec"]["sandboxes"]["assistant"]["image"] = json!({
                "ref": format!("fixture/assistant@sha256:{}", "a".repeat(64)),
                "metadata": {"env": "TEST_IMAGE_METADATA"}
            });
        }
        value["spec"]["gateway"] = gateway.clone();
        let mut without = value.clone();
        without["spec"]["services"]
            .as_object_mut()
            .unwrap()
            .remove("application");
        if let Err(error) = parse(&without) {
            panic!("the gateway itself must be valid: {gateway}: {error}");
        }
        assert!(parse(&value).is_err(), "accepted beside {gateway}");
    }
}

#[cfg(unix)]
mod export {
    use super::*;
    use crate::scripted_tofu::{Scripted, placeholder_generations, plan_json, state_json};
    use nemoclaw_sdk::{
        CancellationToken, Error, ObservationError, Outcome,
        compile::{self, Target},
    };

    /// The example with every authored container input: arguments, files,
    /// limits, environment, readiness, and publication.
    fn document() -> Document {
        let mut value = example();
        let service = &mut value["spec"]["services"]["application"];
        service["command"] = json!(["--config", "/etc/application/settings.yaml"]);
        service["files"] = json!({"/etc/application/settings.yaml": "listen: 18790\n"});
        service["container"] = json!({"cpuLimitMillis": 2000, "memoryLimitGiB": 2});
        service["data"] = json!({"mountPath": "/var/lib/application"});
        parse(&value).unwrap()
    }

    /// The managed resources the deployment declares. Compiled targets omit
    /// the Docker objects the graph alone declares; those are bound with the
    /// graph's string attributes, such as the container's name.
    fn targets(document: &Document, generations: &Generations) -> Vec<Target> {
        let mut targets: Vec<Target> = compile::runtime_targets(document, generations)
            .unwrap()
            .into_iter()
            .chain(compile::targets(document, generations).unwrap())
            .filter(|target| !target.address.starts_with("data."))
            .collect();
        let graph = compile::compile(document, generations, "0.1.0").unwrap();
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
        targets
    }

    /// What OpenTofu holds for each binding, in its provider's shape, as
    /// `show -json` reports it under `values`.
    fn provider_state(targets: &[Target]) -> Value {
        let mut state: Value = serde_json::from_str(&state_json(targets)).unwrap();
        for (resource, target) in state["values"]["root_module"]["resources"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .zip(targets)
        {
            assert_eq!(resource["address"], json!(target.address));
            provider_shape(target, &mut resource["values"]);
        }
        state["values"].take()
    }

    /// Rewrite a bound row as its provider reports it. The Docker provider
    /// reports a container's attributes, such as its name, not the service
    /// specification its target carries. OpenShell and Fabric objects report
    /// their `ref` inputs and typed blocks, which the SDK flattens back into
    /// the row's fields.
    fn provider_shape(target: &Target, values: &mut Value) {
        if let Some(spec) = target.values.get("spec") {
            let spec: Value = serde_json::from_str(spec).unwrap();
            let object = values.as_object_mut().unwrap();
            object.remove("spec");
            object.remove("readiness");
            object.insert("name".into(), spec["name"].clone());
        }
        let resource_type = target.address.split_once('.').unwrap().0;
        let (references, inputs) = if resource_type == nemoclaw_fabric::agent::RESOURCE_TYPE {
            (
                nemoclaw_fabric::agent::references(),
                nemoclaw_fabric::agent::structured_inputs(),
            )
        } else if resource_type.starts_with("openshell_") {
            (
                nemoclaw_openshell::references(&target.kind),
                nemoclaw_openshell::structured_inputs(&target.kind),
            )
        } else {
            return;
        };
        let field = |name: &str| target.values.get(name).cloned().unwrap_or_default();
        for reference in references {
            values[reference.attribute] = if reference.list {
                let (attribute, name) = reference.fields[0];
                let names: Vec<String> = match field(name).as_str() {
                    "" => Vec::new(),
                    encoded => serde_json::from_str(encoded).unwrap(),
                };
                names
                    .into_iter()
                    .map(|item| {
                        Value::Object([(attribute.to_owned(), json!(item))].into_iter().collect())
                    })
                    .collect()
            } else {
                reference
                    .fields
                    .iter()
                    .map(|(attribute, name)| ((*attribute).to_owned(), json!(field(name))))
                    .collect::<serde_json::Map<_, _>>()
                    .into()
            };
        }
        for input in inputs {
            let encoded = field(input.field);
            if !encoded.is_empty() {
                values[input.attribute] = input.configuration(&encoded).unwrap();
            }
        }
    }

    /// Show the bindings: the state, and the refreshed export plan, whose
    /// prior state holds what the providers observed.
    fn observe(scripted: &Scripted, values: &Value) {
        scripted.set(
            "root.state",
            json!({"format_version": "1.0", "values": values}).to_string(),
        );
        scripted.set(
            "root.export.plan",
            json!({"format_version": "1.0", "prior_state": {"values": values}}).to_string(),
        );
    }

    /// Export returns the applied document with its container service, the
    /// export satisfies the generated schema, and applying it again changes
    /// nothing. A container missing from state, or no longer under the
    /// service's name, stops the export.
    #[tokio::test]
    async fn export_and_reapply_keep_the_container_service() {
        let scripted = Scripted::new();
        let deployment = scripted.deployment(&scripted.path("unused-kubeconfig"));
        let cancel = CancellationToken::new();
        let document = document();
        let mut generations = placeholder_generations();
        generations.insert("container_service".into(), "a".repeat(32));
        scripted.set(
            "root.apply.plan",
            plan_json(&targets(&document, &generations), "create"),
        );
        let created = deployment.apply(&document, &cancel).await.unwrap();
        assert_eq!(created.outcome, Outcome::Succeeded);

        let bound = targets(&document, &scripted.generations());
        assert!(
            bound
                .iter()
                .any(|target| target.kind == "container_service"),
            "the deployment declares the container service"
        );
        let observed = provider_state(&bound);
        observe(&scripted, &observed);
        let exported = deployment.export(&cancel).await.unwrap();
        assert_eq!(exported, document);
        let text = exported.yaml().unwrap();
        let value: Value = serde_saphyr::from_str(&text).unwrap();
        assert_eq!(
            value["spec"]["services"]["application"],
            serde_json::to_value(&document).unwrap()["spec"]["services"]["application"]
        );
        let validator = jsonschema::validator_for(&input_schema()).unwrap();
        assert!(
            validator.is_valid(&value),
            "{:?}",
            validator.iter_errors(&value).collect::<Vec<_>>()
        );

        let intent = scripted.intent();
        scripted.set("root.apply.plan", plan_json(&bound, "no-op"));
        let reapplied = deployment
            .apply(&Document::parse(text.as_bytes()).unwrap(), &cancel)
            .await
            .unwrap();
        assert_eq!(reapplied.outcome, Outcome::Succeeded);
        assert!(reapplied.changes.is_empty(), "{:?}", reapplied.changes);
        assert_eq!(scripted.intent(), intent);

        let mut removed = observed.clone();
        removed["root_module"]["resources"]
            .as_array_mut()
            .unwrap()
            .retain(|resource| {
                resource["address"] != "docker_container.container_service_application"
            });
        observe(&scripted, &removed);
        let refused = deployment.export(&cancel).await.unwrap_err();
        assert!(
            matches!(&refused, Error::Conflict(reason) if reason.contains("all declared resource bindings")),
            "{refused:?}"
        );

        let mut renamed = observed;
        let container = renamed["root_module"]["resources"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|resource| {
                resource["address"] == "docker_container.container_service_application"
            })
            .unwrap();
        container["values"]["name"] = json!("another-application");
        observe(&scripted, &renamed);
        let refused = deployment.export(&cancel).await.unwrap_err();
        assert!(
            matches!(
                &refused,
                Error::Observation(ObservationError::BindingMismatch)
            ),
            "{refused:?}"
        );
    }
}
