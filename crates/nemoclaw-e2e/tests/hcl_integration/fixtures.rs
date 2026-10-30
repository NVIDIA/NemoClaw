// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! The fixtures every scenario runs against, reset between scenarios: the
//! OpenShell gRPC fixture, a fake Docker engine, an inference upstream that
//! answers nothing, and the control endpoint of the `fixture` provider. A
//! scenario declares what the engine and gateway report, and reads what they
//! recorded.

use crate::docker_engine::{self, DATA_ROOT};
use nemoclaw_e2e::{http_fixture, openshell};
use nemoclaw_sdk::config::{Document, Gateway};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    path::PathBuf,
    sync::{Arc, Mutex, OnceLock},
};

#[derive(Default)]
pub struct Shared {
    pub gateway: Arc<Mutex<openshell::State>>,
    gateway_endpoint: String,
    pub engine: Mutex<docker_engine::Engine>,
    engine_endpoint: String,
    engine_requests: Mutex<Vec<String>>,
    /// The images and containers a case declares.
    images: Mutex<Vec<Value>>,
    containers: Mutex<Vec<Value>>,
    upstream_endpoint: OnceLock<String>,
    upstream_requests: Mutex<Vec<String>>,
    /// Fixture credential values by environment variable.
    credentials: Mutex<BTreeMap<String, String>>,
}

impl Shared {
    pub fn redact(&self, mut text: String) -> String {
        for value in self.credentials.lock().unwrap().values() {
            text = text.replace(value, "[REDACTED]");
        }
        text
    }

    /// A declared container, by ID as a mocked Docker resource reports it, or
    /// by name when it sets `by_name`. The managed gateway leaves `by_name`
    /// unset: storage setup must not find it before Docker would create it.
    fn container(&self, reference: &str) -> Option<Value> {
        self.containers
            .lock()
            .unwrap()
            .iter()
            .find(|container| {
                container["id"] == reference
                    || (container["by_name"] == true && container["name"] == reference)
            })
            .cloned()
    }

    /// Declared images and containers, then the engine's identity, then the
    /// stateful engine. Unrecognized requests are recorded as UNEXPECTED.
    fn engine_reply(&self, request: &http_fixture::Request) -> http_fixture::Reply {
        let target = format!("{} {}", request.method, request.path);
        self.engine_requests.lock().unwrap().push(target);
        let url = url::Url::parse(&format!("http://engine{}", request.path)).unwrap();
        let path = url.path().replace("%40", "@").replace("%3A", ":");
        let file = url
            .query_pairs()
            .find(|(key, _)| key == "path")
            .map(|(_, path)| path.into_owned());
        let json = |value: Value| (200, Vec::new(), value.to_string().into_bytes());
        let missing = || (404, Vec::new(), br#"{"message":"missing"}"#.to_vec());
        let read = matches!(request.method.as_str(), "GET" | "HEAD");
        if let Some(name) = path
            .strip_prefix("/images/")
            .and_then(|rest| rest.strip_suffix("/json"))
        {
            let images = self.images.lock().unwrap();
            let image = images
                .iter()
                .find(|image| image["reference"] == name || image["id"] == name);
            return image.map_or_else(missing, |image| json(image_inspect(image)));
        }
        let segments: Vec<&str> = path.trim_start_matches('/').split('/').collect();
        match (read, segments.as_slice()) {
            // Running declared containers, as a port-conflict check lists them.
            (true, ["containers", "json"]) => {
                let containers = self.containers.lock().unwrap();
                let listed: Vec<Value> = containers
                    .iter()
                    .filter(|container| container["running"] != false)
                    .map(|container| {
                        json!({"Id": container["id"], "Names": [format!("/{}", container["name"].as_str().unwrap_or_default())],
                            "Labels": container["labels"], "Ports": []})
                    })
                    .collect();
                return json(json!(listed));
            }
            (true, ["_ping"]) => return (200, Vec::new(), b"OK".to_vec()),
            (true, ["info"]) => {
                return json(json!({"ID":"engine", "DockerRootDir":DATA_ROOT,
                    "Architecture":"arm64", "OSType":"linux", "ServerVersion":"28.0"}));
            }
            (true, ["version"]) => {
                return json(
                    json!({"ApiVersion":"1.47", "Version":"28.0", "Os":"linux", "Arch":"arm64"}),
                );
            }
            (true, ["containers", reference, operation]) => {
                if let Some(container) = self.container(reference) {
                    let content = file
                        .as_ref()
                        .and_then(|file| container["files"][file].as_str());
                    let name = file
                        .as_deref()
                        .unwrap_or_default()
                        .rsplit('/')
                        .next()
                        .unwrap_or_default();
                    return match (request.method.as_str(), *operation, content) {
                        (_, "json", _) => json(container_inspect(&container)),
                        // Docker reports a file's metadata in a header.
                        ("HEAD", "archive", Some(content)) => {
                            use base64::Engine as _;
                            let stat = json!({"name":name, "size":content.len(), "mode":0o600,
                                "mtime":"2026-01-01T00:00:00Z", "linkTarget":""});
                            let header =
                                base64::engine::general_purpose::STANDARD.encode(stat.to_string());
                            (
                                200,
                                vec![("X-Docker-Container-Path-Stat".into(), header)],
                                Vec::new(),
                            )
                        }
                        ("GET", "archive", Some(content)) => (
                            200,
                            Vec::new(),
                            docker_engine::tar_entry(name, content.as_bytes()),
                        ),
                        _ => missing(),
                    };
                }
            }
            _ => {}
        }
        let mut engine = self.engine.lock().unwrap();
        let handled = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            docker_engine::handle(&mut engine, &request.method, &request.path, &request.body)
        }));
        match handled {
            Ok((status, body)) => (status, Vec::new(), body),
            Err(_) => {
                engine
                    .mutations
                    .push(format!("UNEXPECTED {} {}", request.method, request.path));
                (500, Vec::new(), Vec::new())
            }
        }
    }

    /// Apply a case's declaration, if any, and return the observations.
    fn control_reply(&self, request: &http_fixture::Request) -> (u16, Vec<u8>) {
        let Ok(declared) = serde_json::from_slice::<Value>(&request.body) else {
            return (400, b"declare must be JSON".to_vec());
        };
        if !declared.is_null() {
            let list = |key: &str| declared[key].as_array().cloned().unwrap_or_default();
            *self.images.lock().unwrap() = list("images");
            *self.containers.lock().unwrap() = list("containers");
            self.gateway.lock().unwrap().driver =
                declared["compute_driver"].as_str().map(str::to_owned);
            match declared["fault"].as_str() {
                None => {}
                // Agent runtimes exit inside sandboxes that keep running.
                Some("stop_agent_runtimes") => self.gateway.lock().unwrap().fabric_runtimes.clear(),
                // Registrations disappear; their profiles survive.
                Some("delete_provider_registrations") => {
                    self.gateway.lock().unwrap().providers.clear()
                }
                Some(_) => return (400, b"unknown fault".to_vec()),
            }
        }
        (
            200,
            self.redact(self.observations().to_string()).into_bytes(),
        )
    }

    /// Facts the fixtures recorded. A credential value is reported only by its
    /// source: `env:NAME`, or `file:CONTAINER:PATH` for a declared file.
    pub fn observations(&self) -> Value {
        let containers = self.containers.lock().unwrap().clone();
        let credentials = self.credentials.lock().unwrap().clone();
        let source = |value: &String| {
            let file = containers.iter().find_map(|container| {
                let (path, _) = container["files"]
                    .as_object()?
                    .iter()
                    .find(|(_, content)| *content == value)?;
                Some(format!("file:{}:{path}", container["name"].as_str()?))
            });
            credentials
                .iter()
                .find(|(_, supplied)| *supplied == value)
                .map(|(name, _)| format!("env:{name}"))
                .or(file)
                .unwrap_or_else(|| "unrecognized".into())
        };
        let state = self.gateway.lock().unwrap();
        let providers: Vec<Value> = state.created_providers.iter().map(|provider| {
            let meta = provider.metadata.clone().unwrap_or_default();
            json!({"name": meta.name, "workspace": meta.workspace, "labels": meta.labels,
                "config": provider.config,
                "credentials": provider.credentials.iter()
                    .map(|(name, value)| (name.clone(), source(value))).collect::<BTreeMap<_, _>>()})
        }).collect();
        let sandboxes: Vec<Value> = state.created_sandboxes.iter().map(|sandbox| {
            let meta = sandbox.metadata.clone().unwrap_or_default();
            let spec = sandbox.spec.clone().unwrap_or_default();
            let endpoints: Vec<String> = spec.policy.iter()
                .flat_map(|policy| policy.network_policies.values())
                .flat_map(|rule| &rule.endpoints)
                .map(|endpoint| format!("{}:{}{}", endpoint.host, endpoint.port, endpoint.path))
                .collect();
            json!({"id": meta.id, "name": meta.name, "workspace": meta.workspace, "labels": meta.labels,
                "providers": spec.providers, "command": spec.command, "policy_endpoints": endpoints})
        }).collect();
        let execs: Vec<Value> = state.exec_calls.iter().zip(&state.exec_sandboxes).zip(&state.exec_stdin)
            .map(|((command, sandbox), stdin)| {
                json!({"sandbox": sandbox, "command": command, "stdin": String::from_utf8_lossy(stdin)})
            })
            .collect();
        let rpcs: Vec<&str> = state
            .rpcs
            .iter()
            .map(|rpc| rpc.trim_start_matches("/openshell.v1.OpenShell/"))
            .collect();
        let mut current: Vec<&str> = state
            .sandboxes
            .values()
            .filter_map(|sandbox| Some(sandbox.metadata.as_ref()?.name.as_str()))
            .collect();
        current.sort_unstable();
        let mut registrations: Vec<&str> = state
            .providers
            .values()
            .filter_map(|provider| Some(provider.metadata.as_ref()?.name.as_str()))
            .collect();
        registrations.sort_unstable();
        let mut profiles: Vec<&String> = state.profiles.keys().collect();
        profiles.sort_unstable();
        json!({
            "openshell": {
                "endpoint": self.gateway_endpoint, "rpcs": rpcs,
                "created_providers": providers, "created_sandboxes": sandboxes, "execs": execs,
                "sandboxes": current, "providers": registrations, "profiles": profiles,
                "effects": state.effects,
                "fabric_starts": state.fabric_starts,
                "workspaces": state.workspaces.keys().collect::<Vec<_>>(),
            },
            "engine": {
                "endpoint": self.engine_endpoint,
                "requests": *self.engine_requests.lock().unwrap(),
                "volumes": self.engine.lock().unwrap().volumes.keys().collect::<Vec<_>>(),
            },
            "http": {
                "endpoint": self.upstream_endpoint.get(),
                "requests": *self.upstream_requests.lock().unwrap(),
            },
        })
    }
}

/// Docker's inspection of a declared image; `fabric_catalog` adds the
/// fixture's Fabric catalog label.
fn image_inspect(image: &Value) -> Value {
    let reference = image["reference"].as_str().unwrap_or_default();
    let mut labels = image["labels"].as_object().cloned().unwrap_or_default();
    if image["fabric_catalog"] == true {
        let catalog = serde_json::to_string(&nemoclaw_e2e::image_runtime::catalog()).unwrap();
        labels.insert(
            nemoclaw_sdk::fabric_catalog::IMAGE_CATALOG_LABEL.into(),
            json!(catalog),
        );
    }
    let digest = reference.contains('@');
    let architecture = image["architecture"].as_str().unwrap_or("arm64");
    json!({"Id": image["id"], "Architecture": architecture, "Os": "linux",
        "RepoDigests": if digest { vec![reference] } else { vec![] },
        "RepoTags": if digest { vec![] } else { vec![reference] },
        "Config": {"Labels": labels}})
}

/// Docker's inspection of a declared container, with its volume `mounts` by
/// destination.
fn container_inspect(container: &Value) -> Value {
    let running = container["running"] != false;
    let mounts: Vec<Value> = container["mounts"].as_object().into_iter().flatten()
        .map(|(destination, volume)| json!({"Type":"volume", "Name":volume, "Destination":destination}))
        .collect();
    json!({"Id": container["id"], "Name": format!("/{}", container["name"].as_str().unwrap_or_default()),
        "Image": container["image"], "Mounts": mounts,
        "Config": {"Image": container["image"], "Labels": container["labels"]},
        "State": {"Status": if running { "running" } else { "exited" }, "Running": running, "ExitCode": 0,
            "StartedAt": container.get("started_at").cloned().unwrap_or(json!("2026-01-01T00:00:00Z"))}})
}

/// The running fixtures of one case; they stop when this drops, also on panic.
pub struct Fixtures {
    pub shared: Arc<Shared>,
    pub control: String,
    _servers: (
        openshell::Fixture,
        http_fixture::Fixture,
        http_fixture::Fixture,
        http_fixture::Fixture,
    ),
    socket: PathBuf,
}

impl Drop for Fixtures {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.socket);
    }
}

impl Fixtures {
    /// One fixed engine socket gives every scenario the same Docker provider
    /// alias and image addresses, which test files name.
    pub async fn start() -> Self {
        let socket = PathBuf::from("/tmp/nemoclaw-integration/engine.sock");
        std::fs::create_dir_all(socket.parent().unwrap()).unwrap();
        assert!(
            std::os::unix::net::UnixStream::connect(&socket).is_err(),
            "another integration run is active"
        );
        let _ = std::fs::remove_file(&socket);
        let gateway = openshell::Fixture::start().await;
        let shared = Arc::new(Shared {
            gateway: gateway.state.clone(),
            gateway_endpoint: gateway.endpoint.clone(),
            engine_endpoint: format!("unix://{}", socket.display()),
            ..Default::default()
        });
        let serving = shared.clone();
        let engine = http_fixture::Fixture::start_at_with_headers(&socket, move |request| {
            Some(serving.engine_reply(&request))
        })
        .await;
        let serving = shared.clone();
        let upstream = http_fixture::Fixture::start_tcp(move |request| {
            let target = format!("{} {}", request.method, request.path);
            serving.upstream_requests.lock().unwrap().push(target);
            Some((404, Vec::new()))
        })
        .await;
        shared
            .upstream_endpoint
            .set(upstream.endpoint.clone())
            .unwrap();
        let serving = shared.clone();
        let control =
            http_fixture::Fixture::start_tcp(move |request| Some(serving.control_reply(&request)))
                .await;
        Self {
            control: control.endpoint.clone(),
            shared,
            _servers: (gateway, engine, upstream, control),
            socket,
        }
    }

    /// Point the gateway, any engine it names, and inference providers with an
    /// endpoint at the fixtures, keeping inference paths. An external gateway
    /// loses its credential and TLS: the fixture serves plaintext gRPC.
    pub fn redirect(&self, document: &mut Document) {
        let shared = &self.shared;
        *document.spec.gateway.endpoint_mut() = shared.gateway_endpoint.clone();
        let engine = match &mut document.spec.gateway {
            Gateway::External(gateway) => {
                gateway.credential = None;
                gateway.tls = None;
                Some(&mut gateway.engine)
            }
            gateway => gateway.as_managed_mut().map(|managed| &mut managed.engine),
        };
        if let Some(engine) = engine.filter(|engine| !engine.is_empty()) {
            engine.clone_from(&shared.engine_endpoint);
        }
        let upstream = shared.upstream_endpoint.get().unwrap();
        for provider in document.spec.inference_providers.values_mut() {
            if !provider.endpoint.is_empty() {
                let path = url::Url::parse(&provider.endpoint)
                    .unwrap()
                    .path()
                    .trim_end_matches('/')
                    .to_owned();
                provider.endpoint = format!("{upstream}{path}");
            }
        }
    }

    /// Clear every fixture for the next scenario, which supplies these credentials.
    pub fn reset(&self, credentials: BTreeMap<String, String>) {
        let shared = &self.shared;
        *shared.gateway.lock().unwrap() = openshell::State::default();
        *shared.engine.lock().unwrap() = docker_engine::Engine::default();
        shared.engine_requests.lock().unwrap().clear();
        shared.images.lock().unwrap().clear();
        shared.containers.lock().unwrap().clear();
        shared.upstream_requests.lock().unwrap().clear();
        *shared.credentials.lock().unwrap() = credentials;
    }

    /// What OpenTofu's teardown left that it must not: gateway objects or
    /// Fabric runtimes, deleted engine storage, or unrecognized engine requests.
    pub fn teardown_problem(&self) -> Option<String> {
        let state = self.shared.gateway.lock().unwrap();
        if !(state.sandboxes.is_empty()
            && state.providers.is_empty()
            && state.profiles.is_empty()
            && state.workspaces.is_empty()
            && state.fabric_runtimes.is_empty())
        {
            return Some("teardown left gateway objects or Fabric runtimes".into());
        }
        let mutations = &self.shared.engine.lock().unwrap().mutations;
        mutations
            .iter()
            .any(|m| m.starts_with("UNEXPECTED") || m.starts_with("DELETE /volumes"))
            .then(|| format!("unexpected or storage-deleting engine requests: {mutations:?}"))
    }
}
