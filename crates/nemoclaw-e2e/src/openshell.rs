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
    pub workspaces: HashMap<String, p::Workspace>,
    pub providers: HashMap<String, p::Provider>,
    pub routes: HashMap<String, p::SetInferenceRouteRequest>,
    pub sandboxes: HashMap<String, p::Sandbox>,
    pub effects: usize,
    pub conditional_updates: usize,
    pub lose_create: bool,
    pub lose_delete: bool,
    pub fail_read: Option<(&'static str, tonic::Code)>,
}
impl State {
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
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let state = Arc::new(Mutex::new(State::default()));
        let service = Service(state.clone());
        let task = tokio::spawn(async move {
            tonic::transport::Server::builder()
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
            let response = match request.uri().path() {
                "/openshell.v1.OpenShell/GetGatewayInfo" => {
                    unary(request, state, gateway_info).await
                }
                "/openshell.v1.OpenShell/CreateSandbox" => {
                    unary(request, state, create_sandbox).await
                }
                "/openshell.v1.OpenShell/GetSandbox" => unary(request, state, get_sandbox).await,
                "/openshell.v1.OpenShell/DeleteSandbox" => {
                    unary(request, state, delete_sandbox).await
                }
                "/openshell.v1.OpenShell/GetSandboxPolicyStatus" => {
                    unary(request, state, policy_status).await
                }
                "/openshell.inference.v1.Inference/GetInferenceRoute" => {
                    unary(request, state, get_route).await
                }
                "/openshell.inference.v1.Inference/SetInferenceRoute" => {
                    unary(request, state, set_route).await
                }
                "/openshell.inference.v1.Inference/DeleteInferenceRoute" => {
                    unary(request, state, delete_route).await
                }
                "/openshell.v1.OpenShell/GetWorkspace" => {
                    unary(request, state, get_workspace).await
                }
                "/openshell.v1.OpenShell/CreateWorkspace" => {
                    unary(request, state, create_workspace).await
                }
                "/openshell.v1.OpenShell/GetProvider" => unary(request, state, get_provider).await,
                "/openshell.v1.OpenShell/CreateProvider" => {
                    unary(request, state, create_provider).await
                }
                "/openshell.v1.OpenShell/UpdateProvider" => {
                    unary(request, state, update_provider).await
                }
                "/openshell.v1.OpenShell/DeleteProvider" => {
                    unary(request, state, delete_provider).await
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
    q: p::GetWorkspaceRequest,
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
    Ok(p::CreateWorkspaceResponse {
        workspace: Some(workspace),
    })
}
fn get_provider(
    state: &mut State,
    q: p::GetProviderRequest,
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
    q: p::DeleteProviderRequest,
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
    _: &mut State,
    _: p::GetGatewayInfoRequest,
) -> Result<p::GetGatewayInfoResponse, Status> {
    Ok(p::GetGatewayInfoResponse {
        gateway_version: "0.0.116".into(),
        compute_drivers: vec![p::ComputeDriverInfo {
            name: "docker".into(),
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
    Ok(p::SandboxResponse {
        sandbox: Some(sandbox),
    })
}
fn get_sandbox(state: &mut State, q: p::GetSandboxRequest) -> Result<p::SandboxResponse, Status> {
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
    q: p::DeleteSandboxRequest,
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
    q: p::GetSandboxPolicyStatusRequest,
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
            policy: sandbox.spec.as_ref().unwrap().policy.clone(),
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
    state.effects += 1;
    Ok(response)
}
fn delete_route(
    state: &mut State,
    q: p::DeleteInferenceRouteRequest,
) -> Result<p::DeleteInferenceRouteResponse, Status> {
    let deleted = state.routes.remove(&q.workspace).is_some();
    if deleted {
        state.effects += 1;
    }
    Ok(p::DeleteInferenceRouteResponse { deleted })
}
