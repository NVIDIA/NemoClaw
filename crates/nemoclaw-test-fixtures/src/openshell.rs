// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use openshell_core::proto as p;
use std::{
    collections::{HashMap, HashSet},
    future::Future,
    pin::Pin,
    sync::{Arc, Mutex},
    task::{Context, Poll},
};
use tonic::{Request, Response, Status, body::Body};

/// Optional real image execution behind the simulated gateway protocol.
/// Resource discovery remains simulated; command bytes and exit status are not.
pub trait SandboxExecution: Send + Sync {
    fn create(
        &self,
        sandbox: &p::Sandbox,
        credentials: &HashMap<String, String>,
    ) -> Result<(), Status>;
    fn delete(&self, sandbox: &p::Sandbox) -> Result<(), Status>;
    fn exec(&self, request: &p::ExecSandboxRequest) -> Result<std::process::Output, Status>;
}

/// Rewrites a sandbox as a gateway admission interceptor does.
pub type SandboxAdmission = Arc<dyn Fn(&mut p::Sandbox) + Send + Sync>;

#[derive(Default)]
pub struct State {
    pub sandbox_execution: Option<Arc<dyn SandboxExecution>>,
    /// Rewrites each sandbox as CreateSandbox stores it, as a gateway
    /// admission interceptor such as APF does.
    pub sandbox_admission: Option<SandboxAdmission>,
    pub driver: Option<String>,
    pub gateway_info: Option<p::GetGatewayInfoResponse>,
    pub gateway_reads: usize,
    pub health_reads: usize,
    pub workspaces: HashMap<String, p::Workspace>,
    pub profiles: HashMap<String, p::ProviderProfile>,
    pub providers: HashMap<String, p::Provider>,
    pub sandboxes: HashMap<String, p::Sandbox>,
    pub active_policy: Option<p::SandboxPolicy>,
    /// Each sandbox's policy revisions after its first, by sandbox ID, as a
    /// sandbox-scoped UpdateConfig with a policy stores them. The first is the
    /// policy the sandbox was created with.
    pub policy_revisions: HashMap<String, Vec<p::SandboxPolicyRevision>>,
    /// The statuses sandboxes report for the next revisions UpdateConfig
    /// stores, in order; once they run out, each revision loads.
    pub policy_loads: std::collections::VecDeque<p::PolicyStatus>,
    /// Lose the reply to the next policy UpdateConfig after storing it.
    pub lose_policy_update: bool,
    /// Sandbox-scoped UpdateConfig requests, in order.
    pub config_updates: Vec<p::UpdateConfigRequest>,
    /// Rewrites a sandbox as an UpdateConfig without a policy reaches it, as
    /// APF does by injecting its bundle's policy.
    pub config_update: Option<SandboxAdmission>,
    pub sandbox_phase: Option<p::SandboxPhase>,
    pub sandbox_conditions: Vec<p::SandboxCondition>,
    pub configuration_admission: Option<p::SandboxConfigurationAdmission>,
    pub exec_exit: i32,
    pub inference_exit: i32,
    pub exec_truncated: bool,
    pub lose_start_reply: bool,
    pub exec_stalled: bool,
    pub exec_calls: Vec<Vec<String>>,
    pub exec_environments: Vec<HashMap<String, String>>,
    pub fabric_configurations: HashMap<String, serde_json::Value>,
    pub fabric_stopped: HashSet<String>,
    /// Running Fabric runtimes by ID, each naming its sandbox ID.
    pub fabric_runtimes: HashMap<String, String>,
    /// Runtime IDs Fabric marked failed, as after provider errors, while their
    /// processes still run: a check or invoke finds them unavailable, a stop
    /// ends them, and until then their processes hold the agent's kept state
    /// and native ports, so a start in their sandbox is refused.
    pub fabric_failed: HashSet<String>,
    /// Successful starts by sandbox ID, which number later runtime IDs.
    pub fabric_starts: HashMap<String, usize>,
    /// Sandboxes where a start failed with unknown effects; Fabric refuses
    /// another start there.
    pub fabric_uncertain: HashSet<String>,
    /// Stdin sent with each exec call, parallel to `exec_calls`.
    pub exec_stdin: Vec<Vec<u8>>,
    /// The sandbox name each exec call targets, parallel to `exec_calls`.
    pub exec_sandboxes: Vec<String>,
    /// Files present in the fake sandbox for bridge commands that name a path.
    pub sandbox_files: HashMap<String, Vec<u8>>,
    /// Start requests answered as though `serve` were not yet listening.
    pub host_unavailable_starts: usize,
    /// Start requests refused as Fabric refuses one while another runtime
    /// still owns the agent's kept state: `state_in_use`, with no effects.
    pub state_in_use_starts: usize,
    /// Runtime IDs with a request in flight. Like Fabric, the bridge refuses
    /// to stop them with `runtime_busy` and keeps them running.
    pub busy_runtimes: HashSet<String>,
    /// Why a running runtime's check does not pass, as Fabric's reason code,
    /// such as `unsupported_adapter`, `probe_timeout`, or an adapter's own
    /// failure; none passes.
    pub fabric_check_reason: Option<String>,
    pub exec_response: Option<Vec<u8>>,
    pub configuration_error: Option<serde_json::Value>,
    /// Start rejections by sandbox name, which take precedence over
    /// `configuration_error` for that sandbox.
    pub configuration_error_for: HashMap<String, serde_json::Value>,
    pub effects: usize,
    pub expected_bearer: Option<String>,
    pub conditional_updates: usize,
    pub lose_create: bool,
    pub substitute_sandbox_after_create: Option<(&'static str, String)>,
    pub fail_after_create: Option<(&'static str, tonic::Code)>,
    pub lose_delete: bool,
    pub delete_delay: std::time::Duration,
    pub delete_calls: usize,
    pub sandbox_create_delay: std::time::Duration,
    pub active_sandbox_creates: usize,
    pub peak_sandbox_creates: usize,
    /// When set, each CreateSandbox waits for a permit and takes one; a test
    /// adds permits to let held creates finish one at a time.
    pub sandbox_create_permits: Option<usize>,
    pub fail_read: Option<(&'static str, tonic::Code)>,
    /// Reject one RPC before its handler can mutate fixture state.
    pub reject_rpc: Option<(&'static str, tonic::Code, String)>,
    pub rejected_rpcs: Vec<String>,
    /// Sandbox service endpoints by workspace, sandbox, and service name.
    pub services: std::collections::BTreeMap<(String, String, String), p::ServiceEndpoint>,
    /// The exposures each CreateSandbox request carried, as sent.
    pub sandbox_exposures: Vec<Vec<p::SandboxServiceExposure>>,
    /// The path of every OpenShell RPC the fixture received, in order.
    pub rpcs: Vec<String>,
    /// Each provider registration as CreateProvider stored it, kept after deletion.
    pub created_providers: Vec<p::Provider>,
    /// Each sandbox as CreateSandbox stored it, kept after deletion.
    pub created_sandboxes: Vec<p::Sandbox>,
}
impl State {
    fn created(&mut self, kind: &str) {
        if self
            .fail_after_create
            .is_some_and(|(resource, _)| resource == kind)
        {
            self.fail_read = self.fail_after_create.take();
        }
    }
    fn metadata(
        &mut self,
        name: String,
        workspace: String,
        labels: HashMap<String, String>,
    ) -> p::ObjectMeta {
        self.effects += 1;
        p::ObjectMeta {
            id: format!("id-{}", self.effects),
            name,
            workspace,
            labels,
            resource_version: 1,
            ..Default::default()
        }
    }
    fn read(&self, kind: &str) -> Result<(), Status> {
        if let Some((failed, code)) = self.fail_read
            && failed == kind
        {
            return Err(Status::new(code, "secret-sentinel"));
        }
        Ok(())
    }
}
pub struct Fixture {
    pub state: Arc<Mutex<State>>,
    pub endpoint: String,
    task: tokio::task::JoinHandle<()>,
}
impl Fixture {
    /// Stop serving, as a gateway process that exited: new connections are
    /// refused.
    pub fn stop(&self) {
        self.task.abort();
    }
    pub async fn start() -> Self {
        Self::start_with_tls(None).await
    }
    pub async fn start_with_tls(tls: Option<tonic::transport::ServerTlsConfig>) -> Self {
        if tls.is_some() {
            let _ = rustls::crypto::ring::default_provider().install_default();
        }
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!(
            "{}://{}",
            if tls.is_some() { "https" } else { "http" },
            listener.local_addr().unwrap()
        );
        let state = Arc::new(Mutex::new(State::default()));
        let service = Service(state.clone());
        let task = tokio::spawn(async move {
            let mut server = tonic::transport::Server::builder();
            if let Some(tls) = tls {
                server = server.tls_config(tls).unwrap();
            }
            server
                .add_service(InferenceService(service.clone()))
                .add_service(service)
                // gRPC replies are small writes; without TCP_NODELAY, each
                // waits on Nagle's algorithm and the provider's delayed
                // acknowledgment, about 40 ms per call on Linux.
                .serve_with_incoming(tokio_stream::StreamExt::map(
                    tokio_stream::wrappers::TcpListenerStream::new(listener),
                    |stream| {
                        let stream = stream?;
                        stream.set_nodelay(true)?;
                        Ok::<_, std::io::Error>(stream)
                    },
                ))
                .await
                .unwrap();
        });
        Self {
            state,
            endpoint,
            task,
        }
    }
}
impl Fixture {
    /// Serve this gateway's `fixture_state` control endpoint, which
    /// `nemoclaw-fixture-control` reads at `NEMOCLAW_FIXTURE_CONTROL`: each
    /// read applies its `declare` JSON with [`State::declare`] and returns
    /// `{"openshell": OBSERVATIONS}` from [`State::observations`]. A
    /// credential value from `environment` is reported as `env:NAME`.
    pub async fn control(&self, environment: &[(&str, &str)]) -> crate::http::Fixture {
        let state = self.state.clone();
        let environment: Vec<(String, String)> = environment
            .iter()
            .map(|(name, value)| ((*name).to_owned(), (*value).to_owned()))
            .collect();
        crate::http::Fixture::start_tcp(move |request| {
            let declared: serde_json::Value =
                serde_json::from_slice(&request.body).unwrap_or_default();
            let mut state = state.lock().unwrap();
            if !declared.is_null() {
                state.declare(&declared);
            }
            let source = |value: &str| {
                environment
                    .iter()
                    .find(|(_, supplied)| supplied == value)
                    .map_or_else(|| "unrecognized".into(), |(name, _)| format!("env:{name}"))
            };
            let observed = serde_json::json!({"openshell": state.observations(source)});
            Some((200, observed.to_string().into_bytes()))
        })
        .await
    }
}
/// Run the native test files in `root` side by side, each against a new fake
/// gateway at `TF_VAR_endpoint` and its control endpoint, with `environment`,
/// and return OpenTofu's outputs.
pub async fn test_against_gateways(
    root: crate::tofu::TofuWorkspace,
    environment: &[(&str, &str)],
) -> Vec<String> {
    let root = Arc::new(root);
    let mut runs = Vec::new();
    for file in root.test_files() {
        let gateway = Fixture::start().await;
        let control = gateway.control(environment).await;
        let mut environment: Vec<(String, String)> = environment
            .iter()
            .map(|(name, value)| ((*name).to_owned(), (*value).to_owned()))
            .collect();
        environment.push(("TF_VAR_endpoint".into(), gateway.endpoint.clone()));
        environment.push(("NEMOCLAW_FIXTURE_CONTROL".into(), control.endpoint.clone()));
        let root = root.clone();
        runs.push(tokio::task::spawn_blocking(move || {
            let output = root.test(&file, &environment);
            drop((gateway, control));
            output
        }));
    }
    let mut outputs = Vec::new();
    for run in runs {
        outputs.push(run.await.unwrap());
    }
    outputs
}
impl State {
    /// Apply a fixture declaration's gateway part: the compute driver, a
    /// sandbox creation delay, and a one-time `change` that an outage between
    /// runs would make: stop or fail one sandbox's Fabric runtime, or forget every
    /// registration, profile, or sandbox.
    pub fn declare(&mut self, declared: &serde_json::Value) {
        self.driver = declared["compute_driver"].as_str().map(str::to_owned);
        self.sandbox_create_delay = std::time::Duration::from_millis(
            declared["sandbox_create_delay_ms"].as_u64().unwrap_or(0),
        );
        self.delete_delay = std::time::Duration::from_millis(
            declared["sandbox_delete_delay_ms"].as_u64().unwrap_or(0),
        );
        let change = &declared["change"];
        let sandbox_id = |state: &Self, name: &str| {
            state
                .sandboxes
                .values()
                .filter_map(|sandbox| sandbox.metadata.as_ref())
                .find(|metadata| metadata.name == name)
                .map(|metadata| metadata.id.clone())
        };
        if let Some(name) = change["stop_agent_runtime"].as_str() {
            let id = sandbox_id(self, name);
            self.fabric_runtimes
                .retain(|_, sandbox| Some(&*sandbox) != id.as_ref());
        }
        // Fabric marks the runtime failed but leaves its processes running.
        if let Some(name) = change["fail_agent_runtime"].as_str() {
            let id = sandbox_id(self, name);
            let failed: Vec<String> = self
                .fabric_runtimes
                .iter()
                .filter(|(_, sandbox)| Some(*sandbox) == id.as_ref())
                .map(|(runtime, _)| runtime.clone())
                .collect();
            self.fabric_failed.extend(failed);
        }
        // Someone changes the agent's model inside its sandbox, outside OpenTofu.
        if let Some(name) = change["change_agent_model"].as_str()
            && let Some(id) = sandbox_id(self, name)
            && let Some(configuration) = self.fabric_configurations.get_mut(&id)
        {
            configuration["models"]["default"]["model"] =
                serde_json::json!("changed-inside-the-sandbox");
        }
        if change["forget_registrations"] == true {
            self.providers.clear();
        }
        if change["forget_profiles"] == true {
            self.profiles.clear();
        }
        if change["forget_sandboxes"] == true {
            self.sandboxes.clear();
        }
    }

    /// What the gateway received and holds. `source` names where a credential
    /// value came from, so observations never carry the value.
    pub fn observations(&self, source: impl Fn(&str) -> String) -> serde_json::Value {
        use serde_json::json;
        use std::collections::BTreeMap;
        let providers: Vec<_> = self.created_providers.iter().map(|provider| {
            let meta = provider.metadata.clone().unwrap_or_default();
            json!({"name": meta.name, "workspace": meta.workspace, "labels": meta.labels,
                "type": provider.r#type, "config": provider.config,
                "credentials": provider.credentials.iter()
                    .map(|(name, value)| (name.clone(), source(value))).collect::<BTreeMap<_, _>>()})
        }).collect();
        // A policy's endpoints and middleware bindings.
        let endpoints = |policy: Option<&p::SandboxPolicy>| -> Vec<String> {
            policy
                .into_iter()
                .flat_map(|policy| policy.network_policies.values())
                .flat_map(|rule| &rule.endpoints)
                .map(|endpoint| format!("{}:{}{}", endpoint.host, endpoint.port, endpoint.path))
                .collect()
        };
        let middlewares =
            |policy: Option<&p::SandboxPolicy>| -> BTreeMap<String, serde_json::Value> {
                policy.into_iter()
                .flat_map(|policy| &policy.network_middlewares)
                .map(|(key, entry)| {
                    let selector = entry.endpoints.clone().unwrap_or_default();
                    (key.clone(), json!({"name": entry.name, "middleware": entry.middleware,
                        "order": entry.order, "on_error": entry.on_error,
                        "config": entry.config.as_ref().map(openshell_core::proto_struct::struct_to_json_value),
                        "include": selector.include, "exclude": selector.exclude}))
                })
                .collect()
            };
        let sandboxes: Vec<_> = self.created_sandboxes.iter().map(|sandbox| {
            let meta = sandbox.metadata.clone().unwrap_or_default();
            let spec = sandbox.spec.clone().unwrap_or_default();
            let driver_config = spec.template.as_ref().and_then(|template| template.driver_config.as_ref())
                .map(openshell_core::proto_struct::struct_to_json_value);
            let resources = spec.template.as_ref().and_then(|template| template.resources.as_ref())
                .map(openshell_core::proto_struct::struct_to_json_value);
            json!({"id": meta.id, "name": meta.name, "workspace": meta.workspace, "labels": meta.labels,
                "providers": spec.providers, "command": spec.command,
                "policy_endpoints": endpoints(spec.policy.as_ref()),
                "policy_middlewares": middlewares(spec.policy.as_ref()), "driver_config": driver_config,
                "resources": resources,
                "gpu_count": spec.resource_requirements.and_then(|resources| resources.gpu).map(|gpu| gpu.count.unwrap_or(1))})
        }).collect();
        // The policy each sandbox holds now, by workspace and name: its latest
        // revision, numbered from the one it was created with.
        let policies: BTreeMap<_, _> = self
            .sandboxes
            .iter()
            .map(|(key, sandbox)| {
                let latest = sandbox
                    .metadata
                    .as_ref()
                    .and_then(|metadata| self.policy_revisions.get(&metadata.id))
                    .and_then(|revisions| revisions.last());
                let policy = match latest {
                    Some(revision) => revision.policy.clone(),
                    None => sandbox
                        .spec
                        .as_ref()
                        .and_then(|spec| spec.policy.as_ref())
                        .map(started),
                };
                let policy = policy.as_ref();
                let filesystem = policy
                    .and_then(|policy| policy.filesystem.clone())
                    .unwrap_or_default();
                (
                    key,
                    json!({"version": latest.map_or(1, |revision| revision.version),
                "read_only": filesystem.read_only, "read_write": filesystem.read_write,
                "endpoints": endpoints(policy), "middlewares": middlewares(policy)}),
                )
            })
            .collect();
        let profiles: BTreeMap<_, _> = self
            .profiles
            .values()
            .map(|profile| {
                let credentials: Vec<_> = profile
                    .credentials
                    .iter()
                    .map(|credential| {
                        json!({
                "env_vars": credential.env_vars, "auth_style": credential.auth_style,
                "header_name": credential.header_name})
                    })
                    .collect();
                let endpoints: Vec<_> = profile
                    .endpoints
                    .iter()
                    .map(|endpoint| format!("{}:{}{}", endpoint.host, endpoint.port, endpoint.path))
                    .collect();
                let binaries: Vec<_> = profile.binaries.iter().map(|binary| &binary.path).collect();
                (
                    profile.id.clone(),
                    json!({"inference_capable": profile.inference_capable,
                "credentials": credentials, "endpoints": endpoints, "binaries": binaries}),
                )
            })
            .collect();
        let profile_mcp_rules: BTreeMap<_, Vec<_>> = self
            .profiles
            .values()
            .map(|profile| {
                let rules = profile
                    .endpoints
                    .iter()
                    .filter(|endpoint| endpoint.protocol == "mcp")
                    .flat_map(|endpoint| &endpoint.rules)
                    .filter_map(|rule| rule.allow.as_ref())
                    .map(|allow| {
                        let tool = allow
                            .params
                            .get("name")
                            .map(|name| json!({"glob": name.glob, "any": name.any}));
                        json!({"method": allow.method, "tool": tool})
                    })
                    .collect();
                (&profile.id, rules)
            })
            .collect();
        let exposures: Vec<Vec<_>> = self
            .sandbox_exposures
            .iter()
            .map(|exposures| {
                exposures
                    .iter()
                    .map(|exposure| {
                        json!({"service": exposure.service,
                "target_port": exposure.target_port,
                "authorization_mode": exposure.authorization_mode().as_str_name()})
                    })
                    .collect()
            })
            .collect();
        let execs: Vec<_> = self.exec_calls.iter().zip(&self.exec_sandboxes).zip(&self.exec_stdin)
            .map(|((command, sandbox), stdin)| {
                json!({"sandbox": sandbox, "command": command, "stdin": String::from_utf8_lossy(stdin)})
            })
            .collect();
        let live: BTreeMap<&str, &str> = self
            .sandboxes
            .values()
            .filter_map(|sandbox| sandbox.metadata.as_ref())
            .map(|metadata| (metadata.name.as_str(), metadata.id.as_str()))
            .collect();
        let registrations: Vec<&str> = self
            .providers
            .values()
            .filter_map(|provider| provider.metadata.as_ref())
            .map(|metadata| metadata.name.as_str())
            .collect();
        let registration_credentials: BTreeMap<_, _> = self
            .providers
            .values()
            .filter_map(|provider| {
                Some((
                    &provider.metadata.as_ref()?.name,
                    provider
                        .credentials
                        .iter()
                        .map(|(name, value)| (name.clone(), source(value)))
                        .collect::<BTreeMap<_, _>>(),
                ))
            })
            .collect();
        let rpcs: Vec<&str> = self
            .rpcs
            .iter()
            .map(|rpc| rpc.trim_start_matches("/openshell.v1.OpenShell/"))
            .collect();
        let services: BTreeMap<String, _> = self
            .services
            .iter()
            .map(|((workspace, sandbox, name), endpoint)| {
                (
                    format!("{workspace}/{sandbox}/{name}"),
                    json!({"target_port": endpoint.target_port,
                "authorization_mode": endpoint.authorization_mode().as_str_name()}),
                )
            })
            .collect();
        json!({
            "rpcs": rpcs, "created_providers": providers, "created_sandboxes": sandboxes,
            "exposures": exposures, "execs": execs, "fabric_starts": self.fabric_starts,
            "fabric_stopped": self.fabric_stopped,
            "fabric_configured": self.fabric_configurations.keys().collect::<Vec<_>>(),
            "workspaces": self.workspaces.keys().collect::<Vec<_>>(),
            // Gateway mutations so far, which an unchanged apply leaves as they were.
            "effects": self.effects,
            "peak_sandbox_creates": self.peak_sandbox_creates,
            "sandbox_deletes": self.delete_calls,
            // What the gateway holds now: sandbox IDs by name, sandbox policies
            // and service endpoints by workspace, sandbox, and name, registration
            // names and their credentials' sources, and provider profiles by ID.
            "sandboxes": live, "policies": policies, "services": services,
            "registrations": registrations,
            "registration_credentials": registration_credentials, "profiles": profiles,
            "profile_mcp_rules": profile_mcp_rules,
        })
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.task.abort();
    }
}

#[derive(Clone)]
struct Service(Arc<Mutex<State>>);
impl tonic::server::NamedService for Service {
    const NAME: &'static str = "openshell.v1.OpenShell";
}
type BoxFuture<T> = Pin<Box<dyn Future<Output = T> + Send>>;
struct Unary<Q, A> {
    state: Arc<Mutex<State>>,
    action: fn(&mut State, Q) -> Result<A, Status>,
}
impl<Q: Send + 'static, A: Send + 'static> tonic::server::UnaryService<Q> for Unary<Q, A> {
    type Response = A;
    type Future = BoxFuture<Result<Response<A>, Status>>;
    fn call(&mut self, request: Request<Q>) -> Self::Future {
        let result =
            (self.action)(&mut self.state.lock().unwrap(), request.into_inner()).map(Response::new);
        Box::pin(async move { result })
    }
}
async fn unary<Q, A>(
    request: http::Request<Body>,
    state: Arc<Mutex<State>>,
    action: fn(&mut State, Q) -> Result<A, Status>,
) -> http::Response<Body>
where
    Q: prost::Message + Default + 'static,
    A: prost::Message + Default + 'static,
{
    tonic::server::Grpc::new(tonic_prost::ProstCodec::default())
        .unary(Unary { state, action }, request)
        .await
}
impl tower::Service<http::Request<Body>> for Service {
    type Response = http::Response<Body>;
    type Error = std::convert::Infallible;
    type Future = BoxFuture<Result<Self::Response, Self::Error>>;
    fn poll_ready(&mut self, _: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        Poll::Ready(Ok(()))
    }
    fn call(&mut self, request: http::Request<Body>) -> Self::Future {
        let state = self.0.clone();
        Box::pin(async move {
            state
                .lock()
                .unwrap()
                .rpcs
                .push(request.uri().path().to_owned());
            let rejection = {
                let mut state = state.lock().unwrap();
                let rejection = state
                    .reject_rpc
                    .clone()
                    .filter(|(rpc, _, _)| request.uri().path().rsplit('/').next() == Some(*rpc));
                rejection.map(|(rpc, code, detail)| {
                    state.rejected_rpcs.push(rpc.into());
                    Status::new(code, detail)
                })
            };
            if let Some(rejection) = rejection {
                return Ok(rejection.into_http());
            }
            if state
                .lock()
                .unwrap()
                .expected_bearer
                .as_ref()
                .is_some_and(|expected| {
                    request
                        .headers()
                        .get("authorization")
                        .and_then(|v| v.to_str().ok())
                        != Some(expected.as_str())
                })
            {
                return Ok(Status::unauthenticated("fixture bearer rejected").into_http());
            }
            let response = match request.uri().path() {
                "/openshell.v1.OpenShell/ExecSandbox" => {
                    tonic::server::Grpc::new(tonic_prost::ProstCodec::default())
                        .server_streaming(Exec(state), request)
                        .await
                }
                "/openshell.v1.OpenShell/GetGatewayInfo" => {
                    unary(request, state, gateway_info).await
                }
                "/openshell.v1.OpenShell/Health" => {
                    unary(request, state, |state, _: p::HealthRequest| {
                        state.health_reads += 1;
                        Ok(p::HealthResponse {
                            status: p::ServiceStatus::Healthy as i32,
                            ..Default::default()
                        })
                    })
                    .await
                }
                "/openshell.v1.OpenShell/CreateSandbox" => {
                    let delay = {
                        let mut state = state.lock().unwrap();
                        state.active_sandbox_creates += 1;
                        state.peak_sandbox_creates =
                            state.peak_sandbox_creates.max(state.active_sandbox_creates);
                        state.sandbox_create_delay
                    };
                    if !delay.is_zero() {
                        tokio::time::sleep(delay).await;
                    }
                    loop {
                        {
                            let mut state = state.lock().unwrap();
                            match &mut state.sandbox_create_permits {
                                None => break,
                                Some(permits) if *permits > 0 => {
                                    *permits -= 1;
                                    break;
                                }
                                Some(_) => {}
                            }
                        }
                        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
                    }
                    let response = unary(request, state.clone(), create_sandbox).await;
                    state.lock().unwrap().active_sandbox_creates -= 1;
                    response
                }
                "/openshell.v1.OpenShell/GetSandbox" => {
                    unary(request, state, |state, request| {
                        get_sandbox(state, &request)
                    })
                    .await
                }
                "/openshell.v1.OpenShell/DeleteSandbox" => {
                    let delay = {
                        let mut state = state.lock().unwrap();
                        state.delete_calls += 1;
                        state.delete_delay
                    };
                    tokio::time::sleep(delay).await;
                    unary(request, state, |state, request| {
                        delete_sandbox(state, &request)
                    })
                    .await
                }
                "/openshell.v1.OpenShell/GetSandboxPolicyStatus" => {
                    unary(request, state, |state, request| {
                        policy_status(state, &request)
                    })
                    .await
                }
                "/openshell.v1.OpenShell/UpdateConfig" => {
                    unary(request, state, |state, request| {
                        update_config(state, request)
                    })
                    .await
                }
                "/openshell.v1.OpenShell/GetWorkspace" => {
                    unary(request, state, |state, request| {
                        get_workspace(state, &request)
                    })
                    .await
                }
                "/openshell.v1.OpenShell/CreateWorkspace" => {
                    unary(request, state, create_workspace).await
                }
                "/openshell.v1.OpenShell/GetProviderProfile" => {
                    unary(request, state, get_profile).await
                }
                "/openshell.v1.OpenShell/ImportProviderProfiles" => {
                    unary(request, state, import_profiles).await
                }
                "/openshell.v1.OpenShell/DeleteProviderProfile" => {
                    unary(request, state, delete_profile).await
                }
                "/openshell.v1.OpenShell/GetProvider" => {
                    unary(request, state, |state, request| {
                        get_provider(state, &request)
                    })
                    .await
                }
                "/openshell.v1.OpenShell/CreateProvider" => {
                    unary(request, state, create_provider).await
                }
                "/openshell.v1.OpenShell/UpdateProvider" => {
                    unary(request, state, update_provider).await
                }
                "/openshell.v1.OpenShell/DeleteWorkspace" => {
                    unary(request, state, delete_workspace).await
                }
                "/openshell.v1.OpenShell/GetService" => unary(request, state, get_service).await,
                "/openshell.v1.OpenShell/ExposeService" => {
                    unary(request, state, expose_service).await
                }
                "/openshell.v1.OpenShell/DeleteService" => {
                    unary(request, state, delete_service).await
                }
                "/openshell.v1.OpenShell/DeleteProvider" => {
                    unary(request, state, |state, request| {
                        delete_provider(state, &request)
                    })
                    .await
                }
                _ => http::Response::builder()
                    .status(200)
                    .header("content-type", "application/grpc")
                    .header("grpc-status", "12")
                    .body(Body::empty())
                    .unwrap(),
            };
            Ok(response)
        })
    }
}
fn get_workspace(
    state: &mut State,
    q: &p::GetWorkspaceRequest,
) -> Result<p::GetWorkspaceResponse, Status> {
    state.read("workspace")?;
    Ok(p::GetWorkspaceResponse {
        workspace: Some(
            state
                .workspaces
                .get(&q.name)
                .ok_or_else(|| Status::not_found("absent"))?
                .clone(),
        ),
    })
}
fn create_workspace(
    state: &mut State,
    q: p::CreateWorkspaceRequest,
) -> Result<p::CreateWorkspaceResponse, Status> {
    if state.workspaces.contains_key(&q.name) {
        return Err(Status::already_exists("collision"));
    }
    let workspace = p::Workspace {
        metadata: Some(state.metadata(q.name.clone(), q.name.clone(), q.labels)),
        status: Some(p::WorkspaceStatus { phase: 1 }),
    };
    state.workspaces.insert(q.name, workspace.clone());
    state.created("workspace");
    Ok(p::CreateWorkspaceResponse {
        workspace: Some(workspace),
    })
}
fn workspace(selector: &Option<p::WorkspaceSelector>) -> Result<String, Status> {
    match selector.as_ref().and_then(|s| s.selection.as_ref()) {
        Some(p::workspace_selector::Selection::Workspace(name)) if !name.is_empty() => {
            Ok(name.clone())
        }
        _ => Err(Status::invalid_argument("explicit workspace required")),
    }
}
fn get_provider(
    state: &mut State,
    q: &p::GetProviderRequest,
) -> Result<p::ProviderResponse, Status> {
    state.read("provider")?;
    let mut provider = state
        .providers
        .get(&format!("{}/{}", workspace(&q.workspace_scope)?, q.name))
        .ok_or_else(|| Status::not_found("absent"))?
        .clone();
    // OpenShell reports credential names with their values redacted.
    for value in provider.credentials.values_mut() {
        *value = "REDACTED".into();
    }
    Ok(p::ProviderResponse {
        provider: Some(provider),
        ..Default::default()
    })
}
// Wire limits from the pinned OpenShell server (d1155aa), independently checked
// here so an accepting protocol fixture cannot conceal invalid provider metadata.
fn validate_provider_metadata(meta: &p::ObjectMeta) -> Result<(), Status> {
    if meta
        .labels
        .values()
        .any(|v| v.len() > 63 || !v.chars().all(|c| c.is_alphanumeric() || "-_.".contains(c)))
        || meta.annotations.len() > 128
        || meta.annotations.values().any(|v| v.len() > 8192)
    {
        return Err(Status::invalid_argument(
            "provider metadata exceeds native gateway limits",
        ));
    }
    Ok(())
}
fn create_provider(
    state: &mut State,
    q: p::CreateProviderRequest,
) -> Result<p::ProviderResponse, Status> {
    let mut provider = q
        .provider
        .ok_or_else(|| Status::invalid_argument("missing"))?;
    let meta = provider
        .metadata
        .take()
        .ok_or_else(|| Status::invalid_argument("missing"))?;
    validate_provider_metadata(&meta)?;
    let key = format!("{}/{}", workspace(&q.workspace_scope)?, meta.name);
    if state.providers.contains_key(&key) {
        return Err(Status::already_exists("collision"));
    }
    let mut created_metadata =
        state.metadata(meta.name, workspace(&q.workspace_scope)?, meta.labels);
    created_metadata.annotations = meta.annotations;
    provider.metadata = Some(created_metadata);
    state.providers.insert(key, provider.clone());
    state.created_providers.push(provider.clone());
    state.created("provider");
    if std::mem::take(&mut state.lose_create) {
        return Err(Status::unavailable("lost create reply secret"));
    }
    // OpenShell reports credential names with their values redacted.
    for value in provider.credentials.values_mut() {
        *value = "REDACTED".into();
    }
    Ok(p::ProviderResponse {
        provider: Some(provider),
        ..Default::default()
    })
}
fn update_provider(
    state: &mut State,
    q: p::UpdateProviderRequest,
) -> Result<p::ProviderResponse, Status> {
    let mut provider = q
        .provider
        .ok_or_else(|| Status::invalid_argument("missing"))?;
    let meta = provider
        .metadata
        .as_mut()
        .ok_or_else(|| Status::invalid_argument("missing"))?;
    validate_provider_metadata(meta)?;
    let key = format!("{}/{}", workspace(&q.workspace_scope)?, meta.name);
    let prior = state
        .providers
        .get(&key)
        .ok_or_else(|| Status::not_found("absent"))?
        .metadata
        .as_ref()
        .unwrap();
    if meta.id != prior.id
        || meta.resource_version != prior.resource_version
        || meta.resource_version == 0
    {
        return Err(Status::aborted("version conflict"));
    }
    meta.workspace = prior.workspace.clone();
    meta.resource_version += 1;
    state.conditional_updates += 1;
    state.effects += 1;
    state.providers.insert(key, provider.clone());
    // OpenShell reports credential names with their values redacted.
    for value in provider.credentials.values_mut() {
        *value = "REDACTED".into();
    }
    Ok(p::ProviderResponse {
        provider: Some(provider),
        ..Default::default()
    })
}
/// Delete an empty workspace, as OpenShell refuses one that still holds objects.
fn delete_workspace(
    state: &mut State,
    q: p::DeleteWorkspaceRequest,
) -> Result<p::DeleteWorkspaceResponse, Status> {
    if !state.workspaces.contains_key(&q.name) {
        return Err(Status::not_found("absent"));
    }
    let prefix = format!("{}/", q.name);
    if state.sandboxes.keys().any(|key| key.starts_with(&prefix))
        || state.providers.keys().any(|key| key.starts_with(&prefix))
        || state.profiles.keys().any(|key| key.starts_with(&prefix))
    {
        return Err(Status::failed_precondition("workspace is not empty"));
    }
    state.workspaces.remove(&q.name);
    Ok(p::DeleteWorkspaceResponse {
        outcome: p::DeletionOutcome::Completed.into(),
    })
}
fn delete_provider(
    state: &mut State,
    q: &p::DeleteProviderRequest,
) -> Result<p::DeleteProviderResponse, Status> {
    let workspace = workspace(&q.workspace_scope)?;
    if !state
        .providers
        .contains_key(&format!("{workspace}/{}", q.name))
    {
        return Err(Status::not_found("absent"));
    }
    if state.sandboxes.values().any(|sandbox| {
        sandbox
            .metadata
            .as_ref()
            .is_some_and(|m| m.workspace == workspace)
            && sandbox
                .spec
                .as_ref()
                .is_some_and(|spec| spec.providers.contains(&q.name))
    }) {
        return Err(Status::failed_precondition(
            "provider is attached to a sandbox",
        ));
    }
    let deleted = state
        .providers
        .remove(&format!("{workspace}/{}", q.name))
        .is_some();
    if !deleted {
        return Err(Status::not_found("absent"));
    }
    state.effects += 1;
    if std::mem::take(&mut state.lose_delete) {
        return Err(Status::unavailable("lost delete reply secret"));
    }
    Ok(p::DeleteProviderResponse {
        outcome: p::DeletionOutcome::Completed.into(),
    })
}

#[derive(Clone)]
struct InferenceService(Service);
impl tonic::server::NamedService for InferenceService {
    const NAME: &'static str = "openshell.inference.v1.Inference";
}
impl tower::Service<http::Request<Body>> for InferenceService {
    type Response = http::Response<Body>;
    type Error = std::convert::Infallible;
    type Future = BoxFuture<Result<Self::Response, Self::Error>>;
    fn poll_ready(&mut self, cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        self.0.poll_ready(cx)
    }
    fn call(&mut self, request: http::Request<Body>) -> Self::Future {
        self.0.call(request)
    }
}
fn gateway_info(
    state: &mut State,
    _: p::GetGatewayInfoRequest,
) -> Result<p::GetGatewayInfoResponse, Status> {
    state.gateway_reads += 1;
    state.read("gateway")?;
    if let Some(info) = &state.gateway_info {
        return Ok(info.clone());
    }
    Ok(p::GetGatewayInfoResponse {
        gateway_version: serde_json::from_str::<serde_json::Value>(include_str!(
            "../../../versions.json"
        ))
        .unwrap()["openshell"]
            .as_str()
            .unwrap()
            .into(),
        compute_drivers: vec![p::ComputeDriverInfo {
            name: state.driver.clone().unwrap_or_else(|| "docker".into()),
            ..Default::default()
        }],
        ..Default::default()
    })
}
fn create_sandbox(
    state: &mut State,
    q: p::CreateSandboxRequest,
) -> Result<p::SandboxResponse, Status> {
    let key = format!("{}/{}", workspace(&q.workspace_scope)?, q.name);
    if state.sandboxes.contains_key(&key) {
        return Err(Status::already_exists("collision"));
    }
    // The gateway checks every exposure before it creates the sandbox.
    for exposure in &q.service_exposures {
        exposure_mode(exposure.target_port, exposure.authorization_mode)?;
    }
    state.sandbox_exposures.push(q.service_exposures.clone());
    let mut sandbox = p::Sandbox {
        metadata: Some(p::ObjectMeta {
            annotations: q.annotations,
            ..state.metadata(q.name, workspace(&q.workspace_scope)?, q.labels)
        }),
        spec: q.spec,
        status: Some(p::SandboxStatus {
            phase: state.sandbox_phase.unwrap_or(p::SandboxPhase::Ready) as i32,
            conditions: state.sandbox_conditions.clone(),
            configuration_admission: state.configuration_admission.clone(),
            ..Default::default()
        }),
        ..Default::default()
    };
    if let Some(admission) = &state.sandbox_admission {
        admission(&mut sandbox);
    }
    if let Some(execution) = &state.sandbox_execution {
        let mut credentials = HashMap::new();
        for name in &sandbox.spec.as_ref().unwrap().providers {
            let provider = state
                .providers
                .get(&format!("{}/{}", workspace(&q.workspace_scope)?, name))
                .ok_or_else(|| Status::failed_precondition("sandbox provider is absent"))?;
            credentials.extend(provider.credentials.clone());
        }
        execution.create(&sandbox, &credentials)?;
    }
    state.sandboxes.insert(key.clone(), sandbox.clone());
    state.created_sandboxes.push(sandbox.clone());
    if let Some((field, value)) = state.substitute_sandbox_after_create.take() {
        let metadata = state
            .sandboxes
            .get_mut(&key)
            .unwrap()
            .metadata
            .as_mut()
            .unwrap();
        if field == "id" {
            metadata.id = value;
        } else {
            metadata.labels.insert(field.into(), value);
        }
    }
    state.created("sandbox");
    // The gateway stores each exposure as ExposeService does and reports each
    // endpoint's URL. It routes services itself and has no application
    // origin, so each preferred URL is the gateway-routed one.
    let meta = sandbox.metadata.clone().unwrap();
    let mut service_urls = HashMap::new();
    for exposure in q.service_exposures {
        let url = store_service(
            state,
            &meta,
            exposure.service.clone(),
            exposure.target_port,
            exposure.authorization_mode,
        )?
        .url;
        service_urls.insert(exposure.service, url);
    }
    Ok(p::SandboxResponse {
        sandbox: Some(sandbox),
        gateway_service_urls: service_urls.clone(),
        service_urls,
        application_service_urls: HashMap::new(),
    })
}
fn get_sandbox(state: &mut State, q: &p::GetSandboxRequest) -> Result<p::SandboxResponse, Status> {
    state.read("sandbox")?;
    Ok(p::SandboxResponse {
        sandbox: Some(
            state
                .sandboxes
                .get(&format!("{}/{}", workspace(&q.workspace_scope)?, q.name))
                .ok_or_else(|| Status::not_found("absent"))?
                .clone(),
        ),
        ..Default::default()
    })
}
fn delete_sandbox(
    state: &mut State,
    q: &p::DeleteSandboxRequest,
) -> Result<p::DeleteSandboxResponse, Status> {
    let key = format!("{}/{}", workspace(&q.workspace_scope)?, q.name);
    let sandbox = state
        .sandboxes
        .get(&key)
        .ok_or_else(|| Status::not_found("absent"))?;
    if let Some(execution) = &state.sandbox_execution {
        execution.delete(sandbox)?;
    }
    let sandbox = state.sandboxes.remove(&key).unwrap();
    // The gateway removes a deleted sandbox's endpoints by its ID.
    let id = sandbox.metadata.as_ref().unwrap().id.clone();
    state
        .services
        .retain(|_, endpoint| endpoint.sandbox_id != id);
    state.effects += 1;
    if std::mem::take(&mut state.lose_delete) {
        return Err(Status::unavailable("secret-sentinel: deletion reply lost"));
    }
    Ok(p::DeleteSandboxResponse {
        outcome: p::DeletionOutcome::Completed.into(),
        sandbox_id: sandbox.metadata.unwrap().id,
    })
}
fn service_response(endpoint: p::ServiceEndpoint) -> p::ServiceEndpointResponse {
    let workspace = endpoint
        .metadata
        .as_ref()
        .map(|m| m.workspace.clone())
        .unwrap_or_default();
    let host = if endpoint.name.is_empty() {
        format!("{workspace}--{}", endpoint.sandbox)
    } else {
        format!("{workspace}--{}--{}", endpoint.sandbox, endpoint.name)
    };
    let url = format!("http://{host}.services.fixture.test/");
    p::ServiceEndpointResponse {
        endpoint: Some(endpoint),
        gateway_url: url.clone(),
        url,
        application_url: String::new(),
    }
}
fn get_service(
    state: &mut State,
    q: p::GetServiceRequest,
) -> Result<p::ServiceEndpointResponse, Status> {
    state.read("service")?;
    let workspace = workspace(&q.workspace_scope)?;
    if !state
        .sandboxes
        .contains_key(&format!("{workspace}/{}", q.sandbox))
    {
        return Err(Status::not_found("sandbox not found"));
    }
    let endpoint = state
        .services
        .get(&(workspace, q.sandbox, q.name))
        .ok_or_else(|| Status::not_found("service endpoint not found"))?
        .clone();
    Ok(service_response(endpoint))
}
/// A sandbox-scoped configuration update: a complete policy, or none. Without
/// one, the configured rewrite stands in for the interceptor that fills it.
fn update_config(
    state: &mut State,
    q: p::UpdateConfigRequest,
) -> Result<p::UpdateConfigResponse, Status> {
    let key = format!("{}/{}", workspace(&q.workspace_scope)?, q.sandbox);
    if q.global || !q.merge_operations.is_empty() {
        return Err(Status::unimplemented("only a sandbox-scoped update"));
    }
    state.config_updates.push(q.clone());
    if let Some(policy) = q.policy {
        return update_policy(state, &key, policy, q.annotations);
    }
    let rewrite = state.config_update.clone();
    let sandbox = state
        .sandboxes
        .get_mut(&key)
        .ok_or_else(|| Status::not_found("absent"))?;
    let rewrite = rewrite.ok_or_else(|| Status::failed_precondition("no policy to apply"))?;
    rewrite(sandbox);
    state.active_policy = None;
    Ok(p::UpdateConfigResponse::default())
}
/// A running sandbox's new policy, which keeps the settings it started with,
/// as OpenShell's check does: it may add filesystem paths, but not remove
/// any, and may not change Landlock or process settings. The gateway stores
/// it as the sandbox's next revision with the update's annotations, which it
/// also records on the sandbox.
fn update_policy(
    state: &mut State,
    key: &str,
    policy: p::SandboxPolicy,
    annotations: HashMap<String, String>,
) -> Result<p::UpdateConfigResponse, Status> {
    let sandbox = state
        .sandboxes
        .get_mut(key)
        .ok_or_else(|| Status::not_found("absent"))?;
    let created = sandbox
        .spec
        .as_ref()
        .and_then(|spec| spec.policy.clone())
        .unwrap_or_default();
    if created.landlock != policy.landlock {
        return Err(Status::invalid_argument(
            "landlock policy cannot be changed on a live sandbox (applied at startup)",
        ));
    }
    if created.process != policy.process {
        return Err(Status::invalid_argument(
            "process policy cannot be changed on a live sandbox (applied at startup)",
        ));
    }
    if let Some(started) = &created.filesystem {
        let kept = policy.filesystem.as_ref().is_some_and(|new| {
            new.include_workdir == started.include_workdir
                && started
                    .read_only
                    .iter()
                    .all(|path| new.read_only.contains(path))
                && started
                    .read_write
                    .iter()
                    .all(|path| new.read_write.contains(path))
        });
        if !kept {
            return Err(Status::invalid_argument(
                "filesystem paths cannot be removed on a live sandbox",
            ));
        }
    }
    let metadata = sandbox.metadata.as_mut().unwrap();
    metadata.annotations.extend(annotations);
    let annotations = metadata.annotations.clone();
    let revisions = state
        .policy_revisions
        .entry(metadata.id.clone())
        .or_default();
    let version = revisions.last().map_or(2, |revision| revision.version + 1);
    let policy_hash = policy_hash(&policy);
    revisions.push(p::SandboxPolicyRevision {
        version,
        policy_hash: policy_hash.clone(),
        policy: Some(policy),
        status: state
            .policy_loads
            .pop_front()
            .unwrap_or(p::PolicyStatus::Loaded) as i32,
        ..Default::default()
    });
    state.effects += 1;
    if std::mem::take(&mut state.lose_policy_update) {
        return Err(Status::unavailable("secret-sentinel: update reply lost"));
    }
    Ok(p::UpdateConfigResponse {
        version,
        policy_hash,
        annotations,
        ..Default::default()
    })
}
/// The policy a sandbox loads when it starts: the one it was created with,
/// plus a baseline path that OpenShell adds when the policy allows network
/// access.
fn started(created: &p::SandboxPolicy) -> p::SandboxPolicy {
    let mut policy = created.clone();
    if !policy.network_policies.is_empty()
        && let Some(fs) = &mut policy.filesystem
        && !fs
            .read_only
            .iter()
            .chain(&fs.read_write)
            .any(|p| p == "/var/log")
    {
        fs.read_only.push("/var/log".into());
    }
    policy
}
/// OpenShell's hash of a policy's content, which ignores the order of its
/// maps' entries.
fn policy_hash(policy: &p::SandboxPolicy) -> String {
    openshell_core::policy_identity::deterministic_policy_hash(policy)
}
/// The gateway exposes a live sandbox's service, or updates an exposed one in
/// place.
fn expose_service(
    state: &mut State,
    q: p::ExposeServiceRequest,
) -> Result<p::ServiceEndpointResponse, Status> {
    let workspace = workspace(&q.workspace_scope)?;
    let sandbox = state
        .sandboxes
        .get(&format!("{workspace}/{}", q.sandbox))
        .and_then(|sandbox| sandbox.metadata.clone())
        .ok_or_else(|| Status::not_found("sandbox not found"))?;
    store_service(state, &sandbox, q.name, q.target_port, q.authorization_mode)
}
/// The gateway checks an exposure's port and resolves its authorization mode,
/// an omitted one to STRIP, as OpenShell's `validate_service_exposure_request`
/// does.
fn exposure_mode(
    target_port: u32,
    authorization_mode: i32,
) -> Result<p::ServiceAuthorizationMode, Status> {
    if target_port == 0 || target_port > u32::from(u16::MAX) {
        return Err(Status::invalid_argument("target_port must be in 1..=65535"));
    }
    match p::ServiceAuthorizationMode::try_from(authorization_mode) {
        Ok(p::ServiceAuthorizationMode::Unspecified) => Ok(p::ServiceAuthorizationMode::Strip),
        Ok(mode) => Ok(mode),
        Err(_) => Err(Status::invalid_argument("authorization_mode is invalid")),
    }
}
/// The gateway stores a sandbox's service endpoint, at its creation or
/// through ExposeService, as OpenShell's `expose_service_endpoint` does; an
/// update keeps the endpoint's ID.
fn store_service(
    state: &mut State,
    sandbox: &p::ObjectMeta,
    name: String,
    target_port: u32,
    authorization_mode: i32,
) -> Result<p::ServiceEndpointResponse, Status> {
    let mode = exposure_mode(target_port, authorization_mode)?;
    let key = (
        sandbox.workspace.clone(),
        sandbox.name.clone(),
        name.clone(),
    );
    let metadata = match state.services.get(&key).and_then(|e| e.metadata.clone()) {
        Some(mut metadata) => {
            state.effects += 1;
            metadata.resource_version += 1;
            metadata
        }
        None => state.metadata(
            format!("{}--{name}", sandbox.name),
            sandbox.workspace.clone(),
            HashMap::from([("sandbox".into(), sandbox.name.clone())]),
        ),
    };
    let endpoint = p::ServiceEndpoint {
        metadata: Some(metadata),
        sandbox_id: sandbox.id.clone(),
        sandbox: sandbox.name.clone(),
        name,
        target_port,
        domain: true,
        authorization_mode: mode as i32,
    };
    state.services.insert(key, endpoint.clone());
    Ok(service_response(endpoint))
}
/// The gateway removes one service endpoint; with `allow_missing`, an absent
/// endpoint is already gone rather than an error.
fn delete_service(
    state: &mut State,
    q: p::DeleteServiceRequest,
) -> Result<p::DeleteServiceResponse, Status> {
    let workspace = workspace(&q.workspace_scope)?;
    let outcome = if state
        .services
        .remove(&(workspace, q.sandbox, q.name))
        .is_some()
    {
        state.effects += 1;
        p::DeletionOutcome::Completed
    } else if q.allow_missing {
        p::DeletionOutcome::AlreadyAbsent
    } else {
        return Err(Status::not_found("service endpoint not found"));
    };
    Ok(p::DeleteServiceResponse {
        outcome: outcome.into(),
    })
}
fn policy_status(
    state: &mut State,
    q: &p::GetSandboxPolicyStatusRequest,
) -> Result<p::GetSandboxPolicyStatusResponse, Status> {
    state.read("policy")?;
    let sandbox = state
        .sandboxes
        .get(&format!("{}/{}", workspace(&q.workspace_scope)?, q.sandbox))
        .ok_or_else(|| Status::not_found("absent"))?;
    // The latest revision an update stored, with the last one the sandbox
    // loaded as its active version.
    let revisions = state
        .policy_revisions
        .get(&sandbox.metadata.as_ref().unwrap().id)
        .filter(|_| state.active_policy.is_none());
    if let Some(latest) = revisions.and_then(|revisions| revisions.last()) {
        let active_version = revisions
            .into_iter()
            .flatten()
            .filter(|revision| revision.status == p::PolicyStatus::Loaded as i32)
            .map(|revision| revision.version)
            .max()
            .unwrap_or(1);
        return Ok(p::GetSandboxPolicyStatusResponse {
            active_version,
            revision: Some(latest.clone()),
        });
    }
    let policy = state
        .active_policy
        .clone()
        .or_else(|| sandbox.spec.as_ref().unwrap().policy.as_ref().map(started));
    let policy_hash = policy.as_ref().map(policy_hash).unwrap_or_default();
    Ok(p::GetSandboxPolicyStatusResponse {
        active_version: 1,
        revision: Some(p::SandboxPolicyRevision {
            version: 1,
            policy_hash,
            policy,
            status: p::PolicyStatus::Loaded as i32,
            ..Default::default()
        }),
    })
}
struct Exec(Arc<Mutex<State>>);
impl tonic::server::ServerStreamingService<p::ExecSandboxRequest> for Exec {
    type Response = p::ExecSandboxEvent;
    type ResponseStream =
        Pin<Box<dyn tokio_stream::Stream<Item = Result<p::ExecSandboxEvent, Status>> + Send>>;
    type Future = std::future::Ready<Result<Response<Self::ResponseStream>, Status>>;
    fn call(&mut self, request: Request<p::ExecSandboxRequest>) -> Self::Future {
        let request = request.into_inner();
        let mut state = self.0.lock().unwrap();
        let scope = match workspace(&request.workspace_scope) {
            Ok(scope) => scope,
            Err(error) => return std::future::ready(Err(error)),
        };
        let Some(sandbox) = state.sandboxes.get(&format!("{scope}/{}", request.sandbox)) else {
            return std::future::ready(Err(Status::not_found("absent")));
        };
        if let Some(execution) = state.sandbox_execution.clone() {
            state.exec_calls.push(request.command.clone());
            state.exec_sandboxes.push(request.sandbox.clone());
            state.exec_stdin.push(request.stdin.clone());
            state.exec_environments.push(request.environment.clone());
            drop(state);
            let output = match execution.exec(&request) {
                Ok(output) => output,
                Err(error) => return std::future::ready(Err(error)),
            };
            let mut events = Vec::new();
            for data in output.stdout.chunks(64 * 1024) {
                events.push(Ok(p::ExecSandboxEvent {
                    payload: Some(p::exec_sandbox_event::Payload::Stdout(
                        p::ExecSandboxStdout {
                            data: data.to_vec(),
                        },
                    )),
                }));
            }
            for data in output.stderr.chunks(64 * 1024) {
                events.push(Ok(p::ExecSandboxEvent {
                    payload: Some(p::exec_sandbox_event::Payload::Stderr(
                        p::ExecSandboxStderr {
                            data: data.to_vec(),
                        },
                    )),
                }));
            }
            events.push(Ok(p::ExecSandboxEvent {
                payload: Some(p::exec_sandbox_event::Payload::Exit(p::ExecSandboxExit {
                    exit_code: output.status.code().unwrap_or(1),
                })),
            }));
            return std::future::ready(Ok(Response::new(Box::pin(tokio_stream::iter(events)))));
        }
        let sandbox_id = sandbox.metadata.as_ref().unwrap().id.clone();
        let launch = &sandbox.spec.as_ref().unwrap().command;
        // The launch is `fabric-agent-ctl serve`; operations replace `serve`.
        let operation_index = launch.len() - 1;
        let is_bridge = request.command.starts_with(&launch[..operation_index]);

        if state.exec_stalled {
            return std::future::ready(Ok(Response::new(Box::pin(tokio_stream::pending()))));
        }
        let mut events = Vec::new();
        let mut exit = state.exec_exit;
        let mut output = state.exec_response.clone();
        if is_bridge {
            let operation = request
                .command
                .get(operation_index)
                .map(String::as_str)
                .unwrap_or("");
            let flag = |name: &str| {
                request
                    .command
                    .windows(2)
                    .find(|args| args[0] == name)
                    .map(|args| args[1].as_str())
            };
            let failure = |code: &str, stage: &str, effects: &str| serde_json::json!({"code":code, "stage":stage, "message":"fixture failure", "effects":effects});
            let requested_runtime = flag("--runtime-id").map(str::to_owned);
            let running = requested_runtime
                .as_ref()
                .is_some_and(|id| state.fabric_runtimes.get(id) == Some(&sandbox_id));
            let failed = requested_runtime
                .as_ref()
                .is_some_and(|id| state.fabric_failed.contains(id));
            let held = state
                .fabric_runtimes
                .iter()
                .any(|(id, sandbox)| sandbox == &sandbox_id && state.fabric_failed.contains(id));
            let mut error = None;
            let mut changed = None;
            let mut result = serde_json::Value::Null;
            match operation {
                // Like fabric-agent-ctl: a sandbox may run several runtimes,
                // but Fabric refuses a start after one with unknown effects.
                "start" => {
                    if state.host_unavailable_starts > 0 {
                        state.host_unavailable_starts -= 1;
                        error = Some(failure("host_unavailable", "transport", "none"));
                    } else if state.fabric_uncertain.contains(&sandbox_id) {
                        error = Some(failure("start_uncertain", "start", "none"));
                    } else if held {
                        // A failed runtime's processes still hold the agent's
                        // kept state, which Fabric refuses with no effects, or
                        // without it, OpenClaw's Gateway ports, which fail the
                        // start with unknown effects.
                        let config = serde_json::from_slice::<serde_json::Value>(&request.stdin)
                            .unwrap_or_default();
                        if config["runtime"]["keep_state"] == true {
                            error = Some(failure("state_in_use", "start", "none"));
                        } else {
                            state.fabric_uncertain.insert(sandbox_id.clone());
                            error = Some(failure("start_failed", "start", "unknown"));
                        }
                    } else if state.state_in_use_starts > 0 {
                        state.state_in_use_starts -= 1;
                        error = Some(failure("state_in_use", "start", "none"));
                    } else if let Some(config) = (flag("--config") == Some("-"))
                        .then(|| serde_json::from_slice::<serde_json::Value>(&request.stdin).ok())
                        .flatten()
                    {
                        if let Some(rejected) = state
                            .configuration_error_for
                            .get(&request.sandbox)
                            .or(state.configuration_error.as_ref())
                            .cloned()
                        {
                            let code = rejected["error"]["code"].as_str().unwrap_or("start_failed");
                            // Fabric rejects an invalid configuration before
                            // starting anything; any other failed start may
                            // have left a runtime behind.
                            let effects = if code.starts_with("validation_") {
                                "none"
                            } else {
                                "unknown"
                            };
                            if effects != "none" {
                                state.fabric_uncertain.insert(sandbox_id.clone());
                            }
                            let mut rejection = failure(
                                code,
                                rejected["error"]["stage"].as_str().unwrap_or("start"),
                                effects,
                            );
                            // Fabric's own message, which can repeat what
                            // the harness printed.
                            if let Some(message) = rejected["error"]["message"].as_str() {
                                rejection["message"] = message.into();
                            }
                            error = Some(rejection);
                        } else {
                            let starts = state.fabric_starts.entry(sandbox_id.clone()).or_default();
                            let runtime_id = match *starts {
                                0 => format!("fixture-runtime-{sandbox_id}"),
                                n => format!("fixture-runtime-{sandbox_id}-{n}"),
                            };
                            *starts += 1;
                            state
                                .fabric_runtimes
                                .insert(runtime_id.clone(), sandbox_id.clone());
                            result = serde_json::json!({
                                "runtime_id": runtime_id,
                                "agent_name": flag("--agent"),
                                "adapter_id": config["harness"]["adapter_id"],
                            });
                            state
                                .fabric_configurations
                                .insert(sandbox_id.clone(), config);
                            changed = Some(true);
                        }
                    } else {
                        error = Some(failure("invalid_request", "request", "none"));
                    }
                }
                "invoke" => {
                    if running && !failed {
                        let input = serde_json::from_slice::<serde_json::Value>(&request.stdin)
                            .unwrap_or(serde_json::Value::Null);
                        result =
                            serde_json::json!({"status":"succeeded", "output":{"message":input}});
                    } else {
                        error = Some(failure("runtime_unavailable", "invoke", "none"));
                    }
                }
                "stop" => {
                    if running
                        && requested_runtime
                            .as_ref()
                            .is_some_and(|id| state.busy_runtimes.contains(id))
                    {
                        error = Some(failure("runtime_busy", "stop", "none"));
                    } else if let Some(runtime_id) = requested_runtime.filter(|_| running) {
                        state.fabric_runtimes.remove(&runtime_id);
                        state.fabric_failed.remove(&runtime_id);
                        state.fabric_stopped.insert(sandbox_id.clone());
                        if !state.fabric_runtimes.values().any(|id| id == &sandbox_id) {
                            state.fabric_configurations.remove(&sandbox_id);
                        }
                        changed = Some(true);
                    } else {
                        error = Some(failure("runtime_unavailable", "stop", "none"));
                    }
                }
                // Like fabric-agent-ctl: a server check passes once `serve`
                // answers; a runtime check reports the runtime's health in its
                // report, which a failed check keeps.
                "check" => {
                    changed = Some(false);
                    let reason = match &requested_runtime {
                        None => None,
                        Some(_) if !running || failed => Some("runtime_unavailable".to_owned()),
                        Some(_) => state.fabric_check_reason.clone(),
                    };
                    let outcome = match reason.as_deref() {
                        None => "passed",
                        Some(reason) if reason.starts_with("unsupported_") => "unsupported",
                        Some("runtime_unavailable" | "probe_timeout" | "probe_error") => "unknown",
                        Some(_) => "failed",
                    };
                    result = serde_json::json!({
                        "schema_version": "fabric.check/v1alpha1",
                        "scope": if requested_runtime.is_some() { "runtime" } else { "server" },
                        "runtime_id": requested_runtime,
                        "outcome": outcome,
                        "reason_code": reason,
                    });
                    error = reason.map(|reason| failure(&reason, "check", "none"));
                }
                _ => error = Some(failure("invalid_request", "request", "none")),
            }
            if state.exec_exit != 0 {
                error.get_or_insert_with(|| failure("fixture_failed", operation, "unknown"));
            } else {
                exit = i32::from(error.is_some());
            }
            if error.is_some() && operation != "check" {
                result = serde_json::Value::Null;
            }
            let status = if result["outcome"] == "unsupported" {
                "unsupported"
            } else if error.is_some() {
                "failed"
            } else {
                "succeeded"
            };
            if state.exec_response.is_none() {
                let mut bytes = serde_json::to_vec(&serde_json::json!({"operation":operation,"status":status,"changed":changed,"result":result,"error":error})).unwrap();
                bytes.push(b'\n');
                output = Some(bytes);
            }
        }
        if let Some(data) = output {
            // Match the real streaming transport instead of hiding the caller's
            // output cap behind one oversized protobuf message.
            for chunk in data.chunks(64 * 1024) {
                events.push(Ok(p::ExecSandboxEvent {
                    payload: Some(p::exec_sandbox_event::Payload::Stdout(
                        p::ExecSandboxStdout {
                            data: chunk.to_vec(),
                        },
                    )),
                }));
            }
        }
        let truncated = state.exec_truncated
            || (is_bridge
                && request
                    .command
                    .get(operation_index)
                    .is_some_and(|operation| operation == "start")
                && std::mem::take(&mut state.lose_start_reply));
        state.exec_environments.push(request.environment);
        state.exec_stdin.push(request.stdin);
        state.exec_calls.push(request.command);
        state.exec_sandboxes.push(request.sandbox);
        if !truncated {
            events.push(Ok(p::ExecSandboxEvent {
                payload: Some(p::exec_sandbox_event::Payload::Exit(p::ExecSandboxExit {
                    exit_code: exit,
                })),
            }));
        }
        std::future::ready(Ok(Response::new(Box::pin(tokio_stream::iter(events)))))
    }
}

fn get_profile(
    state: &mut State,
    q: p::GetProviderProfileRequest,
) -> Result<p::ProviderProfileResponse, Status> {
    state.read("provider_profile")?;
    Ok(p::ProviderProfileResponse {
        profile: Some(
            state
                .profiles
                .get(&format!("{}/{}", workspace(&q.workspace_scope)?, q.id))
                .ok_or_else(|| Status::not_found("absent"))?
                .clone(),
        ),
    })
}
fn import_profiles(
    state: &mut State,
    q: p::ImportProviderProfilesRequest,
) -> Result<p::ImportProviderProfilesResponse, Status> {
    let mut profiles = vec![];
    for item in q.profiles {
        let mut profile = item
            .profile
            .ok_or_else(|| Status::invalid_argument("missing profile"))?;
        let key = format!("{}/{}", workspace(&q.workspace_scope)?, profile.id);
        if state.profiles.contains_key(&key) {
            return Err(Status::already_exists("collision"));
        }
        profile.resource_version = 1;
        profile.source = "user".into();
        profile.scope = "workspace".into();
        state.effects += 1;
        state.profiles.insert(key, profile.clone());
        // Import replies lack the catalog decoration added by GetProviderProfile.
        profile.source.clear();
        profile.scope.clear();
        profiles.push(profile);
    }
    state.created("provider_profile");
    if state.lose_create {
        state.lose_create = false;
        return Err(Status::unavailable("lost reply"));
    }
    Ok(p::ImportProviderProfilesResponse {
        imported: true,
        profiles,
        ..Default::default()
    })
}
fn delete_profile(
    state: &mut State,
    q: p::DeleteProviderProfileRequest,
) -> Result<p::DeleteProviderProfileResponse, Status> {
    let scope = workspace(&q.workspace_scope)?;
    if !state.profiles.contains_key(&format!("{}/{}", scope, q.id)) {
        return Err(Status::not_found("absent"));
    }
    // The pinned gateway refuses deletion while a registration uses the profile.
    if state
        .providers
        .values()
        .any(|provider| provider.profile_workspace == scope && provider.r#type == q.id)
    {
        return Err(Status::failed_precondition("profile is in use"));
    }
    let deleted = state
        .profiles
        .remove(&format!("{}/{}", scope, q.id))
        .is_some();
    if state.lose_delete {
        state.lose_delete = false;
        return Err(Status::unavailable("lost reply"));
    }
    if !deleted {
        return Err(Status::not_found("absent"));
    }
    Ok(p::DeleteProviderProfileResponse {
        outcome: p::DeletionOutcome::Completed.into(),
    })
}

/// One of the openshell provider's contract fixtures as the backend rows
/// OpenTofu sends for its resources, in apply order: the workspace, provider
/// profiles, provider registrations, then sandboxes. Backend tests in the
/// provider crates start from these instead of the SDK's compiled targets.
pub fn contract_rows(
    name: &str,
) -> Vec<(&'static str, std::collections::BTreeMap<String, String>)> {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../openshell-provider/tests/contract/fixtures")
        .join(format!("{name}.tf.json"));
    let fixture: serde_json::Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    let workspace = fixture["resource"]["openshell_workspace"]
        .as_object()
        .and_then(|bodies| bodies.values().next())
        .and_then(|body| body["name"].as_str())
        .unwrap()
        .to_owned();
    let owner = fixture["resource"]["openshell_workspace"]
        .as_object()
        .and_then(|bodies| bodies.values().next())
        .and_then(|body| body["owner"].as_str())
        .unwrap_or_default()
        .to_owned();
    let mut rows = Vec::new();
    // Inference and API resources expand to the profile and registration
    // they own; registrations follow every profile.
    let mut registrations = Vec::new();
    for kind in ["workspace", "inference", "api", "sandbox"] {
        if kind == "sandbox" {
            rows.append(&mut registrations);
        }
        let resource = nemoclaw_openshell::resource_type(kind).unwrap();
        let structured = nemoclaw_openshell::structured_inputs(kind);
        let references = nemoclaw_openshell::references(kind);
        // A ref expression names another fixture resource; rows carry its name.
        let referenced_name = |expression: &serde_json::Value| -> String {
            let address = expression
                .as_str()
                .and_then(|text| text.strip_prefix("${"))
                .and_then(|text| text.strip_suffix(".ref}"))
                .unwrap_or_else(|| panic!("{name}: {expression} is not a ref"));
            let (kind, label) = address.split_once('.').unwrap();
            fixture["resource"][kind][label]["name"]
                .as_str()
                .unwrap()
                .to_owned()
        };
        for body in fixture["resource"][&resource]
            .as_object()
            .into_iter()
            .flat_map(|bodies| bodies.values())
        {
            let mut row = std::collections::BTreeMap::new();
            for (attribute, value) in body.as_object().unwrap() {
                if matches!(attribute.as_str(), "depends_on" | "lifecycle") {
                    continue;
                }
                if let Some(reference) = references
                    .iter()
                    .find(|reference| reference.attribute == attribute)
                {
                    // Generated graphs pass a server as a literal ref.
                    if reference.kind == nemoclaw_openshell::INFERENCE_SERVER_TYPE {
                        for (attribute, field) in &reference.fields {
                            let text = value[*attribute].as_str().unwrap_or_default();
                            row.insert((*field).into(), text.replace("$${", "${"));
                        }
                        continue;
                    }
                    // These rows reach a gateway client directly, which never
                    // sees the connection the resource adapter carries.
                    if reference.kind == nemoclaw_openshell::GATEWAY_TYPE {
                        assert_eq!(
                            value["type"],
                            nemoclaw_openshell::GATEWAY_TYPE,
                            "{name}: {value} is not a gateway ref"
                        );
                        continue;
                    }
                    let field = reference.fields[0].1;
                    let carried = if reference.list {
                        let names: Vec<_> = value
                            .as_array()
                            .unwrap()
                            .iter()
                            .map(referenced_name)
                            .collect();
                        serde_json::to_string(&names).unwrap()
                    } else {
                        referenced_name(value)
                    };
                    row.insert(field.into(), carried);
                    if reference.fields.iter().any(|(_, field)| *field == "owner") {
                        row.insert("owner".into(), owner.clone());
                    }
                    continue;
                }
                if let Some(input) = structured.iter().find(|input| input.attribute == attribute) {
                    if let Some(encoded) = input.row_value(value.clone()).unwrap() {
                        row.insert(input.field.into(), encoded);
                    }
                    continue;
                }
                let text = value
                    .as_str()
                    .unwrap_or_else(|| panic!("{name}: {attribute} is not a string"))
                    .replace("${openshell_workspace.deployment.name}", &workspace)
                    .replace("$${", "${");
                row.insert(attribute.clone(), text);
            }
            let pair = match kind {
                "inference" => nemoclaw_openshell::pairs::inference_rows(&row),
                "api" => Some(nemoclaw_openshell::pairs::api_rows(&row)),
                _ => {
                    rows.push((kind, row));
                    continue;
                }
            };
            let (profile, registration) = pair.unwrap_or_else(|| panic!("{name}: invalid {kind}"));
            rows.push(("provider_profile", profile));
            registrations.push(("provider", registration));
        }
    }
    rows
}
