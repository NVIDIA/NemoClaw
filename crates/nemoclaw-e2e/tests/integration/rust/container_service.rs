// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! The lifecycle of `kind: container` services through the SDK, the bundle's
//! OpenTofu, and the real Docker provider, against a fake Docker engine and
//! the OpenShell fixture gateway. The `tofu test` scenarios mock the Docker
//! provider, so they cannot show what it creates, replaces, or deletes, or
//! the provider errors that a failed readiness check reports.
//!
//! The engine keeps what the Docker provider creates. Each application
//! container's health is scripted by name: an HTTP status sequence, a
//! runtime status file, or a Docker HEALTHCHECK status sequence.
use crate::docker_engine::{self, Engine};
use nemoclaw_e2e::{http_fixture, openshell::Fixture};
use nemoclaw_sdk::{CancellationToken, Deployment, Outcome, config::Document};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, VecDeque},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

const OWNER: &str = "5d0c1a52-7d0e-4c6a-9a51-2f6c8e4d7a10";
const OWNER_LABEL: &str = "nemoclaw.nvidia.com/uid";
const STATUS: &str = "/data/status.json";

/// The fake engine and the application behavior a test scripts on it.
#[derive(Default)]
struct Host {
    engine: Engine,
    images: Vec<Value>,
    /// Every request, as `METHOD target`.
    requests: Vec<String>,
    created: usize,
    starts: usize,
    /// Docker HEALTHCHECK statuses by container name; the last one repeats.
    health: BTreeMap<String, VecDeque<String>>,
    /// Runtime status files by container name.
    status: BTreeMap<String, Value>,
}

/// One answer that repeats its last entry.
fn next<T: Clone>(queue: &mut VecDeque<T>) -> Option<T> {
    if queue.len() > 1 {
        queue.pop_front()
    } else {
        queue.front().cloned()
    }
}

fn image(reference: &str, labels: Value) -> Value {
    json!({"Id":format!("sha256:{}", "c".repeat(64)),"Architecture":"arm64","Os":"linux",
        "RepoDigests":[reference],"RepoTags":[],"Config":{"Labels":labels}})
}

impl Host {
    fn name(&mut self, reference: &str) -> Option<String> {
        let container = self.engine.container(reference)?;
        Some(
            container["Name"]
                .as_str()?
                .trim_start_matches('/')
                .to_owned(),
        )
    }

    /// Answer one engine request. The shared fake engine keeps volumes,
    /// networks, and the gateway's storage initializer; this adds images,
    /// container listing, starts that keep running, stops, and deletions.
    fn reply(&mut self, method: &str, target: &str, body: &[u8]) -> (u16, Vec<u8>) {
        self.requests.push(format!("{method} {target}"));
        let url = url::Url::parse(&format!("http://engine{target}")).unwrap();
        let query = |name: &str| {
            url.query_pairs()
                .find(|(key, _)| key == name)
                .map(|(_, value)| value.into_owned())
        };
        let path = url.path().replace("%40", "@").replace("%3A", ":");
        let json = |status: u16, value: Value| (status, serde_json::to_vec(&value).unwrap());
        let missing = || json(404, json!({"message":"missing"}));
        let done = || (204, Vec::new());
        if method == "GET" && path == "/images/json" {
            let images = self.images.iter().map(|image| {
                json!({"Id":image["Id"],"RepoTags":image["RepoTags"],"RepoDigests":image["RepoDigests"],
                    "Labels":image["Config"]["Labels"],"Size":1})
            });
            return json(200, json!(images.collect::<Vec<_>>()));
        }
        if let Some(name) = path
            .strip_prefix("/images/")
            .and_then(|rest| rest.strip_suffix("/json"))
        {
            let found = self.images.iter().find(|image| {
                image["Id"] == name
                    || image["RepoDigests"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .any(|r| r == name)
            });
            return found.map_or_else(missing, |image| json(200, image.clone()));
        }
        let segments: Vec<&str> = path.trim_start_matches('/').split('/').collect();
        if method != "GET" && method != "HEAD" {
            let recorded = if segments == ["containers", "create"] {
                format!("{method} {path}?name={}", query("name").unwrap_or_default())
            } else {
                format!("{method} {path}")
            };
            self.engine.mutations.push(recorded);
        }
        match (method, segments.as_slice()) {
            ("GET" | "HEAD", ["_ping"]) => (200, b"OK".to_vec()),
            ("GET", ["version"]) => json(
                200,
                json!({"ApiVersion":"1.47","MinAPIVersion":"1.24","Version":"28.0","Os":"linux","Arch":"arm64"}),
            ),
            ("GET", ["containers", "json"]) => {
                let listed = self.engine.containers.iter().map(|c| {
                    json!({"Id":c["Id"],"Names":[c["Name"]],"Image":c["Config"]["Image"],
                        "Labels":c["Config"]["Labels"],"State":c["State"]["Status"],"Ports":[]})
                });
                json(200, json!(listed.collect::<Vec<_>>()))
            }
            ("POST", ["images", "create"]) => {
                let (from, tag) = (query("fromImage").unwrap(), query("tag").unwrap());
                let reference = if tag.starts_with("sha256:") {
                    format!("{from}@{tag}")
                } else {
                    format!("{from}:{tag}")
                };
                if !self
                    .images
                    .iter()
                    .any(|image| image["RepoDigests"][0] == reference.as_str())
                {
                    self.images.push(image(&reference, json!({})));
                }
                json(200, json!({"status":"Downloaded"}))
            }
            ("POST", ["containers", "create"]) => {
                let recorded = self.engine.mutations.len();
                let (status, _) = docker_engine::handle(&mut self.engine, method, target, body);
                self.engine.mutations.truncate(recorded);
                // Docker never reuses an ID; the shared engine numbers by count.
                self.created += 1;
                let id = format!("application-{}", self.created);
                let address = format!("172.30.123.{}", 100 + self.created);
                let container = self.engine.containers.last_mut().unwrap();
                container["Id"] = json!(id);
                container["Image"] = container["Config"]["Image"].clone();
                // Docker reports the network a container was created on and
                // its published ports, as it does after start.
                let host_config = container["HostConfig"].clone();
                if let Some(network) = host_config["NetworkMode"]
                    .as_str()
                    .filter(|mode| !matches!(*mode, "" | "default" | "none" | "host"))
                {
                    container["NetworkSettings"]["Networks"][network] = json!({"NetworkID":"network",
                        "IPAddress":address,"IPPrefixLen":24,"Gateway":"172.30.123.1"});
                }
                container["NetworkSettings"]["Ports"] = host_config
                    .get("PortBindings")
                    .cloned()
                    .unwrap_or(json!({}));
                json(status, json!({"Id":id,"Warnings":[]}))
            }
            ("GET", ["containers", reference, "json"]) => {
                let Some(name) = self.name(reference) else {
                    return missing();
                };
                let health = self.health.get_mut(&name).and_then(next);
                let container = self.engine.container(reference).unwrap();
                match health {
                    Some(status) => container["State"]["Health"] = json!({"Status":status}),
                    // An image without a HEALTHCHECK reports no health.
                    None => _ = container["State"].as_object_mut().unwrap().remove("Health"),
                }
                json(200, container.clone())
            }
            ("HEAD" | "GET", ["containers", reference, "archive"])
                if query("path").as_deref() == Some(STATUS) =>
            {
                let name = self.name(reference).unwrap_or_default();
                match (method, self.status.get(&name)) {
                    ("GET", Some(status)) => (
                        200,
                        docker_engine::tar_entry("status.json", status.to_string().as_bytes()),
                    ),
                    _ => missing(),
                }
            }
            ("POST", ["containers", reference, "start"])
                if self
                    .engine
                    .container(reference)
                    .is_some_and(|c| c["Config"]["Cmd"][0] != "generate-certs") =>
            {
                self.starts += 1;
                let started = format!("2026-01-01T00:{:02}:00Z", self.starts);
                let container = self.engine.container(reference).unwrap();
                container["State"] =
                    json!({"Status":"running","Running":true,"ExitCode":0,"StartedAt":started});
                done()
            }
            ("POST", ["containers", reference, "stop" | "kill"]) => {
                let Some(container) = self.engine.container(reference) else {
                    return missing();
                };
                container["State"] = json!({"Status":"exited","Running":false,"ExitCode":0});
                done()
            }
            ("DELETE", ["containers", reference]) => {
                let before = self.engine.containers.len();
                self.engine
                    .containers
                    .retain(|c| c["Id"] != *reference && c["Name"] != format!("/{reference}"));
                if self.engine.containers.len() < before {
                    done()
                } else {
                    missing()
                }
            }
            ("POST", ["networks", _, "disconnect"]) => (200, Vec::new()),
            ("POST", ["networks", network, "connect"]) => {
                let request: Value = serde_json::from_slice(body).unwrap();
                let address = request["EndpointConfig"]["IPAMConfig"]["IPv4Address"]
                    .as_str()
                    .filter(|address| !address.is_empty())
                    .unwrap_or("172.30.123.20")
                    .to_owned();
                let network = (*network).to_owned();
                let Some(container) = self
                    .engine
                    .container(request["Container"].as_str().unwrap())
                else {
                    return missing();
                };
                container["NetworkSettings"]["Networks"][network] = json!({"NetworkID":"network",
                    "IPAddress":address,"IPPrefixLen":24,"Gateway":"172.30.123.1"});
                (200, Vec::new())
            }
            ("DELETE", ["volumes", name]) => {
                if self.engine.volumes.remove(*name).is_some() {
                    done()
                } else {
                    missing()
                }
            }
            ("DELETE", ["networks", name]) => {
                if self.engine.networks.remove(*name).is_some() {
                    done()
                } else {
                    missing()
                }
            }
            _ => {
                let recorded = self.engine.mutations.len();
                let handled = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    docker_engine::handle(&mut self.engine, method, target, body)
                }));
                // This engine recorded the request already.
                self.engine.mutations.truncate(recorded);
                handled.unwrap_or_else(|_| {
                    self.engine
                        .mutations
                        .push(format!("UNEXPECTED {method} {target}"));
                    (500, br#"{"message":"unexpected"}"#.to_vec())
                })
            }
        }
    }
}

/// One deployment of a managed Docker gateway, one agent, and three
/// application services, one for each readiness mode: `web` publishes an
/// HTTP health endpoint, `worker` reports a runtime status file, and
/// `checked` relies on its image's Docker HEALTHCHECK.
struct Scenario {
    cancel: CancellationToken,
    deployment: Deployment,
    document: Value,
    host: Arc<Mutex<Host>>,
    gateway: Fixture,
    /// The statuses the web health endpoint answers; the last one repeats.
    web: Arc<Mutex<VecDeque<u16>>>,
    web_requests: Arc<Mutex<usize>>,
    prefix: String,
    _web: http_fixture::Fixture,
    _engine: http_fixture::Fixture,
    _directory: tempfile::TempDir,
}

impl Scenario {
    async fn new() -> Self {
        let bundle = std::path::PathBuf::from(std::env::var_os("NEMOCLAW_TEST_BUNDLE").unwrap());
        let directory = tempfile::tempdir().unwrap();
        let gateway = Fixture::start().await;
        let host = Arc::new(Mutex::new(Host::default()));
        let agent = format!("fixture/agent@sha256:{}", "b".repeat(64));
        let catalog = serde_json::to_string(&nemoclaw_e2e::image_runtime::catalog()).unwrap();
        {
            let mut host = host.lock().unwrap();
            host.images = vec![
                image(
                    &agent,
                    json!({nemoclaw_sdk::fabric_catalog::IMAGE_CATALOG_LABEL: catalog}),
                ),
                image(&application_image('a'), json!({})),
            ];
            // Another owner's objects on the same engine.
            let engine = &mut host.engine;
            engine.volumes.insert(
                "foreign-data".into(),
                json!({"Name":"foreign-data","Labels":{OWNER_LABEL:"another-deployment"}}),
            );
            engine.networks.insert(
                "foreign-network".into(),
                json!({"Name":"foreign-network","Id":"foreign-network"}),
            );
            engine
                .containers
                .push(json!({"Id":"foreign","Name":"/foreign-application",
                "Config":{"Image":"foreign","Labels":{OWNER_LABEL:"another-deployment"}},
                "State":{"Status":"running","Running":true}}));
        }
        let serving = host.clone();
        let engine = http_fixture::Fixture::start(move |request| {
            Some(
                serving
                    .lock()
                    .unwrap()
                    .reply(&request.method, &request.path, &request.body),
            )
        })
        .await;
        let web = Arc::new(Mutex::new(VecDeque::from([200])));
        let web_requests = Arc::new(Mutex::new(0));
        // Only this deployment's readiness check knows the path, so a request
        // that another process sends to a reused port is not counted.
        let health_path = format!(
            "/health/{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let (statuses, requests, path) = (web.clone(), web_requests.clone(), health_path.clone());
        let web_endpoint = http_fixture::Fixture::start_tcp(move |request| {
            if (request.method.as_str(), request.path.as_str()) != ("GET", path.as_str()) {
                return Some((404, Vec::new()));
            }
            *requests.lock().unwrap() += 1;
            Some((next(&mut statuses.lock().unwrap()).unwrap(), Vec::new()))
        })
        .await;
        let port: u16 = web_endpoint
            .endpoint
            .rsplit(':')
            .next()
            .unwrap()
            .parse()
            .unwrap();
        let document = json!({
            "apiVersion":"nemoclaw.nvidia.com/v1alpha1","kind":"NemoClawConfig",
            "metadata":{"name":"container-lifecycle","uid":OWNER},
            "spec":{
                "gateway":{"management":"managed","runtime":{"provider":"docker"},
                    "endpoint":gateway.endpoint,"engine":engine.endpoint,"networkCIDR":"172.30.123.0/24"},
                "inferenceProviders":{"hosted":{"provider":"openai","endpoint":"https://inference.example.test/v1"}},
                "services":{
                    "web":{"kind":"container","image":application_image('a'),
                        "publication":{"bindAddress":"127.0.0.1","port":port},
                        "readiness":{"path":health_path,"timeoutSeconds":8}},
                    "worker":{"kind":"container","image":application_image('a'),
                        "readiness":{"runtimeStatus":STATUS,"timeoutSeconds":8}},
                    "checked":{"kind":"container","image":application_image('a'),
                        "readiness":{"timeoutSeconds":8}}
                },
                "sandboxes":{"assistant":{"image":{"ref":agent},"network":{"tier":"isolated"},
                    "harness":{"kind":"nvidia.fabric.openclaw"},
                    "agent":{"name":"main","inference":{"routes":[{"name":"primary","providerRef":"hosted","overrides":{"model":"m"}}]}}}}
            }
        });
        let prefix = Document::parse(document.to_string().as_bytes())
            .unwrap()
            .workspace();
        let scenario = Self {
            cancel: CancellationToken::new(),
            deployment: Deployment::new(directory.path(), &bundle),
            document,
            host,
            gateway,
            web,
            web_requests,
            prefix,
            _web: web_endpoint,
            _engine: engine,
            _directory: directory,
        };
        scenario.status("worker", "ready");
        scenario.health("checked", &["healthy"]);
        scenario
    }

    fn container_name(&self, service: &str) -> String {
        format!("{}-container-{service}", self.prefix)
    }

    /// The runtime status file every container of `service` reports.
    fn status(&self, service: &str, phase: &str) {
        let report = json!({"phase":phase,"updated":"2026-01-02T00:00:00Z","detail":"","pid":7});
        self.host
            .lock()
            .unwrap()
            .status
            .insert(self.container_name(service), report);
    }

    fn health(&self, service: &str, statuses: &[&str]) {
        let statuses = statuses.iter().map(|status| (*status).to_owned()).collect();
        self.host
            .lock()
            .unwrap()
            .health
            .insert(self.container_name(service), statuses);
    }

    fn web_statuses(&self, statuses: &[u16]) {
        *self.web.lock().unwrap() = statuses.iter().copied().collect();
    }

    fn parsed(&self) -> Document {
        Document::parse(self.document.to_string().as_bytes()).unwrap()
    }

    async fn apply(&self) -> Result<nemoclaw_sdk::OperationResult, nemoclaw_sdk::Error> {
        self.deployment.apply(&self.parsed(), &self.cancel).await
    }

    async fn plan(&self) -> Vec<(String, Vec<String>)> {
        let planned = self
            .deployment
            .plan(&self.parsed(), &self.cancel)
            .await
            .unwrap();
        assert_eq!(planned.outcome, Outcome::Planned);
        planned
            .changes
            .into_iter()
            .map(|change| (change.resource, change.actions))
            .collect()
    }

    /// The engine's containers by name, with their IDs.
    fn containers(&self) -> BTreeMap<String, String> {
        let host = self.host.lock().unwrap();
        host.engine
            .containers
            .iter()
            .map(|c| {
                (
                    c["Name"]
                        .as_str()
                        .unwrap()
                        .trim_start_matches('/')
                        .to_owned(),
                    c["Id"].as_str().unwrap().to_owned(),
                )
            })
            .collect()
    }

    fn volumes(&self) -> Vec<String> {
        self.host
            .lock()
            .unwrap()
            .engine
            .volumes
            .keys()
            .cloned()
            .collect()
    }

    fn mutations(&self) -> Vec<String> {
        self.host.lock().unwrap().engine.mutations.clone()
    }

    fn requests(&self) -> Vec<String> {
        self.host.lock().unwrap().requests.clone()
    }

    /// The application containers' names, sorted, once per container: a
    /// duplicate name shows twice.
    fn application_containers(&self) -> Vec<String> {
        let prefix = format!("/{}-container-", self.prefix);
        let host = self.host.lock().unwrap();
        let mut names: Vec<String> = host
            .engine
            .containers
            .iter()
            .filter_map(|c| c["Name"].as_str())
            .filter(|name| name.starts_with(&prefix))
            .map(|name| name.trim_start_matches('/').to_owned())
            .collect();
        names.sort();
        names
    }

    /// The ordered container creates, starts, stops, and deletions.
    fn container_log(&self) -> Vec<String> {
        self.mutations()
            .into_iter()
            .filter(|m| m.contains("/containers/"))
            .collect()
    }

    /// The deployment's agent: its sandbox IDs and Fabric starts.
    fn agent(&self) -> (Vec<String>, Vec<(String, usize)>) {
        let state = self.gateway.state.lock().unwrap();
        let mut sandboxes: Vec<String> = state
            .sandboxes
            .values()
            .map(|s| s.metadata.as_ref().unwrap().id.clone())
            .collect();
        sandboxes.sort();
        let mut starts: Vec<(String, usize)> = state
            .fabric_starts
            .iter()
            .map(|(k, v)| (k.clone(), *v))
            .collect();
        starts.sort();
        (sandboxes, starts)
    }

    /// The other owner's objects remain, and no request named them.
    fn assert_foreign_untouched(&self) {
        let host = self.host.lock().unwrap();
        assert!(host.engine.volumes.contains_key("foreign-data"));
        assert!(host.engine.networks.contains_key("foreign-network"));
        assert!(host.engine.containers.iter().any(|c| c["Id"] == "foreign"));
        let touched: Vec<_> = host
            .engine
            .mutations
            .iter()
            .filter(|m| m.contains("foreign"))
            .collect();
        assert!(touched.is_empty(), "{touched:?}");
    }

    fn assert_no_unexpected_requests(&self) {
        let unexpected: Vec<_> = self
            .mutations()
            .into_iter()
            .filter(|m| m.starts_with("UNEXPECTED"))
            .collect();
        assert!(unexpected.is_empty(), "{unexpected:?}");
    }
}

fn application_image(digit: char) -> String {
    format!(
        "fixture/application@sha256:{}",
        digit.to_string().repeat(64)
    )
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires NEMOCLAW_TEST_BUNDLE; fake Docker engine and OpenShell fixture"]
async fn apply_waits_for_each_readiness_mode_then_exits_and_reapply_keeps_the_containers() {
    let s = Scenario::new().await;
    // Each check reports starting before it reports ready.
    s.web_statuses(&[503, 503, 200]);
    s.health("checked", &["starting", "starting", "healthy"]);
    let started = Instant::now();
    let applied = s.apply().await.unwrap();
    assert_eq!(applied.outcome, Outcome::Succeeded);
    let names = ["checked", "web", "worker"];
    let expected: Vec<String> = names.iter().map(|n| s.container_name(n)).collect();
    assert_eq!(s.application_containers(), expected);
    for name in names {
        assert!(
            s.volumes()
                .contains(&format!("{}-data", s.container_name(name))),
            "{name}"
        );
    }
    assert!(*s.web_requests.lock().unwrap() >= 3);
    assert!(started.elapsed() < Duration::from_secs(60));
    assert!(!s.agent().0.is_empty());

    // Nothing keeps observing or changing the engine after apply returns.
    let (requests, web) = (s.requests().len(), *s.web_requests.lock().unwrap());
    tokio::time::sleep(Duration::from_secs(3)).await;
    assert_eq!(s.requests().len(), requests);
    assert_eq!(*s.web_requests.lock().unwrap(), web);

    // An unchanged apply plans nothing, keeps every container, and checks
    // readiness again.
    let changes = s.plan().await;
    assert!(changes.is_empty(), "{changes:?}");
    let (containers, mutations, agent) = (s.containers(), s.mutations(), s.agent());
    let applied = s.apply().await.unwrap();
    assert!(applied.changes.is_empty(), "{:?}", applied.changes);
    assert_eq!(s.containers(), containers);
    assert_eq!(s.mutations(), mutations);
    assert_eq!(s.agent(), agent);
    assert!(*s.web_requests.lock().unwrap() > web);
    s.assert_foreign_untouched();
    s.assert_no_unexpected_requests();
}

/// The error text of a failed apply, with OpenTofu's wrapping removed.
fn failure(result: Result<nemoclaw_sdk::OperationResult, nemoclaw_sdk::Error>) -> String {
    let error = result.expect_err("apply must fail");
    error
        .to_string()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// Each application container exists exactly once.
fn assert_one_container_each(s: &Scenario) {
    let expected: Vec<String> = ["checked", "web", "worker"]
        .iter()
        .map(|n| s.container_name(n))
        .collect();
    assert_eq!(
        s.application_containers(),
        expected,
        "{:#?}",
        s.container_log()
    );
    let volumes: Vec<String> = s
        .volumes()
        .into_iter()
        .filter(|v| v.contains("-container-"))
        .collect();
    let expected: Vec<String> = expected.iter().map(|n| format!("{n}-data")).collect();
    assert_eq!(volumes, expected);
}

fn creates(s: &Scenario, service: &str) -> usize {
    let recorded = format!("POST /containers/create?name={}", s.container_name(service));
    s.mutations().iter().filter(|m| **m == recorded).count()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires NEMOCLAW_TEST_BUNDLE; fake Docker engine and OpenShell fixture"]
async fn unhealthy_or_unknown_readiness_fails_apply_and_retry_keeps_the_created_containers() {
    let s = Scenario::new().await;
    // An unhealthy HEALTHCHECK fails at once, naming its remedy.
    s.health("checked", &["starting", "unhealthy"]);
    let error = failure(s.apply().await);
    assert!(
        error.contains("container health check failed; inspect its logs"),
        "{error}"
    );
    // A status file the contract does not define is not readiness.
    s.health("checked", &["healthy"]);
    s.status("worker", "PRIVATE_PHASE");
    let error = failure(s.apply().await);
    assert!(error.contains("unknown managed runtime status"), "{error}");
    assert!(!error.contains("PRIVATE_PHASE"), "{error}");
    // An image without a HEALTHCHECK cannot report readiness.
    s.status("worker", "ready");
    s.host.lock().unwrap().health.clear();
    let error = failure(s.apply().await);
    assert!(
        error.contains("container has no Docker HEALTHCHECK"),
        "{error}"
    );

    // The failed applies created each container once; an explicit retry
    // observes them again without creating or replacing any.
    s.health("checked", &["healthy"]);
    let containers = s.containers();
    s.apply().await.unwrap();
    assert_eq!(s.containers(), containers);
    for service in ["checked", "web", "worker"] {
        assert_eq!(
            creates(&s, service),
            1,
            "{service}: {:#?}",
            s.container_log()
        );
    }
    assert_one_container_each(&s);
    s.assert_foreign_untouched();
    s.assert_no_unexpected_requests();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires NEMOCLAW_TEST_BUNDLE; fake Docker engine and OpenShell fixture"]
async fn readiness_that_never_arrives_times_out_within_its_bound_and_retry_completes() {
    let s = Scenario::new().await;
    s.web_statuses(&[503]);
    let started = Instant::now();
    let error = failure(s.apply().await);
    assert!(
        error.contains("container readiness timed out; resources retained"),
        "{error}"
    );
    // The service's 8 s bound, plus planning and the other resources.
    assert!(
        started.elapsed() < Duration::from_secs(45),
        "{:?}",
        started.elapsed()
    );
    s.web_statuses(&[200]);
    s.apply().await.unwrap();
    assert_eq!(creates(&s, "web"), 1, "{:#?}", s.container_log());
    assert_one_container_each(&s);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires NEMOCLAW_TEST_BUNDLE; fake Docker engine and OpenShell fixture"]
async fn interrupted_setup_is_unfinished_and_retry_completes_without_duplicates() {
    let mut s = Scenario::new().await;
    // One application, so no other container is being created when the
    // interrupt arrives: only its readiness wait is interrupted.
    let services = s.document["spec"]["services"].as_object_mut().unwrap();
    services.retain(|name, _| name == "web");
    s.web_statuses(&[503]);
    let interrupted = async {
        // The first request to the web container's health path comes from
        // its readiness check, which starts only after the provider has
        // created and started the container.
        while *s.web_requests.lock().unwrap() == 0 {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        s.cancel.cancel();
    };
    let (result, ()) = tokio::join!(s.apply(), interrupted);
    assert!(
        matches!(result, Err(nemoclaw_sdk::Error::Cancelled)),
        "{result:?}"
    );
    // The interrupted apply kept its record of the created container.
    let state: Value = serde_json::from_slice(
        &std::fs::read(s._directory.path().join("terraform.tfstate")).unwrap(),
    )
    .unwrap();
    let recorded = state["resources"]
        .as_array()
        .unwrap()
        .iter()
        .any(|r| r["type"] == "docker_container" && r["name"] == "container_service_web");
    assert!(recorded, "{:#?}", s.container_log());
    let error = s
        .deployment
        .export(&CancellationToken::new())
        .await
        .unwrap_err();
    assert!(error.to_string().contains("apply is unfinished"), "{error}");

    s.web_statuses(&[200]);
    let retry = CancellationToken::new();
    s.deployment.apply(&s.parsed(), &retry).await.unwrap();
    assert_eq!(creates(&s, "web"), 1, "{:#?}", s.container_log());
    let web = s.container_name("web");
    assert_eq!(
        s.application_containers(),
        std::slice::from_ref(&web),
        "{:#?}",
        s.container_log()
    );
    let volumes: Vec<String> = s
        .volumes()
        .into_iter()
        .filter(|v| v.contains("-container-"))
        .collect();
    assert_eq!(volumes, [format!("{web}-data")]);
    s.assert_foreign_untouched();
    s.assert_no_unexpected_requests();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires NEMOCLAW_TEST_BUNDLE; fake Docker engine and OpenShell fixture"]
async fn a_changed_application_is_replaced_alone_and_keeps_its_volume() {
    let mut s = Scenario::new().await;
    s.apply().await.unwrap();
    let (before, agent) = (s.containers(), s.agent());
    let mutations = s.mutations().len();
    s.document["spec"]["services"]["web"]["environment"] = json!({"LOG_LEVEL":"debug"});
    let changes = s.plan().await;
    let changed: Vec<_> = changes
        .iter()
        .filter(|(_, actions)| actions.iter().any(|a| a != "read"))
        .collect();
    assert_eq!(
        changed,
        [&(
            "docker_container.container_service_web".to_owned(),
            vec!["delete".to_owned(), "create".to_owned()]
        )],
        "{changes:?}"
    );
    let checks = *s.web_requests.lock().unwrap();
    s.apply().await.unwrap();
    let after = s.containers();
    let web = s.container_name("web");
    assert_ne!(after[&web], before[&web]);
    for service in ["checked", "worker"] {
        let name = s.container_name(service);
        assert_eq!(after[&name], before[&name], "{service}");
    }
    assert_eq!(s.agent(), agent);
    // The old container goes first, the new one mounts the kept volume, and
    // readiness checks the replacement.
    let changed = &s.mutations()[mutations..];
    let delete = changed
        .iter()
        .position(|m| *m == format!("DELETE /containers/{}", before[&web]))
        .unwrap();
    let create = changed
        .iter()
        .position(|m| *m == format!("POST /containers/create?name={web}"))
        .unwrap();
    assert!(delete < create, "{changed:?}");
    assert!(
        !changed.iter().any(|m| m.starts_with("DELETE /volumes/")),
        "{changed:?}"
    );
    assert!(*s.web_requests.lock().unwrap() > checks);
    let host = s.host.lock().unwrap();
    let created = host
        .engine
        .containers
        .iter()
        .find(|c| c["Name"] == format!("/{web}"))
        .unwrap();
    assert!(
        created["Config"]["Env"]
            .as_array()
            .unwrap()
            .contains(&json!("LOG_LEVEL=debug"))
    );
    assert_eq!(
        created["HostConfig"]["Mounts"][0]["Source"],
        format!("{web}-data")
    );
    drop(host);
    s.assert_foreign_untouched();
    s.assert_no_unexpected_requests();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires NEMOCLAW_TEST_BUNDLE; fake Docker engine and OpenShell fixture"]
async fn apply_refuses_removal_and_destroy_deletes_owned_applications_keeping_other_resources() {
    let s = Scenario::new().await;
    s.apply().await.unwrap();
    let agent = s.agent();
    let gateway_data = format!("{}-gateway-data", s.prefix);
    assert!(s.volumes().contains(&gateway_data));

    // Apply does not remove a service's runtime and storage: removing one
    // from the document stops before any change, as for typed services.
    let (containers, mutations) = (s.containers(), s.mutations());
    let mut removed = s.parsed();
    removed.spec.services.remove("worker");
    let error = s.deployment.apply(&removed, &s.cancel).await.unwrap_err();
    assert!(
        error
            .to_string()
            .contains("apply cannot remove a managed runtime"),
        "{error}"
    );
    assert_eq!(s.containers(), containers);
    assert_eq!(s.mutations(), mutations);
    assert_eq!(s.agent(), agent);

    // Destroy deletes every owned application container and volume, keeps
    // the gateway's retained storage, and leaves other owners' objects.
    let destroyed = s.deployment.destroy(&s.cancel).await.unwrap();
    assert_eq!(destroyed.outcome, Outcome::Destroyed);
    assert!(
        s.application_containers().is_empty(),
        "{:?}",
        s.containers()
    );
    let volumes = s.volumes();
    assert!(
        !volumes.iter().any(|v| v.contains("-container-")),
        "{volumes:?}"
    );
    assert!(volumes.contains(&gateway_data), "{volumes:?}");
    s.assert_foreign_untouched();

    // The same deployment applies again over its retained gateway storage.
    s.apply().await.unwrap();
    assert_one_container_each(&s);
    s.assert_no_unexpected_requests();
}
