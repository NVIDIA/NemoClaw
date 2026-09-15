// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use openshell_core::proto as p;
use std::{
    collections::HashMap,
    future::Future,
    pin::Pin,
    sync::{Arc, Mutex},
    task::{Context, Poll},
};
use tonic::{Request, Response, Status, body::Body};

#[derive(Default)]
pub struct State {
    pub driver: Option<String>,
    pub workspaces: HashMap<String, p::Workspace>,
    pub providers: HashMap<String, p::Provider>,
    pub routes: HashMap<String, p::SetInferenceRouteRequest>,
    pub sandboxes: HashMap<String, p::Sandbox>,
    pub active_policy: Option<p::SandboxPolicy>,
    pub exec_exit: i32,
    pub inference_exit: i32,
    pub exec_truncated: bool,
    pub exec_stalled: bool,
    pub exec_calls: Vec<Vec<String>>,
    pub effects: usize,
    pub expected_bearer: Option<String>,
    pub conditional_updates: usize,
    pub lose_create: bool,
    pub fail_after_create: Option<(&'static str, tonic::Code)>,
    pub lose_delete: bool,
    pub delete_delay: std::time::Duration,
    pub delete_calls: usize,
    pub fail_read: Option<(&'static str, tonic::Code)>,
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
                .serve_with_incoming(tokio_stream::wrappers::TcpListenerStream::new(listener))
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
                "/openshell.v1.OpenShell/CreateSandbox" => {
                    unary(request, state, create_sandbox).await
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
                "/openshell.inference.v1.Inference/GetInferenceRoute" => {
                    unary(request, state, get_route).await
                }
                "/openshell.inference.v1.Inference/SetInferenceRoute" => {
                    unary(request, state, set_route).await
                }
                "/openshell.inference.v1.Inference/DeleteInferenceRoute" => {
                    unary(request, state, |state, request| {
                        delete_route(state, &request)
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
fn get_provider(
    state: &mut State,
    q: &p::GetProviderRequest,
) -> Result<p::ProviderResponse, Status> {
    state.read("provider")?;
    let mut provider = state
        .providers
        .get(&format!("{}/{}", q.workspace, q.name))
        .ok_or_else(|| Status::not_found("absent"))?
        .clone();
    provider.credentials.clear();
    Ok(p::ProviderResponse {
        provider: Some(provider),
    })
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
    let key = format!("{}/{}", q.workspace, meta.name);
    if state.providers.contains_key(&key) {
        return Err(Status::already_exists("collision"));
    }
    provider.metadata = Some(state.metadata(meta.name, q.workspace, meta.labels));
    state.providers.insert(key, provider.clone());
    state.created("provider");
    if std::mem::take(&mut state.lose_create) {
        return Err(Status::unavailable("lost create reply secret"));
    }
    provider.credentials.clear();
    Ok(p::ProviderResponse {
        provider: Some(provider),
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
    let key = format!("{}/{}", q.workspace, meta.name);
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
    meta.resource_version += 1;
    state.conditional_updates += 1;
    state.effects += 1;
    state.providers.insert(key, provider.clone());
    provider.credentials.clear();
    Ok(p::ProviderResponse {
        provider: Some(provider),
    })
}
fn delete_provider(
    state: &mut State,
    q: &p::DeleteProviderRequest,
) -> Result<p::DeleteProviderResponse, Status> {
    let deleted = state
        .providers
        .remove(&format!("{}/{}", q.workspace, q.name))
        .is_some();
    if !deleted {
        return Err(Status::not_found("absent"));
    }
    state.effects += 1;
    if std::mem::take(&mut state.lose_delete) {
        return Err(Status::unavailable("lost delete reply secret"));
    }
    Ok(p::DeleteProviderResponse { deleted })
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
    Ok(p::GetGatewayInfoResponse {
        gateway_version: "0.0.116".into(),
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
    let key = format!("{}/{}", q.workspace, q.name);
    if state.sandboxes.contains_key(&key) {
        return Err(Status::already_exists("collision"));
    }
    let sandbox = p::Sandbox {
        metadata: Some(state.metadata(q.name, q.workspace, q.labels)),
        spec: q.spec,
        status: Some(p::SandboxStatus {
            phase: p::SandboxPhase::Ready as i32,
            ..Default::default()
        }),
    };
    state.sandboxes.insert(key, sandbox.clone());
    state.created("sandbox");
    Ok(p::SandboxResponse {
        sandbox: Some(sandbox),
    })
}
fn get_sandbox(state: &mut State, q: &p::GetSandboxRequest) -> Result<p::SandboxResponse, Status> {
    state.read("sandbox")?;
    Ok(p::SandboxResponse {
        sandbox: Some(
            state
                .sandboxes
                .get(&format!("{}/{}", q.workspace, q.name))
                .ok_or_else(|| Status::not_found("absent"))?
                .clone(),
        ),
    })
}
fn delete_sandbox(
    state: &mut State,
    q: &p::DeleteSandboxRequest,
) -> Result<p::DeleteSandboxResponse, Status> {
    let deleted = state
        .sandboxes
        .remove(&format!("{}/{}", q.workspace, q.name))
        .is_some();
    if deleted {
        state.effects += 1;
    }
    Ok(p::DeleteSandboxResponse { deleted })
}
fn policy_status(
    state: &mut State,
    q: &p::GetSandboxPolicyStatusRequest,
) -> Result<p::GetSandboxPolicyStatusResponse, Status> {
    state.read("policy")?;
    let sandbox = state
        .sandboxes
        .get(&format!("{}/{}", q.workspace, q.name))
        .ok_or_else(|| Status::not_found("absent"))?;
    Ok(p::GetSandboxPolicyStatusResponse {
        active_version: 1,
        revision: Some(p::SandboxPolicyRevision {
            version: 1,
            policy: state
                .active_policy
                .clone()
                .or_else(|| sandbox.spec.as_ref().unwrap().policy.clone()),
            status: p::PolicyStatus::Loaded as i32,
            ..Default::default()
        }),
    })
}
fn get_route(
    state: &mut State,
    q: p::GetInferenceRouteRequest,
) -> Result<p::GetInferenceRouteResponse, Status> {
    state.read("route")?;
    let route = state
        .routes
        .get(&q.workspace)
        .ok_or_else(|| Status::not_found("absent"))?;
    Ok(p::GetInferenceRouteResponse {
        provider_name: route.provider_name.clone(),
        model_id: route.model_id.clone(),
        timeout_secs: route.timeout_secs,
        workspace: q.workspace,
        ..Default::default()
    })
}
fn set_route(
    state: &mut State,
    q: p::SetInferenceRouteRequest,
) -> Result<p::SetInferenceRouteResponse, Status> {
    let response = p::SetInferenceRouteResponse {
        provider_name: q.provider_name.clone(),
        model_id: q.model_id.clone(),
        timeout_secs: q.timeout_secs,
        workspace: q.workspace.clone(),
        ..Default::default()
    };
    state.routes.insert(q.workspace.clone(), q);
    state.created("route");
    state.effects += 1;
    Ok(response)
}
fn delete_route(
    state: &mut State,
    q: &p::DeleteInferenceRouteRequest,
) -> Result<p::DeleteInferenceRouteResponse, Status> {
    let deleted = state.routes.remove(&q.workspace).is_some();
    if deleted {
        state.effects += 1;
    }
    Ok(p::DeleteInferenceRouteResponse { deleted })
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
        if !state.sandboxes.values().any(|sandbox| {
            sandbox
                .metadata
                .as_ref()
                .is_some_and(|m| m.id == request.sandbox_id)
        }) {
            return std::future::ready(Err(Status::not_found("absent")));
        }
        if state.exec_stalled {
            return std::future::ready(Ok(Response::new(Box::pin(tokio_stream::pending()))));
        }
        let mut events = Vec::new();
        if request.command.first().is_some_and(|c| c == "openclaw") {
            events.push(Ok(p::ExecSandboxEvent {
                payload: Some(p::exec_sandbox_event::Payload::Stdout(
                    p::ExecSandboxStdout {
                        data: br#"{"status":"ok","result":{"payloads":[{"text":"FOUR"}]}}"#
                            .to_vec(),
                    },
                )),
            }));
        }
        if request.command.iter().any(|arg| arg == "probe")
            && request.command.last().is_some_and(|arg| arg == "hermes")
        {
            events.push(Ok(p::ExecSandboxEvent {
                payload: Some(p::exec_sandbox_event::Payload::Stdout(
                    p::ExecSandboxStdout {
                        data: br#"{"status":"succeeded","output":{"response":"FOUR"}}"#.to_vec(),
                    },
                )),
            }));
        }
        let exit = if request.command.iter().any(|arg| {
            arg.contains("fetch('https://inference.local/") || arg.ends_with("/pi-probe.js")
        }) {
            state.inference_exit
        } else {
            state.exec_exit
        };
        state.exec_calls.push(request.command);
        if !state.exec_truncated {
            events.push(Ok(p::ExecSandboxEvent {
                payload: Some(p::exec_sandbox_event::Payload::Exit(p::ExecSandboxExit {
                    exit_code: exit,
                })),
            }));
        }
        std::future::ready(Ok(Response::new(Box::pin(tokio_stream::iter(events)))))
    }
}
