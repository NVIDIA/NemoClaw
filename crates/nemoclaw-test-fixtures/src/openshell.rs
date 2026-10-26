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

#[derive(Default)]
pub struct State {
    pub sandbox_execution: Option<Arc<dyn SandboxExecution>>,
    pub driver: Option<String>,
    pub gateway_info: Option<p::GetGatewayInfoResponse>,
    pub gateway_reads: usize,
    pub health_reads: usize,
    pub workspaces: HashMap<String, p::Workspace>,
    pub profiles: HashMap<String, p::ProviderProfile>,
    pub providers: HashMap<String, p::Provider>,
    pub sandboxes: HashMap<String, p::Sandbox>,
    pub active_policy: Option<p::SandboxPolicy>,
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
    pub fail_read: Option<(&'static str, tonic::Code)>,
    /// Reject one RPC before its handler can mutate fixture state.
    pub reject_rpc: Option<(&'static str, tonic::Code, String)>,
    pub rejected_rpcs: Vec<String>,
    /// Sandbox service endpoints by workspace, sandbox, and service name.
    pub services: std::collections::BTreeMap<(String, String, String), p::ServiceEndpoint>,
    /// The exposures each CreateSandbox request carried, as sent.
    pub sandbox_exposures: Vec<Vec<p::SandboxServiceExposure>>,
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
    state.sandbox_exposures.push(q.service_exposures.clone());
    let sandbox = p::Sandbox {
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
    // The gateway stores each exposure as an endpoint, resolving an omitted
    // authorization mode to STRIP, and reports each endpoint's URL.
    let mut service_urls = HashMap::new();
    for exposure in q.service_exposures {
        let meta = sandbox.metadata.as_ref().unwrap();
        let mode = match p::ServiceAuthorizationMode::try_from(exposure.authorization_mode) {
            Ok(p::ServiceAuthorizationMode::Unspecified) => p::ServiceAuthorizationMode::Strip,
            Ok(mode) => mode,
            Err(_) => return Err(Status::invalid_argument("authorization_mode is invalid")),
        };
        let endpoint = p::ServiceEndpoint {
            metadata: Some(state.metadata(
                format!("{}--{}", meta.name, exposure.service),
                meta.workspace.clone(),
                HashMap::from([("sandbox".into(), meta.name.clone())]),
            )),
            sandbox_id: meta.id.clone(),
            sandbox: meta.name.clone(),
            name: exposure.service.clone(),
            target_port: exposure.target_port,
            domain: true,
            authorization_mode: mode as i32,
        };
        service_urls.insert(exposure.service, service_response(endpoint.clone()).url);
        state.services.insert(
            (
                meta.workspace.clone(),
                meta.name.clone(),
                endpoint.name.clone(),
            ),
            endpoint,
        );
    }
    Ok(p::SandboxResponse {
        sandbox: Some(sandbox),
        service_urls,
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
    p::ServiceEndpointResponse {
        endpoint: Some(endpoint),
        url: format!("http://{host}.services.fixture.test/"),
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
fn policy_status(
    state: &mut State,
    q: &p::GetSandboxPolicyStatusRequest,
) -> Result<p::GetSandboxPolicyStatusResponse, Status> {
    state.read("policy")?;
    let sandbox = state
        .sandboxes
        .get(&format!("{}/{}", workspace(&q.workspace_scope)?, q.sandbox))
        .ok_or_else(|| Status::not_found("absent"))?;
    let policy = state.active_policy.clone().or_else(|| {
        let mut policy = sandbox.spec.as_ref().unwrap().policy.clone()?;
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
        Some(policy)
    });
    // Like OpenShell's, the hash identifies the loaded policy's content.
    let policy_hash = policy
        .as_ref()
        .map(|policy| {
            use std::hash::{Hash, Hasher};
            let mut hasher = std::hash::DefaultHasher::new();
            prost::Message::encode_to_vec(policy).hash(&mut hasher);
            format!("fixture:{:016x}", hasher.finish())
        })
        .unwrap_or_default();
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
                        error = Some(failure("runtime_exists", "start", "none"));
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
                    if running {
                        let input = serde_json::from_slice::<serde_json::Value>(&request.stdin)
                            .unwrap_or(serde_json::Value::Null);
                        result =
                            serde_json::json!({"status":"succeeded", "output":{"message":input}});
                    } else {
                        error = Some(failure("runtime_unavailable", "invoke", "none"));
                    }
                }
                "stop" => {
                    if let Some(runtime_id) = requested_runtime.filter(|_| running) {
                        state.fabric_runtimes.remove(&runtime_id);
                        state.fabric_stopped.insert(sandbox_id.clone());
                        if !state.fabric_runtimes.values().any(|id| id == &sandbox_id) {
                            state.fabric_configurations.remove(&sandbox_id);
                        }
                        changed = Some(true);
                    } else {
                        error = Some(failure("runtime_unavailable", "stop", "none"));
                    }
                }
                _ => error = Some(failure("invalid_request", "request", "none")),
            }
            if state.exec_exit != 0 {
                error.get_or_insert_with(|| failure("fixture_failed", operation, "unknown"));
            } else {
                exit = i32::from(error.is_some());
            }
            if error.is_some() {
                result = serde_json::Value::Null;
            }
            let status = if error.is_some() {
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
    // Inference and web search resources expand to the profile and
    // registration they own; registrations follow every profile.
    let mut registrations = Vec::new();
    for kind in ["workspace", "inference", "web_search", "sandbox"] {
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
                "web_search" => nemoclaw_openshell::pairs::web_search_rows(&row),
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
