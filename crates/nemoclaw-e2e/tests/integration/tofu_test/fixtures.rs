// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! The fixtures every scenario runs against, reset between scenarios: the
//! OpenShell gRPC fixture, a fake Docker engine, an inference upstream that
//! lists only the models a scenario declares, and the control endpoint of the
//! `fixture` provider. A scenario declares what the engine, gateway, and
//! upstream report, may change what the gateway holds between runs, and reads
//! what they recorded.

use crate::docker_engine::{self, DATA_ROOT};

/// The fixed engine socket on Unix, which managed Docker gateways name.
const MANAGED_ENGINE: &str = "unix:///tmp/nemoclaw-integration/engine.sock";
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
    /// The model IDs the upstream lists.
    models: Mutex<Vec<Value>>,
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

    /// Apply a case's declaration, if any, and return the observations. A
    /// declaration replaces the declared images, containers, models, driver,
    /// and sandbox creation delay. Its optional `change` alters what the
    /// gateway holds once, as an outage between runs would: it stops one
    /// sandbox's Fabric runtime, or forgets every provider registration.
    fn control_reply(&self, request: &http_fixture::Request) -> (u16, Vec<u8>) {
        let Ok(declared) = serde_json::from_slice::<Value>(&request.body) else {
            return (400, b"declare must be JSON".to_vec());
        };
        if !declared.is_null() {
            let list = |key: &str| declared[key].as_array().cloned().unwrap_or_default();
            *self.images.lock().unwrap() = list("images");
            *self.containers.lock().unwrap() = list("containers");
            *self.models.lock().unwrap() = list("models");
            self.gateway.lock().unwrap().declare(&declared);
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
        let source = |value: &str| {
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
        let mut openshell = self.gateway.lock().unwrap().observations(source);
        openshell["endpoint"] = json!(self.gateway_endpoint);
        json!({
            "openshell": openshell,
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
    /// The fixed engine socket this run owns, on Unix.
    socket: Option<PathBuf>,
}

impl Drop for Fixtures {
    fn drop(&mut self) {
        if let Some(socket) = &self.socket {
            let _ = std::fs::remove_file(socket);
        }
    }
}

impl Fixtures {
    /// On Unix, one fixed engine socket gives every scenario the same Docker
    /// provider alias and image addresses, which test files name. Elsewhere
    /// the engine is `ssh://127.0.0.1:PORT`, which the `nemoclaw-fixture-ssh`
    /// relay that the integration step puts on `PATH` as `ssh` forwards; only
    /// image reads use it there, because managed Docker gateway storage needs
    /// a local engine socket.
    pub async fn start() -> Self {
        let gateway = openshell::Fixture::start().await;
        let mut shared = Shared {
            gateway: gateway.state.clone(),
            gateway_endpoint: gateway.endpoint.clone(),
            ..Default::default()
        };
        // The engine serves through `shared`, which holds the engine's endpoint.
        let cell = Arc::new(OnceLock::<Arc<Shared>>::new());
        let serving = cell.clone();
        #[cfg(unix)]
        let (engine, socket) = {
            let socket = PathBuf::from(MANAGED_ENGINE.trim_start_matches("unix://"));
            std::fs::create_dir_all(socket.parent().unwrap()).unwrap();
            assert!(
                std::os::unix::net::UnixStream::connect(&socket).is_err(),
                "another integration run is active"
            );
            let _ = std::fs::remove_file(&socket);
            let engine = http_fixture::Fixture::start_at_with_headers(&socket, move |request| {
                Some(serving.get()?.engine_reply(&request))
            })
            .await;
            (engine, Some(socket))
        };
        #[cfg(not(unix))]
        let (engine, socket) = {
            let mut engine = http_fixture::Fixture::start_tcp(move |request| {
                let (status, _, body) = serving.get()?.engine_reply(&request);
                Some((status, body))
            })
            .await;
            engine.endpoint = engine.endpoint.replacen("http://", "ssh://", 1);
            (engine, None)
        };
        shared.engine_endpoint = engine.endpoint.clone();
        let shared = Arc::new(shared);
        let _ = cell.set(shared.clone());
        let serving = shared.clone();
        let upstream = http_fixture::Fixture::start_tcp(move |request| {
            let target = format!("{} {}", request.method, request.path);
            serving.upstream_requests.lock().unwrap().push(target);
            // A model is its name, or an Ollama model with its name and digest.
            let models = serving.models.lock().unwrap();
            let name = |model: &Value| model.as_str().or(model["name"].as_str()).map(str::to_owned);
            if request.method == "GET" && request.path.ends_with("/models") && !models.is_empty() {
                let data: Vec<Value> = models
                    .iter()
                    .filter_map(name)
                    .map(|id| json!({"id": id, "object": "model"}))
                    .collect();
                let list = json!({"object": "list", "data": data});
                return Some((200, list.to_string().into_bytes()));
            }
            if request.method == "GET" && request.path.ends_with("/api/tags") && !models.is_empty()
            {
                let tags: Vec<Value> = models
                    .iter()
                    .filter_map(|model| {
                        Some(json!({"name": name(model)?, "digest": model["digest"], "size": 42}))
                    })
                    .collect();
                return Some((200, json!({"models": tags}).to_string().into_bytes()));
            }
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
        let (engine, endpoint) = match &mut document.spec.gateway {
            Gateway::External(gateway) => {
                gateway.credential = None;
                gateway.tls = None;
                (Some(&mut gateway.engine), shared.engine_endpoint.as_str())
            }
            // Managed gateway storage takes only a local engine socket. Every
            // platform compiles the Unix socket, so the Docker alias a test
            // file names stays the same; these scenarios run only on Unix.
            gateway => (
                gateway.as_managed_mut().map(|managed| &mut managed.engine),
                MANAGED_ENGINE,
            ),
        };
        if let Some(engine) = engine.filter(|engine| !engine.is_empty()) {
            *engine = endpoint.to_owned();
        }
        let upstream = shared.upstream_endpoint.get().unwrap();
        // An Ollama proxy's existing daemon is the upstream fixture too.
        let mut value = serde_json::to_value(&*document).unwrap();
        let mut proxied = false;
        if let Some(services) = value["spec"]["services"].as_object_mut() {
            for service in services.values_mut() {
                if let Some(endpoint) = service["upstream"]["endpoint"].as_str() {
                    let path = url::Url::parse(endpoint)
                        .unwrap()
                        .path()
                        .trim_end_matches('/')
                        .to_owned();
                    service["upstream"]["endpoint"] = json!(format!("{upstream}{path}"));
                    proxied = true;
                }
            }
        }
        if proxied {
            *document = Document::parse(serde_json::to_vec(&value).unwrap().as_slice()).unwrap();
        }
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
        shared.models.lock().unwrap().clear();
        *shared.credentials.lock().unwrap() = credentials;
    }

    /// What OpenTofu's teardown left that it must not: gateway objects or
    /// Fabric runtimes, deleted engine storage, or unrecognized engine requests.
    pub fn teardown_problem(&self) -> Option<String> {
        let state = self.shared.gateway.lock().unwrap();
        let left: Vec<String> = [
            ("sandbox", state.sandboxes.keys().collect::<Vec<_>>()),
            ("provider", state.providers.keys().collect()),
            ("profile", state.profiles.keys().collect()),
            ("workspace", state.workspaces.keys().collect()),
            ("Fabric runtime", state.fabric_runtimes.keys().collect()),
        ]
        .into_iter()
        .flat_map(|(kind, keys)| keys.into_iter().map(move |key| format!("{kind} {key}")))
        .collect();
        if !left.is_empty() {
            return Some(format!("teardown left gateway objects: {left:?}"));
        }
        let mutations = &self.shared.engine.lock().unwrap().mutations;
        mutations
            .iter()
            .any(|m| m.starts_with("UNEXPECTED") || m.starts_with("DELETE /volumes"))
            .then(|| format!("unexpected or storage-deleting engine requests: {mutations:?}"))
    }
}
