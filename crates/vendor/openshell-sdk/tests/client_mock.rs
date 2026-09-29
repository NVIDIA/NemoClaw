// SPDX-FileCopyrightText: Copyright (c) 2025-2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! High-level [`OpenShellClient`] tests against an in-process mock gateway.
//!
//! The mock binds an ephemeral plaintext TCP listener and serves the
//! `OpenShell` gRPC service. Tests dial it via `http://127.0.0.1:<port>` so
//! TLS and auth code paths are skipped — those are exercised by the CLI's
//! `mtls_integration` and OIDC tests.

use openshell_core::proto;
use openshell_core::proto::open_shell_server::{OpenShell, OpenShellServer};
use openshell_sdk::{
    AuthConfig, ClientConfig, ExecOptions, ListOptions, OpenShellClient, Refresh, RefreshError,
    RefreshedToken, SandboxPhase, SandboxSpec, SandboxTemplateCreateSpec,
    SandboxTemplateListOptions, ServiceExposure, ServiceStatus as SdkServiceStatus, WatchEvent,
    WatchOptions,
};
use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::Duration;
use tokio::net::TcpListener;
use tokio::sync::Mutex;
use tokio_stream::StreamExt;
use tokio_stream::wrappers::TcpListenerStream;
use tonic::{Response, Status};

fn selected_workspace(scope: &Option<proto::datamodel::v1::WorkspaceSelector>) -> Option<&str> {
    match scope.as_ref()?.selection.as_ref()? {
        proto::datamodel::v1::workspace_selector::Selection::Workspace(workspace) => {
            Some(workspace)
        }
        proto::datamodel::v1::workspace_selector::Selection::AllWorkspaces(_) => None,
    }
}

fn selects_all_workspaces(scope: &Option<proto::datamodel::v1::WorkspaceSelector>) -> bool {
    matches!(
        scope.as_ref().and_then(|scope| scope.selection.as_ref()),
        Some(proto::datamodel::v1::workspace_selector::Selection::AllWorkspaces(_))
    )
}

/// Captured fixture state — what the mock observed and the canned replies it
/// returned. One per test so assertions are scoped.
#[derive(Default)]
struct MockState {
    last_get_name: Mutex<Option<String>>,
    last_get_workspace: Mutex<Option<String>>,
    last_create: Mutex<Option<proto::CreateSandboxRequest>>,
    last_template_create: Mutex<Option<proto::CreateSandboxTemplateRequest>>,
    last_template_get: Mutex<Option<proto::GetSandboxTemplateRequest>>,
    last_template_list: Mutex<Option<proto::ListSandboxTemplatesRequest>>,
    last_template_delete: Mutex<Option<proto::DeleteSandboxTemplateRequest>>,
    last_delete_name: Mutex<Option<String>>,
    last_delete_workspace: Mutex<Option<String>>,
    last_stop: Mutex<Option<proto::StopSandboxRequest>>,
    last_start: Mutex<Option<proto::StartSandboxRequest>>,
    last_list_request: Mutex<Option<proto::ListSandboxesRequest>>,
    list_requests: Mutex<Vec<proto::ListSandboxesRequest>>,
    last_exec_request: Mutex<Option<proto::ExecSandboxRequest>>,
    last_workspace_request: Mutex<Option<String>>,
    get_calls: AtomicU32,
    phase_sequence: Vec<proto::SandboxPhase>,
    get_sandbox_id: Option<String>,
    get_error: Option<Status>,
    delete_response: Option<proto::DeleteSandboxResponse>,
    get_returns_not_found: bool,
    not_found_after: Option<u32>,
    paginate_list: bool,
    /// When set, `health` rejects any request whose `authorization` header
    /// does not match this exact value (e.g. `"Bearer fresh-token"`).
    require_bearer: Option<String>,
    /// Count of requests rejected by the `require_bearer` gate.
    unauth_hits: AtomicU32,
    last_watch_requests: Mutex<Vec<proto::WatchSandboxRequest>>,
    watch_calls: AtomicU32,
    // Per-dial script. Outer Vec index = dial number. Inner = events to send,
    // then how to end that dial.
    watch_script: Vec<WatchDial>,
}

#[derive(Debug, Clone)]
struct WatchDial {
    events: Vec<proto::SandboxStreamEvent>,
    end: DialEnd,
}

#[derive(Debug, Clone)]
enum DialEnd {
    Clean,
    Err(tonic::Code),
    /// The dial itself fails before any stream opens (pre-stream RPC error).
    FailDial(tonic::Code),
}

#[derive(Clone)]
struct TestOpenShell {
    state: Arc<MockState>,
}

fn sandbox_with_phase(name: &str, phase: proto::SandboxPhase) -> proto::Sandbox {
    sandbox_with_phase_ws(name, phase, "default")
}

fn sandbox_with_phase_ws(
    name: &str,
    phase: proto::SandboxPhase,
    workspace: &str,
) -> proto::Sandbox {
    let created_from_workload_template =
        (name == "from-template").then(|| proto::SandboxWorkloadTemplateProvenance {
            name: "python".to_string(),
            resource_version: "7".to_string(),
        });
    proto::Sandbox {
        metadata: Some(proto::datamodel::v1::ObjectMeta {
            id: format!("id-{name}"),
            name: name.to_string(),
            created_time: None,
            labels: HashMap::new(),
            annotations: HashMap::new(),
            resource_version: 1,
            deletion_time: None,
            workspace: workspace.to_string(),
        }),
        spec: None,
        status: Some(proto::SandboxStatus {
            phase: phase.into(),
            ..Default::default()
        }),
        created_from_workload_template,
    }
}

/// Encode the wire cursor for `seq`, spelled out rather than built with the
/// server's encoder.
///
/// The SDK treats cursors as opaque, so nothing in this crate can produce one.
/// Writing the format by hand also pins it independently: the padding is what
/// makes the SDK's byte-wise high-water comparison agree with sequence order,
/// and a server-side change that dropped it would have to break this literal
/// before it could break a client.
fn test_cursor(seq: u64) -> String {
    format!("v1:11111111-1111-4111-8111-111111111111:{seq:020}")
}

fn log_event(seq: u64, msg: &str) -> proto::SandboxStreamEvent {
    proto::SandboxStreamEvent {
        payload: Some(proto::sandbox_stream_event::Payload::Log(
            proto::SandboxLogLine {
                sandbox_id: "id-my-box".into(),
                event_time: None,
                level: "INFO".into(),
                target: "t".into(),
                message: msg.into(),
                source: "sandbox".into(),
                fields: HashMap::new(),
            },
        )),
        cursor: test_cursor(seq),
    }
}

fn warning_event(msg: &str) -> proto::SandboxStreamEvent {
    proto::SandboxStreamEvent {
        payload: Some(proto::sandbox_stream_event::Payload::Warning(
            proto::SandboxStreamWarning {
                message: msg.into(),
            },
        )),
        cursor: String::new(),
    }
}

fn watch_opts() -> WatchOptions {
    WatchOptions {
        follow_logs: true,
        ..Default::default()
    }
}

fn workspace_proto(name: &str, phase: proto::datamodel::v1::WorkspacePhase) -> proto::Workspace {
    proto::Workspace {
        metadata: Some(proto::datamodel::v1::ObjectMeta {
            id: format!("ws-{name}"),
            name: name.to_string(),
            created_time: openshell_core::time::timestamp_from_millis(1_000_000).ok(),
            labels: HashMap::new(),
            annotations: HashMap::new(),
            resource_version: 1,
            deletion_time: None,
            workspace: String::new(),
        }),
        status: Some(proto::datamodel::v1::WorkspaceStatus {
            phase: phase.into(),
        }),
    }
}

fn workload_template_proto(name: &str, workspace: &str) -> proto::SandboxWorkloadTemplate {
    proto::SandboxWorkloadTemplate {
        metadata: Some(proto::datamodel::v1::ObjectMeta {
            id: format!("template-{workspace}-{name}"),
            name: name.to_string(),
            created_time: openshell_core::time::timestamp_from_millis(1_000_000).ok(),
            labels: HashMap::new(),
            annotations: HashMap::new(),
            resource_version: 1,
            deletion_time: None,
            workspace: workspace.to_string(),
        }),
        spec: Some(proto::SandboxWorkloadTemplateSpec {
            workload: Some(proto::SandboxWorkloadConfig {
                image: format!("ghcr.io/test/{name}:latest"),
                environment: HashMap::new(),
                resources: Some(proto::SandboxResources {
                    cpu: "1".to_string(),
                    memory: "512Mi".to_string(),
                    ..proto::SandboxResources::default()
                }),
            }),
            driver_config: None,
            desired_service_level: None,
        }),
    }
}

#[tonic::async_trait]
impl OpenShell for TestOpenShell {
    async fn peer_report_provider_readiness(
        &self,
        _request: tonic::Request<proto::ReportProviderReadinessRequest>,
    ) -> Result<Response<proto::ReportProviderReadinessResponse>, Status> {
        Err(Status::unimplemented("not used by this test server"))
    }

    async fn peer_report_endpoint_status(
        &self,
        _request: tonic::Request<proto::ReportEndpointStatusRequest>,
    ) -> Result<Response<proto::ReportEndpointStatusResponse>, Status> {
        Err(Status::unimplemented("not used by this test server"))
    }

    async fn peer_get_sandbox_provider_status(
        &self,
        _request: tonic::Request<proto::GetSandboxProviderStatusRequest>,
    ) -> Result<Response<proto::GetSandboxProviderStatusResponse>, Status> {
        Err(Status::unimplemented("not used by this test server"))
    }

    async fn report_endpoint_status(
        &self,
        _request: tonic::Request<proto::ReportEndpointStatusRequest>,
    ) -> Result<Response<proto::ReportEndpointStatusResponse>, Status> {
        Ok(Response::new(proto::ReportEndpointStatusResponse {}))
    }

    async fn begin_rootfs_tar_staging(
        &self,
        _request: tonic::Request<proto::BeginRootfsTarStagingRequest>,
    ) -> Result<Response<proto::BeginRootfsTarStagingResponse>, Status> {
        Err(Status::unimplemented("not used by this test server"))
    }

    async fn report_main_process_exit(
        &self,
        _request: tonic::Request<proto::ReportMainProcessExitRequest>,
    ) -> Result<Response<proto::ReportMainProcessExitResponse>, Status> {
        Err(Status::unimplemented("not used by this test server"))
    }

    async fn finalize_main_process_exit(
        &self,
        _request: tonic::Request<proto::FinalizeMainProcessExitRequest>,
    ) -> Result<Response<proto::FinalizeMainProcessExitResponse>, Status> {
        Err(Status::unimplemented("not used by this test server"))
    }

    async fn get_current_user(
        &self,
        _request: tonic::Request<proto::GetCurrentUserRequest>,
    ) -> Result<Response<proto::GetCurrentUserResponse>, Status> {
        Err(Status::unimplemented("not used by this test server"))
    }

    async fn health(
        &self,
        request: tonic::Request<proto::HealthRequest>,
    ) -> Result<Response<proto::HealthResponse>, Status> {
        if let Some(expected) = &self.state.require_bearer {
            let got = request
                .metadata()
                .get("authorization")
                .and_then(|v| v.to_str().ok());
            if got != Some(expected.as_str()) {
                self.state.unauth_hits.fetch_add(1, Ordering::SeqCst);
                return Err(Status::unauthenticated("invalid or missing bearer token"));
            }
        }
        Ok(Response::new(proto::HealthResponse {
            status: proto::ServiceStatus::Healthy.into(),
            version: "test-1.2.3".to_string(),
        }))
    }

    async fn get_gateway_info(
        &self,
        _: tonic::Request<proto::GetGatewayInfoRequest>,
    ) -> Result<Response<proto::GetGatewayInfoResponse>, Status> {
        Ok(Response::new(proto::GetGatewayInfoResponse {
            status: proto::ServiceStatus::Healthy.into(),
            gateway_version: "test-1.2.3".to_string(),
            compute_drivers: Vec::new(),
            extensions: Vec::new(),
        }))
    }

    async fn update_provider_profiles(
        &self,
        _: tonic::Request<proto::UpdateProviderProfilesRequest>,
    ) -> Result<Response<proto::UpdateProviderProfilesResponse>, Status> {
        Ok(Response::new(
            proto::UpdateProviderProfilesResponse::default(),
        ))
    }

    async fn create_sandbox(
        &self,
        request: tonic::Request<proto::CreateSandboxRequest>,
    ) -> Result<Response<proto::SandboxResponse>, Status> {
        let req = request.into_inner();
        let name = if req.name.is_empty() {
            "generated".to_string()
        } else {
            req.name.clone()
        };
        let service_urls = req
            .service_exposures
            .iter()
            .map(|exposure| {
                (
                    exposure.service.clone(),
                    format!("https://{}.example.test/", exposure.service),
                )
            })
            .collect();
        *self.state.last_create.lock().await = Some(req);
        Ok(Response::new(proto::SandboxResponse {
            sandbox: Some(sandbox_with_phase(&name, proto::SandboxPhase::Provisioning)),
            service_urls,
        }))
    }

    async fn create_sandbox_template(
        &self,
        request: tonic::Request<proto::CreateSandboxTemplateRequest>,
    ) -> Result<Response<proto::SandboxTemplateResponse>, Status> {
        let request = request.into_inner();
        let template = request
            .template
            .clone()
            .ok_or_else(|| Status::invalid_argument("missing template"))?;
        *self.state.last_template_create.lock().await = Some(request);
        Ok(Response::new(proto::SandboxTemplateResponse {
            template: Some(template),
        }))
    }

    async fn get_sandbox_template(
        &self,
        request: tonic::Request<proto::GetSandboxTemplateRequest>,
    ) -> Result<Response<proto::SandboxTemplateResponse>, Status> {
        let request = request.into_inner();
        let workspace = selected_workspace(&request.workspace_scope).unwrap_or_default();
        let template = workload_template_proto(&request.name, workspace);
        *self.state.last_template_get.lock().await = Some(request);
        Ok(Response::new(proto::SandboxTemplateResponse {
            template: Some(template),
        }))
    }

    async fn list_sandbox_templates(
        &self,
        request: tonic::Request<proto::ListSandboxTemplatesRequest>,
    ) -> Result<Response<proto::ListSandboxTemplatesResponse>, Status> {
        let request = request.into_inner();
        *self.state.last_template_list.lock().await = Some(request);
        Ok(Response::new(proto::ListSandboxTemplatesResponse {
            templates: vec![
                workload_template_proto("python", "default"),
                workload_template_proto("cuda", "gpu"),
            ],
            next_page_token: String::new(),
        }))
    }

    async fn delete_sandbox_template(
        &self,
        request: tonic::Request<proto::DeleteSandboxTemplateRequest>,
    ) -> Result<Response<proto::DeleteSandboxTemplateResponse>, Status> {
        *self.state.last_template_delete.lock().await = Some(request.into_inner());
        Ok(Response::new(proto::DeleteSandboxTemplateResponse {
            outcome: proto::DeletionOutcome::Completed.into(),
        }))
    }

    async fn stop_sandbox(
        &self,
        request: tonic::Request<proto::StopSandboxRequest>,
    ) -> Result<Response<proto::SandboxResponse>, Status> {
        let request = request.into_inner();
        let sandbox = sandbox_with_phase_ws(
            request.name.as_str(),
            proto::SandboxPhase::Stopped,
            selected_workspace(&request.workspace_scope).unwrap_or_default(),
        );
        *self.state.last_stop.lock().await = Some(request);
        Ok(Response::new(proto::SandboxResponse {
            sandbox: Some(sandbox),
            service_urls: HashMap::new(),
        }))
    }

    async fn start_sandbox(
        &self,
        request: tonic::Request<proto::StartSandboxRequest>,
    ) -> Result<Response<proto::SandboxResponse>, Status> {
        let request = request.into_inner();
        let sandbox = sandbox_with_phase_ws(
            request.name.as_str(),
            proto::SandboxPhase::Starting,
            selected_workspace(&request.workspace_scope).unwrap_or_default(),
        );
        *self.state.last_start.lock().await = Some(request);
        Ok(Response::new(proto::SandboxResponse {
            sandbox: Some(sandbox),
            service_urls: HashMap::new(),
        }))
    }

    async fn get_sandbox(
        &self,
        request: tonic::Request<proto::GetSandboxRequest>,
    ) -> Result<Response<proto::SandboxResponse>, Status> {
        let req = request.into_inner();
        let name = req.name.clone();
        *self.state.last_get_name.lock().await = Some(name.clone());
        *self.state.last_get_workspace.lock().await =
            selected_workspace(&req.workspace_scope).map(ToString::to_string);
        let count = self.state.get_calls.fetch_add(1, Ordering::SeqCst);

        if let Some(error) = &self.state.get_error {
            return Err(error.clone());
        }
        if self.state.get_returns_not_found {
            return Err(Status::not_found(format!("sandbox '{name}' not found")));
        }
        if let Some(threshold) = self.state.not_found_after
            && count >= threshold
        {
            return Err(Status::not_found(format!("sandbox '{name}' not found")));
        }

        let phase = self
            .state
            .phase_sequence
            .get(count as usize)
            .copied()
            .or_else(|| self.state.phase_sequence.last().copied())
            .unwrap_or(proto::SandboxPhase::Ready);

        let mut sandbox = sandbox_with_phase(&name, phase);
        if let Some(id) = &self.state.get_sandbox_id {
            sandbox.metadata.as_mut().unwrap().id.clone_from(id);
        }
        Ok(Response::new(proto::SandboxResponse {
            sandbox: Some(sandbox),
            service_urls: HashMap::new(),
        }))
    }

    async fn list_sandboxes(
        &self,
        request: tonic::Request<proto::ListSandboxesRequest>,
    ) -> Result<Response<proto::ListSandboxesResponse>, Status> {
        let request = request.into_inner();
        *self.state.last_list_request.lock().await = Some(request.clone());
        self.state.list_requests.lock().await.push(request.clone());
        if self.state.paginate_list {
            let (sandboxes, next_page_token) = if request.page_token.is_empty() {
                (
                    vec![sandbox_with_phase("alpha", proto::SandboxPhase::Ready)],
                    "page-2".to_string(),
                )
            } else {
                assert_eq!(request.page_token, "page-2");
                (
                    vec![sandbox_with_phase(
                        "beta",
                        proto::SandboxPhase::Provisioning,
                    )],
                    String::new(),
                )
            };
            return Ok(Response::new(proto::ListSandboxesResponse {
                sandboxes,
                next_page_token,
            }));
        }
        Ok(Response::new(proto::ListSandboxesResponse {
            sandboxes: vec![
                sandbox_with_phase("alpha", proto::SandboxPhase::Ready),
                sandbox_with_phase("beta", proto::SandboxPhase::Provisioning),
            ],
            next_page_token: String::new(),
        }))
    }

    async fn list_sandbox_providers(
        &self,
        _: tonic::Request<proto::ListSandboxProvidersRequest>,
    ) -> Result<Response<proto::ListSandboxProvidersResponse>, Status> {
        Ok(Response::new(proto::ListSandboxProvidersResponse::default()))
    }

    async fn attach_sandbox_provider(
        &self,
        _: tonic::Request<proto::AttachSandboxProviderRequest>,
    ) -> Result<Response<proto::AttachSandboxProviderResponse>, Status> {
        Ok(Response::new(
            proto::AttachSandboxProviderResponse::default(),
        ))
    }

    async fn detach_sandbox_provider(
        &self,
        _: tonic::Request<proto::DetachSandboxProviderRequest>,
    ) -> Result<Response<proto::DetachSandboxProviderResponse>, Status> {
        Ok(Response::new(
            proto::DetachSandboxProviderResponse::default(),
        ))
    }

    async fn delete_sandbox(
        &self,
        request: tonic::Request<proto::DeleteSandboxRequest>,
    ) -> Result<Response<proto::DeleteSandboxResponse>, Status> {
        let req = request.into_inner();
        *self.state.last_delete_name.lock().await = Some(req.name.clone());
        *self.state.last_delete_workspace.lock().await =
            selected_workspace(&req.workspace_scope).map(ToString::to_string);
        if let Some(response) = &self.state.delete_response {
            return Ok(Response::new(response.clone()));
        }
        Ok(Response::new(proto::DeleteSandboxResponse {
            sandbox_id: String::new(),
            outcome: proto::DeletionOutcome::Completed.into(),
        }))
    }

    async fn create_ssh_session(
        &self,
        _: tonic::Request<proto::CreateSshSessionRequest>,
    ) -> Result<Response<proto::CreateSshSessionResponse>, Status> {
        Ok(Response::new(proto::CreateSshSessionResponse::default()))
    }

    async fn expose_service(
        &self,
        _: tonic::Request<proto::ExposeServiceRequest>,
    ) -> Result<Response<proto::ServiceEndpointResponse>, Status> {
        Ok(Response::new(proto::ServiceEndpointResponse::default()))
    }

    async fn get_service(
        &self,
        _: tonic::Request<proto::GetServiceRequest>,
    ) -> Result<Response<proto::ServiceEndpointResponse>, Status> {
        Err(Status::unimplemented("unused"))
    }

    async fn list_services(
        &self,
        _: tonic::Request<proto::ListServicesRequest>,
    ) -> Result<Response<proto::ListServicesResponse>, Status> {
        Err(Status::unimplemented("unused"))
    }

    async fn delete_service(
        &self,
        _: tonic::Request<proto::DeleteServiceRequest>,
    ) -> Result<Response<proto::DeleteServiceResponse>, Status> {
        Err(Status::unimplemented("unused"))
    }

    async fn revoke_ssh_session(
        &self,
        _: tonic::Request<proto::RevokeSshSessionRequest>,
    ) -> Result<Response<proto::RevokeSshSessionResponse>, Status> {
        Ok(Response::new(proto::RevokeSshSessionResponse::default()))
    }

    type ExecSandboxStream =
        tokio_stream::wrappers::ReceiverStream<Result<proto::ExecSandboxEvent, Status>>;

    async fn exec_sandbox(
        &self,
        request: tonic::Request<proto::ExecSandboxRequest>,
    ) -> Result<Response<Self::ExecSandboxStream>, Status> {
        *self.state.last_exec_request.lock().await = Some(request.into_inner());
        let (tx, rx) = tokio::sync::mpsc::channel(8);
        tokio::spawn(async move {
            let _ = tx
                .send(Ok(proto::ExecSandboxEvent {
                    payload: Some(proto::exec_sandbox_event::Payload::Stdout(
                        proto::ExecSandboxStdout {
                            data: b"hello\n".to_vec(),
                        },
                    )),
                }))
                .await;
            let _ = tx
                .send(Ok(proto::ExecSandboxEvent {
                    payload: Some(proto::exec_sandbox_event::Payload::Stderr(
                        proto::ExecSandboxStderr {
                            data: b"warn\n".to_vec(),
                        },
                    )),
                }))
                .await;
            let _ = tx
                .send(Ok(proto::ExecSandboxEvent {
                    payload: Some(proto::exec_sandbox_event::Payload::Exit(
                        proto::ExecSandboxExit { exit_code: 7 },
                    )),
                }))
                .await;
        });
        Ok(Response::new(tokio_stream::wrappers::ReceiverStream::new(
            rx,
        )))
    }

    type ForwardTcpStream =
        tokio_stream::wrappers::ReceiverStream<Result<proto::TcpForwardFrame, Status>>;

    async fn forward_tcp(
        &self,
        _: tonic::Request<tonic::Streaming<proto::TcpForwardFrame>>,
    ) -> Result<Response<Self::ForwardTcpStream>, Status> {
        Err(Status::unimplemented("unused"))
    }

    type PeerRelayStream =
        tokio_stream::wrappers::ReceiverStream<Result<proto::PeerRelayFrame, Status>>;

    async fn peer_relay(
        &self,
        _: tonic::Request<tonic::Streaming<proto::PeerRelayFrame>>,
    ) -> Result<Response<Self::PeerRelayStream>, Status> {
        Err(Status::unimplemented("unused"))
    }

    type ExecSandboxInteractiveStream =
        tokio_stream::wrappers::ReceiverStream<Result<proto::ExecSandboxEvent, Status>>;

    async fn exec_sandbox_interactive(
        &self,
        _: tonic::Request<tonic::Streaming<proto::ExecSandboxInput>>,
    ) -> Result<Response<Self::ExecSandboxInteractiveStream>, Status> {
        Err(Status::unimplemented("unused"))
    }

    async fn create_provider(
        &self,
        _: tonic::Request<proto::CreateProviderRequest>,
    ) -> Result<Response<proto::ProviderResponse>, Status> {
        Ok(Response::new(proto::ProviderResponse::default()))
    }

    async fn get_provider(
        &self,
        _: tonic::Request<proto::GetProviderRequest>,
    ) -> Result<Response<proto::ProviderResponse>, Status> {
        Ok(Response::new(proto::ProviderResponse::default()))
    }

    async fn list_providers(
        &self,
        _: tonic::Request<proto::ListProvidersRequest>,
    ) -> Result<Response<proto::ListProvidersResponse>, Status> {
        Ok(Response::new(proto::ListProvidersResponse::default()))
    }

    async fn list_provider_profiles(
        &self,
        _: tonic::Request<proto::ListProviderProfilesRequest>,
    ) -> Result<Response<proto::ListProviderProfilesResponse>, Status> {
        Err(Status::unimplemented("unused"))
    }

    async fn get_provider_profile(
        &self,
        _: tonic::Request<proto::GetProviderProfileRequest>,
    ) -> Result<Response<proto::ProviderProfileResponse>, Status> {
        Err(Status::unimplemented("unused"))
    }

    async fn import_provider_profiles(
        &self,
        _: tonic::Request<proto::ImportProviderProfilesRequest>,
    ) -> Result<Response<proto::ImportProviderProfilesResponse>, Status> {
        Err(Status::unimplemented("unused"))
    }

    async fn lint_provider_profiles(
        &self,
        _: tonic::Request<proto::LintProviderProfilesRequest>,
    ) -> Result<Response<proto::LintProviderProfilesResponse>, Status> {
        Err(Status::unimplemented("unused"))
    }

    async fn update_provider(
        &self,
        _: tonic::Request<proto::UpdateProviderRequest>,
    ) -> Result<Response<proto::ProviderResponse>, Status> {
        Ok(Response::new(proto::ProviderResponse::default()))
    }

    async fn get_provider_refresh_status(
        &self,
        _: tonic::Request<proto::GetProviderRefreshStatusRequest>,
    ) -> Result<Response<proto::GetProviderRefreshStatusResponse>, Status> {
        Err(Status::unimplemented("unused"))
    }

    async fn configure_provider_refresh(
        &self,
        _: tonic::Request<proto::ConfigureProviderRefreshRequest>,
    ) -> Result<Response<proto::ConfigureProviderRefreshResponse>, Status> {
        Err(Status::unimplemented("unused"))
    }

    async fn rotate_provider_credential(
        &self,
        _: tonic::Request<proto::RotateProviderCredentialRequest>,
    ) -> Result<Response<proto::RotateProviderCredentialResponse>, Status> {
        Err(Status::unimplemented("unused"))
    }

    async fn delete_provider_refresh(
        &self,
        _: tonic::Request<proto::DeleteProviderRefreshRequest>,
    ) -> Result<Response<proto::DeleteProviderRefreshResponse>, Status> {
        Err(Status::unimplemented("unused"))
    }

    async fn delete_provider(
        &self,
        _: tonic::Request<proto::DeleteProviderRequest>,
    ) -> Result<Response<proto::DeleteProviderResponse>, Status> {
        Ok(Response::new(proto::DeleteProviderResponse::default()))
    }

    async fn delete_provider_profile(
        &self,
        _: tonic::Request<proto::DeleteProviderProfileRequest>,
    ) -> Result<Response<proto::DeleteProviderProfileResponse>, Status> {
        Err(Status::unimplemented("unused"))
    }

    async fn get_sandbox_config(
        &self,
        _: tonic::Request<proto::GetSandboxConfigRequest>,
    ) -> Result<Response<proto::GetSandboxConfigResponse>, Status> {
        Ok(Response::new(proto::GetSandboxConfigResponse::default()))
    }

    async fn get_gateway_config(
        &self,
        _: tonic::Request<proto::GetGatewayConfigRequest>,
    ) -> Result<Response<proto::GetGatewayConfigResponse>, Status> {
        Ok(Response::new(proto::GetGatewayConfigResponse::default()))
    }

    async fn exchange_provider_subject_token(
        &self,
        _: tonic::Request<proto::ExchangeProviderSubjectTokenRequest>,
    ) -> Result<Response<proto::ExchangeProviderSubjectTokenResponse>, Status> {
        Err(Status::unimplemented("unused"))
    }

    async fn update_config(
        &self,
        _: tonic::Request<proto::UpdateConfigRequest>,
    ) -> Result<Response<proto::UpdateConfigResponse>, Status> {
        Err(Status::unimplemented("unused"))
    }

    async fn get_sandbox_policy_status(
        &self,
        _: tonic::Request<proto::GetSandboxPolicyStatusRequest>,
    ) -> Result<Response<proto::GetSandboxPolicyStatusResponse>, Status> {
        Ok(Response::new(
            proto::GetSandboxPolicyStatusResponse::default(),
        ))
    }

    async fn list_sandbox_policies(
        &self,
        _: tonic::Request<proto::ListSandboxPoliciesRequest>,
    ) -> Result<Response<proto::ListSandboxPoliciesResponse>, Status> {
        Err(Status::unimplemented("unused"))
    }

    async fn report_sandbox_configuration(
        &self,
        _: tonic::Request<proto::ReportSandboxConfigurationRequest>,
    ) -> Result<Response<proto::ReportSandboxConfigurationResponse>, Status> {
        Err(Status::unimplemented("not implemented in test"))
    }

    async fn report_policy_status(
        &self,
        _: tonic::Request<proto::ReportPolicyStatusRequest>,
    ) -> Result<Response<proto::ReportPolicyStatusResponse>, Status> {
        Err(Status::unimplemented("unused"))
    }

    async fn get_sandbox_provider_status(
        &self,
        _request: tonic::Request<proto::GetSandboxProviderStatusRequest>,
    ) -> Result<Response<proto::GetSandboxProviderStatusResponse>, Status> {
        Err(Status::unimplemented(
            "provider readiness is not exercised by this mock",
        ))
    }

    async fn report_provider_readiness(
        &self,
        _request: tonic::Request<proto::ReportProviderReadinessRequest>,
    ) -> Result<Response<proto::ReportProviderReadinessResponse>, Status> {
        Err(Status::unimplemented(
            "provider installation reports are not exercised by this mock",
        ))
    }

    async fn get_sandbox_provider_environment(
        &self,
        _: tonic::Request<proto::GetSandboxProviderEnvironmentRequest>,
    ) -> Result<Response<proto::GetSandboxProviderEnvironmentResponse>, Status> {
        Ok(Response::new(
            proto::GetSandboxProviderEnvironmentResponse::default(),
        ))
    }

    async fn get_sandbox_logs(
        &self,
        _: tonic::Request<proto::GetSandboxLogsRequest>,
    ) -> Result<Response<proto::GetSandboxLogsResponse>, Status> {
        Err(Status::unimplemented("unused"))
    }

    async fn push_sandbox_logs(
        &self,
        _: tonic::Request<tonic::Streaming<proto::PushSandboxLogsRequest>>,
    ) -> Result<Response<proto::PushSandboxLogsResponse>, Status> {
        Err(Status::unimplemented("unused"))
    }

    type WatchSandboxStream =
        tokio_stream::wrappers::ReceiverStream<Result<proto::SandboxStreamEvent, Status>>;

    async fn watch_sandbox(
        &self,
        request: tonic::Request<proto::WatchSandboxRequest>,
    ) -> Result<Response<Self::WatchSandboxStream>, Status> {
        let dial = self.state.watch_calls.fetch_add(1, Ordering::SeqCst) as usize;
        let req = request.into_inner();

        // The gateway resolves `sandbox` as a workspace-scoped canonical name,
        // so an object ID here is NOT_FOUND rather than a silent no-op stream.
        // Mirrored so every watch test fails on ID-addressed requests.
        let resolved = self.state.last_get_name.lock().await.clone();
        if let Some(resolved) = resolved
            && req.sandbox != resolved
        {
            return Err(Status::not_found(format!(
                "sandbox '{}' not found",
                req.sandbox
            )));
        }

        self.state.last_watch_requests.lock().await.push(req);

        let script = self.state.watch_script.get(dial).cloned();
        if let Some(WatchDial {
            end: DialEnd::FailDial(code),
            ..
        }) = script
        {
            return Err(Status::new(code, "scripted dial failure"));
        }
        let (tx, rx) = tokio::sync::mpsc::channel(8);
        tokio::spawn(async move {
            let Some(dial) = script else { return };
            for ev in dial.events {
                let _ = tx.send(Ok(ev)).await;
            }
            if let DialEnd::Err(code) = dial.end {
                let _ = tx.send(Err(Status::new(code, "scripted"))).await;
            }
            // tx dropped here → stream ends
        });
        Ok(Response::new(tokio_stream::wrappers::ReceiverStream::new(
            rx,
        )))
    }

    async fn submit_policy_analysis(
        &self,
        _: tonic::Request<proto::SubmitPolicyAnalysisRequest>,
    ) -> Result<Response<proto::SubmitPolicyAnalysisResponse>, Status> {
        Err(Status::unimplemented("unused"))
    }

    async fn get_draft_policy(
        &self,
        _: tonic::Request<proto::GetDraftPolicyRequest>,
    ) -> Result<Response<proto::GetDraftPolicyResponse>, Status> {
        Err(Status::unimplemented("unused"))
    }

    async fn approve_draft_chunk(
        &self,
        _: tonic::Request<proto::ApproveDraftChunkRequest>,
    ) -> Result<Response<proto::ApproveDraftChunkResponse>, Status> {
        Err(Status::unimplemented("unused"))
    }

    async fn approve_all_draft_chunks(
        &self,
        _: tonic::Request<proto::ApproveAllDraftChunksRequest>,
    ) -> Result<Response<proto::ApproveAllDraftChunksResponse>, Status> {
        Err(Status::unimplemented("unused"))
    }

    async fn reject_draft_chunk(
        &self,
        _: tonic::Request<proto::RejectDraftChunkRequest>,
    ) -> Result<Response<proto::RejectDraftChunkResponse>, Status> {
        Err(Status::unimplemented("unused"))
    }

    async fn edit_draft_chunk(
        &self,
        _: tonic::Request<proto::EditDraftChunkRequest>,
    ) -> Result<Response<proto::EditDraftChunkResponse>, Status> {
        Err(Status::unimplemented("unused"))
    }

    async fn undo_draft_chunk(
        &self,
        _: tonic::Request<proto::UndoDraftChunkRequest>,
    ) -> Result<Response<proto::UndoDraftChunkResponse>, Status> {
        Err(Status::unimplemented("unused"))
    }

    async fn clear_draft_chunks(
        &self,
        _: tonic::Request<proto::ClearDraftChunksRequest>,
    ) -> Result<Response<proto::ClearDraftChunksResponse>, Status> {
        Err(Status::unimplemented("unused"))
    }

    async fn get_draft_history(
        &self,
        _: tonic::Request<proto::GetDraftHistoryRequest>,
    ) -> Result<Response<proto::GetDraftHistoryResponse>, Status> {
        Err(Status::unimplemented("unused"))
    }

    type ConnectSupervisorStream =
        tokio_stream::wrappers::ReceiverStream<Result<proto::GatewayMessage, Status>>;

    async fn connect_supervisor(
        &self,
        _: tonic::Request<tonic::Streaming<proto::SupervisorMessage>>,
    ) -> Result<Response<Self::ConnectSupervisorStream>, Status> {
        Err(Status::unimplemented("unused"))
    }

    type RelayStreamStream =
        tokio_stream::wrappers::ReceiverStream<Result<proto::RelayFrame, Status>>;

    async fn relay_stream(
        &self,
        _: tonic::Request<tonic::Streaming<proto::RelayFrame>>,
    ) -> Result<Response<Self::RelayStreamStream>, Status> {
        Err(Status::unimplemented("unused"))
    }

    async fn issue_sandbox_token(
        &self,
        _: tonic::Request<proto::IssueSandboxTokenRequest>,
    ) -> Result<Response<proto::IssueSandboxTokenResponse>, Status> {
        Err(Status::unimplemented("unused"))
    }

    async fn refresh_sandbox_token(
        &self,
        _: tonic::Request<proto::RefreshSandboxTokenRequest>,
    ) -> Result<Response<proto::RefreshSandboxTokenResponse>, Status> {
        Err(Status::unimplemented("unused"))
    }

    async fn create_workspace(
        &self,
        request: tonic::Request<proto::CreateWorkspaceRequest>,
    ) -> Result<Response<proto::CreateWorkspaceResponse>, Status> {
        let req = request.into_inner();
        *self.state.last_workspace_request.lock().await = Some(req.name.clone());
        Ok(Response::new(proto::CreateWorkspaceResponse {
            workspace: Some(workspace_proto(
                &req.name,
                proto::datamodel::v1::WorkspacePhase::Active,
            )),
        }))
    }

    async fn get_workspace(
        &self,
        request: tonic::Request<proto::GetWorkspaceRequest>,
    ) -> Result<Response<proto::GetWorkspaceResponse>, Status> {
        let name = request.into_inner().name;
        *self.state.last_workspace_request.lock().await = Some(name.clone());
        Ok(Response::new(proto::GetWorkspaceResponse {
            workspace: Some(workspace_proto(
                &name,
                proto::datamodel::v1::WorkspacePhase::Active,
            )),
        }))
    }

    async fn list_workspaces(
        &self,
        _: tonic::Request<proto::ListWorkspacesRequest>,
    ) -> Result<Response<proto::ListWorkspacesResponse>, Status> {
        Ok(Response::new(proto::ListWorkspacesResponse {
            workspaces: vec![
                workspace_proto("default", proto::datamodel::v1::WorkspacePhase::Active),
                workspace_proto("staging", proto::datamodel::v1::WorkspacePhase::Active),
            ],
            next_page_token: String::new(),
        }))
    }

    async fn delete_workspace(
        &self,
        request: tonic::Request<proto::DeleteWorkspaceRequest>,
    ) -> Result<Response<proto::DeleteWorkspaceResponse>, Status> {
        *self.state.last_workspace_request.lock().await = Some(request.into_inner().name);
        Ok(Response::new(proto::DeleteWorkspaceResponse {
            outcome: proto::DeletionOutcome::Completed.into(),
        }))
    }

    async fn add_workspace_member(
        &self,
        _: tonic::Request<proto::AddWorkspaceMemberRequest>,
    ) -> Result<Response<proto::AddWorkspaceMemberResponse>, Status> {
        Err(Status::unimplemented("unused"))
    }

    async fn remove_workspace_member(
        &self,
        _: tonic::Request<proto::RemoveWorkspaceMemberRequest>,
    ) -> Result<Response<proto::RemoveWorkspaceMemberResponse>, Status> {
        Err(Status::unimplemented("unused"))
    }

    async fn list_workspace_members(
        &self,
        _: tonic::Request<proto::ListWorkspaceMembersRequest>,
    ) -> Result<Response<proto::ListWorkspaceMembersResponse>, Status> {
        Err(Status::unimplemented("unused"))
    }
}

/// Spin up the mock gateway, return its endpoint URL.
async fn start_mock(state: Arc<MockState>) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let endpoint = format!("http://{addr}");
    let stream = TcpListenerStream::new(listener);
    let svc = OpenShellServer::new(TestOpenShell { state });
    tokio::spawn(async move {
        let _ = tonic::transport::Server::builder()
            .add_service(svc)
            .serve_with_incoming(stream)
            .await;
    });
    endpoint
}

async fn connect(endpoint: &str) -> OpenShellClient {
    OpenShellClient::connect(ClientConfig::new(endpoint))
        .await
        .expect("connect should succeed against local mock")
}

#[tokio::test]
async fn health_returns_curated_snapshot() {
    let state = Arc::new(MockState::default());
    let endpoint = start_mock(state.clone()).await;
    let client = connect(&endpoint).await;

    let h = client.health().await.unwrap();
    assert_eq!(h.status, SdkServiceStatus::Healthy);
    assert_eq!(h.version, "test-1.2.3");
}

#[tokio::test]
async fn create_sandbox_passes_spec_through() {
    let state = Arc::new(MockState::default());
    let endpoint = start_mock(state.clone()).await;
    let client = connect(&endpoint).await;

    let mut labels = HashMap::new();
    labels.insert("team".to_string(), "core".to_string());

    let spec = SandboxSpec {
        name: Some("my-box".to_string()),
        image: Some("ghcr.io/foo:bar".to_string()),
        labels: labels.clone(),
        gpu: true,
        service_exposures: vec![ServiceExposure {
            service: "web".to_string(),
            target_port: 8080,
        }],
        ..Default::default()
    };

    let result = client.create_sandbox(spec).await.unwrap();
    assert_eq!(result.name, "my-box");
    assert_eq!(result.phase, SandboxPhase::Provisioning);
    assert_eq!(
        result.service_urls.get("web").map(String::as_str),
        Some("https://web.example.test/")
    );

    let observed = state.last_create.lock().await.clone().unwrap();
    assert_eq!(observed.name, "my-box");
    assert_eq!(observed.labels, labels);
    assert!(observed.annotations.is_empty());
    assert_eq!(observed.service_exposures.len(), 1);
    assert_eq!(observed.service_exposures[0].service, "web");
    assert_eq!(observed.service_exposures[0].target_port, 8080);
    let observed_spec = observed.spec.unwrap();
    assert!(
        observed_spec
            .resource_requirements
            .as_ref()
            .and_then(|r| r.gpu.as_ref())
            .is_some()
    );
    assert_eq!(
        observed_spec.template.as_ref().unwrap().image,
        "ghcr.io/foo:bar"
    );
}

#[tokio::test]
async fn create_sandbox_from_template_passes_template_name() {
    let state = Arc::new(MockState::default());
    let endpoint = start_mock(state.clone()).await;
    let client = connect(&endpoint).await;

    let sandbox = client
        .create_sandbox_from_template(SandboxTemplateCreateSpec {
            name: Some("from-template".to_string()),
            template_name: "python".to_string(),
            providers: vec!["openai".to_string()],
            command: vec!["python".to_string(), "-m".to_string(), "agent".to_string()],
            tty: false,
            policy: Some(proto::SandboxPolicy {
                version: 1,
                ..Default::default()
            }),
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(sandbox.name, "from-template");

    let observed = state.last_create.lock().await.clone().unwrap();
    assert_eq!(observed.name, "from-template");
    assert_eq!(observed.workload_template, "python");
    let observed_spec = observed.spec.unwrap();
    assert_eq!(observed_spec.providers, vec!["openai".to_string()]);
    assert_eq!(observed_spec.command, vec!["python", "-m", "agent"]);
    assert!(!observed_spec.tty);
    assert_eq!(observed_spec.policy.unwrap().version, 1);
}

#[tokio::test]
async fn sandbox_template_crud_uses_default_workspace() {
    let state = Arc::new(MockState::default());
    let endpoint = start_mock(state.clone()).await;
    let client = connect(&endpoint).await;

    let created = client
        .create_sandbox_template(workload_template_proto("python", ""))
        .await
        .unwrap();
    assert_eq!(created.metadata.as_ref().unwrap().name, "python");

    let observed_create = state.last_template_create.lock().await.clone().unwrap();
    assert_eq!(
        selected_workspace(&observed_create.workspace_scope),
        Some("default")
    );
    assert_eq!(
        observed_create
            .template
            .as_ref()
            .and_then(|template| template.metadata.as_ref())
            .unwrap()
            .name,
        "python"
    );

    let fetched = client.get_sandbox_template("python").await.unwrap();
    assert_eq!(fetched.metadata.as_ref().unwrap().name, "python");
    let observed_get = state.last_template_get.lock().await.clone().unwrap();
    assert_eq!(observed_get.name, "python");
    assert_eq!(
        selected_workspace(&observed_get.workspace_scope),
        Some("default")
    );

    let listed = client
        .list_all_sandbox_templates_all_workspaces(SandboxTemplateListOptions {
            page_size: 10,
            label_selector: String::new(),
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(listed.len(), 2);
    let observed_list = state.last_template_list.lock().await.clone().unwrap();
    assert_eq!(observed_list.page_size, 10);
    assert!(observed_list.page_token.is_empty());
    assert!(selects_all_workspaces(&observed_list.workspace_scope));

    let deleted = client
        .delete_sandbox_template("python", openshell_sdk::DeleteOptions::default())
        .await
        .unwrap();
    assert_eq!(deleted.outcome, openshell_sdk::DeletionOutcome::Completed);
    let observed_delete = state.last_template_delete.lock().await.clone().unwrap();
    assert_eq!(observed_delete.name, "python");
    assert_eq!(
        selected_workspace(&observed_delete.workspace_scope),
        Some("default")
    );
}

#[tokio::test]
async fn get_sandbox_sends_name_and_maps_phase() {
    let state = Arc::new(MockState {
        phase_sequence: vec![proto::SandboxPhase::Ready],
        ..Default::default()
    });
    let endpoint = start_mock(state.clone()).await;
    let client = connect(&endpoint).await;

    let sandbox = client.get_sandbox("my-box").await.unwrap();
    assert_eq!(sandbox.name, "my-box");
    assert_eq!(sandbox.id, "id-my-box");
    assert_eq!(sandbox.phase, SandboxPhase::Ready);

    let observed = state.last_get_name.lock().await.clone();
    assert_eq!(observed.as_deref(), Some("my-box"));
}

#[tokio::test]
async fn get_sandbox_preserves_workload_template_provenance() {
    let state = Arc::new(MockState::default());
    let endpoint = start_mock(state.clone()).await;
    let client = connect(&endpoint).await;

    let sandbox = client.get_sandbox("from-template").await.unwrap();

    let provenance = sandbox
        .created_from_workload_template
        .expect("template provenance");
    assert_eq!(provenance.name, "python");
    assert_eq!(provenance.resource_version, "7");
}

#[tokio::test]
async fn list_sandboxes_propagates_filters() {
    let state = Arc::new(MockState::default());
    let endpoint = start_mock(state.clone()).await;
    let client = connect(&endpoint).await;

    let opts = ListOptions {
        page_size: 25,
        label_selector: Some("team=core".to_string()),
        ..Default::default()
    };
    let items = client.list_all_sandboxes(opts).await.unwrap();
    assert_eq!(items.len(), 2);
    assert_eq!(items[0].name, "alpha");
    assert_eq!(items[0].phase, SandboxPhase::Ready);
    assert_eq!(items[1].phase, SandboxPhase::Provisioning);

    let observed = state.last_list_request.lock().await.clone().unwrap();
    assert_eq!(observed.page_size, 25);
    assert!(observed.page_token.is_empty());
    assert_eq!(observed.label_selector, "team=core");
}

#[tokio::test]
async fn list_sandboxes_follows_continuation_tokens() {
    let state = Arc::new(MockState {
        paginate_list: true,
        ..Default::default()
    });
    let endpoint = start_mock(state.clone()).await;
    let client = connect(&endpoint).await;

    let mut pager = client.list_sandboxes(ListOptions {
        page_size: 1,
        label_selector: Some("team=core".to_string()),
        ..Default::default()
    });
    assert!(state.list_requests.lock().await.is_empty());

    let first = pager.next_page().await.unwrap().unwrap();
    assert_eq!(first.items.len(), 1);
    assert_eq!(first.items[0].name, "alpha");
    assert_eq!(first.next_page_token, "page-2");
    let second = pager.next_page().await.unwrap().unwrap();
    assert_eq!(second.items.len(), 1);
    assert_eq!(second.items[0].name, "beta");
    assert!(second.next_page_token.is_empty());
    assert!(pager.next_page().await.unwrap().is_none());
    let requests = state.list_requests.lock().await;
    assert_eq!(requests.len(), 2);
    assert!(requests[0].page_token.is_empty());
    assert_eq!(requests[1].page_token, "page-2");
    assert_eq!(requests[1].label_selector, "team=core");
}

#[tokio::test]
async fn list_sandboxes_passes_initial_page_token() {
    let state = Arc::new(MockState {
        paginate_list: true,
        ..Default::default()
    });
    let endpoint = start_mock(state.clone()).await;
    let client = connect(&endpoint).await;

    let mut pager = client.list_sandboxes(ListOptions {
        page_size: 1,
        page_token: "page-2".to_string(),
        ..Default::default()
    });
    let page = pager.next_page().await.unwrap().unwrap();

    assert_eq!(page.items.len(), 1);
    assert_eq!(page.items[0].name, "beta");
    let requests = state.list_requests.lock().await;
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].page_token, "page-2");
}

#[tokio::test]
async fn delete_sandbox_returns_server_ack() {
    let state = Arc::new(MockState::default());
    let endpoint = start_mock(state.clone()).await;
    let client = connect(&endpoint).await;

    let deleted = client
        .delete_sandbox("doomed", openshell_sdk::DeleteOptions::default())
        .await
        .unwrap();
    assert_eq!(deleted.outcome, openshell_sdk::DeletionOutcome::Completed);

    let observed = state.last_delete_name.lock().await.clone();
    assert_eq!(observed.as_deref(), Some("doomed"));
}

#[tokio::test]
async fn stop_and_start_map_requests_and_phases() {
    let state = Arc::new(MockState::default());
    let endpoint = start_mock(state.clone()).await;
    let client = connect(&endpoint).await;

    let stopped = client.stop_sandbox("sleepy").await.unwrap();
    assert_eq!(stopped.phase, SandboxPhase::Stopped);
    let stop = state.last_stop.lock().await.clone().unwrap();
    assert_eq!(Some(stop.name.as_str()), Some("sleepy"));
    assert_eq!(selected_workspace(&stop.workspace_scope), Some("default"));

    let started = client
        .workspace("team-a")
        .start_sandbox("sleepy")
        .await
        .unwrap();
    assert_eq!(started.phase, SandboxPhase::Starting);
    let start = state.last_start.lock().await.clone().unwrap();
    assert_eq!(Some(start.name.as_str()), Some("sleepy"));
    assert_eq!(selected_workspace(&start.workspace_scope), Some("team-a"));
}

#[tokio::test]
async fn wait_ready_transitions_through_phases() {
    let state = Arc::new(MockState {
        phase_sequence: vec![
            proto::SandboxPhase::Provisioning,
            proto::SandboxPhase::Provisioning,
            proto::SandboxPhase::Ready,
        ],
        ..Default::default()
    });
    let endpoint = start_mock(state.clone()).await;
    let client = connect(&endpoint).await;

    let sandbox = client
        .wait_ready("my-box", Duration::from_secs(5))
        .await
        .unwrap();
    assert_eq!(sandbox.phase, SandboxPhase::Ready);
    assert!(state.get_calls.load(Ordering::SeqCst) >= 3);
}

#[tokio::test]
async fn wait_ready_accepts_successful_completion() {
    let state = Arc::new(MockState {
        phase_sequence: vec![
            proto::SandboxPhase::Provisioning,
            proto::SandboxPhase::Completed,
        ],
        ..Default::default()
    });
    let endpoint = start_mock(state).await;
    let client = connect(&endpoint).await;

    let sandbox = client
        .wait_ready("short-job", Duration::from_secs(5))
        .await
        .unwrap();
    assert_eq!(sandbox.phase, SandboxPhase::Completed);
}

#[tokio::test]
async fn wait_ready_surfaces_stopped_phase_without_timing_out() {
    let state = Arc::new(MockState {
        phase_sequence: vec![proto::SandboxPhase::Stopped],
        ..Default::default()
    });
    let endpoint = start_mock(state).await;
    let client = connect(&endpoint).await;

    let err = client
        .wait_ready("failed-job", Duration::from_secs(5))
        .await
        .unwrap_err();
    assert_eq!(err.code(), "connect");
}

#[tokio::test]
async fn wait_ready_surfaces_error_phase() {
    let state = Arc::new(MockState {
        phase_sequence: vec![proto::SandboxPhase::Error],
        ..Default::default()
    });
    let endpoint = start_mock(state.clone()).await;
    let client = connect(&endpoint).await;

    let err = client
        .wait_ready("my-box", Duration::from_secs(5))
        .await
        .unwrap_err();
    assert_eq!(err.code(), "connect");
}

#[tokio::test]
async fn wait_deleted_returns_when_get_reports_not_found() {
    for scoped in [false, true] {
        for expected_id in [None, Some("id-my-box")] {
            let state = Arc::new(MockState {
                phase_sequence: vec![proto::SandboxPhase::Deleting],
                not_found_after: Some(1),
                ..Default::default()
            });
            let endpoint = start_mock(state.clone()).await;
            let client = connect(&endpoint).await;
            let timeout = Duration::from_secs(5);
            if scoped {
                client
                    .workspace("team")
                    .wait_deleted("my-box", timeout, expected_id)
                    .await
            } else {
                client.wait_deleted("my-box", timeout, expected_id).await
            }
            .unwrap();
            assert_eq!(state.get_calls.load(Ordering::SeqCst), 2);
        }
    }
}

#[tokio::test]
async fn wait_deleted_completes_on_replacement_after_accepted_deletion() {
    for scoped in [false, true] {
        let state = Arc::new(MockState {
            get_sandbox_id: Some("replacement-id".to_string()),
            delete_response: Some(proto::DeleteSandboxResponse {
                outcome: proto::DeletionOutcome::Accepted.into(),
                sandbox_id: "old-id".to_string(),
            }),
            ..Default::default()
        });
        let endpoint = start_mock(state.clone()).await;
        let client = connect(&endpoint).await;
        let timeout = Duration::from_millis(50);
        let result = if scoped {
            client
                .workspace("team")
                .delete_sandbox("my-box", openshell_sdk::DeleteOptions::default())
                .await
        } else {
            client
                .delete_sandbox("my-box", openshell_sdk::DeleteOptions::default())
                .await
        }
        .unwrap();
        assert_eq!(result.outcome, openshell_sdk::DeletionOutcome::Accepted);
        assert_eq!(result.sandbox_id.as_deref(), Some("old-id"));
        if scoped {
            client
                .workspace("team")
                .wait_deleted("my-box", timeout, result.sandbox_id.as_deref())
                .await
        } else {
            client
                .wait_deleted("my-box", timeout, result.sandbox_id.as_deref())
                .await
        }
        .unwrap();
        assert_eq!(state.get_calls.load(Ordering::SeqCst), 1);
        let workspace = if scoped { "team" } else { "default" };
        assert_eq!(
            state.last_get_workspace.lock().await.as_deref(),
            Some(workspace)
        );
        assert_eq!(
            state.last_delete_workspace.lock().await.as_deref(),
            Some(workspace)
        );
    }
}

#[tokio::test]
async fn wait_deleted_does_not_complete_while_expected_identity_remains() {
    for scoped in [false, true] {
        let state = Arc::new(MockState {
            get_sandbox_id: Some("old-id".to_string()),
            ..Default::default()
        });
        let endpoint = start_mock(state.clone()).await;
        let client = connect(&endpoint).await;
        let timeout = Duration::ZERO;
        let error = if scoped {
            client
                .workspace("team")
                .wait_deleted("my-box", timeout, Some("old-id"))
                .await
        } else {
            client.wait_deleted("my-box", timeout, Some("old-id")).await
        }
        .unwrap_err();
        assert_eq!(error.code(), "connect");
        assert!(error.to_string().contains("timed out waiting"));
        assert_eq!(state.get_calls.load(Ordering::SeqCst), 1);
    }
}

#[tokio::test]
async fn wait_deleted_without_identity_waits_for_replacement_to_disappear() {
    for scoped in [false, true] {
        let state = Arc::new(MockState {
            get_sandbox_id: Some("replacement-id".to_string()),
            not_found_after: Some(1),
            ..Default::default()
        });
        let endpoint = start_mock(state.clone()).await;
        let client = connect(&endpoint).await;
        let timeout = Duration::from_secs(5);
        if scoped {
            client
                .workspace("team")
                .wait_deleted("my-box", timeout, None)
                .await
        } else {
            client.wait_deleted("my-box", timeout, None).await
        }
        .unwrap();
        assert_eq!(state.get_calls.load(Ordering::SeqCst), 2);
    }
}

#[tokio::test]
async fn wait_deleted_propagates_errors_other_than_not_found() {
    for scoped in [false, true] {
        for code in [tonic::Code::PermissionDenied, tonic::Code::Unavailable] {
            let state = Arc::new(MockState {
                get_error: Some(Status::new(code, "lookup failed")),
                ..Default::default()
            });
            let endpoint = start_mock(state.clone()).await;
            let client = connect(&endpoint).await;
            let timeout = Duration::from_secs(5);
            let error = if scoped {
                client
                    .workspace("team")
                    .wait_deleted("my-box", timeout, Some("old-id"))
                    .await
            } else {
                client.wait_deleted("my-box", timeout, Some("old-id")).await
            }
            .unwrap_err();
            assert_eq!(error.grpc_status().unwrap().code(), code);
            assert_eq!(state.get_calls.load(Ordering::SeqCst), 1);
        }
    }
}

#[tokio::test]
async fn get_sandbox_not_found_maps_to_typed_error() {
    let state = Arc::new(MockState {
        get_returns_not_found: true,
        ..Default::default()
    });
    let endpoint = start_mock(state.clone()).await;
    let client = connect(&endpoint).await;

    let err = client.get_sandbox("missing").await.unwrap_err();
    assert_eq!(err.code(), "not_found");
}

#[tokio::test]
async fn exec_buffers_stdout_stderr_and_exit() {
    let state = Arc::new(MockState {
        phase_sequence: vec![proto::SandboxPhase::Ready],
        ..Default::default()
    });
    let endpoint = start_mock(state.clone()).await;
    let client = connect(&endpoint).await;

    let result = client
        .exec(
            "my-box",
            &["echo".to_string(), "hello".to_string()],
            ExecOptions {
                workdir: Some("/work".to_string()),
                timeout: Some(Duration::from_secs(10)),
                ..Default::default()
            },
        )
        .await
        .unwrap();

    assert_eq!(result.exit_code, 7);
    assert_eq!(result.stdout, b"hello\n");
    assert_eq!(result.stderr, b"warn\n");

    let observed = state.last_exec_request.lock().await.clone().unwrap();
    assert_eq!(observed.sandbox, "my-box");
    assert_eq!(
        observed.command,
        vec!["echo".to_string(), "hello".to_string()]
    );
    assert_eq!(observed.workdir, "/work");
    assert_eq!(
        observed
            .execution_timeout
            .as_ref()
            .and_then(|value| openshell_core::time::duration_to_std(value).ok()),
        Some(Duration::from_secs(10))
    );
}

/// Refresher that hands out a fixed "fresh-token" and counts invocations.
struct OneShotRefresher {
    calls: Arc<AtomicU32>,
}

#[async_trait::async_trait]
impl Refresh for OneShotRefresher {
    async fn refresh(&self) -> Result<RefreshedToken, RefreshError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        let far_future = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs()
            + 3600;
        Ok(RefreshedToken::new("fresh-token").with_expires_at(far_future))
    }
}

/// A request rejected with `Unauthenticated` (revoked token that still looks
/// valid) must trigger a forced refresh and a single retry that succeeds.
#[tokio::test]
async fn reactive_refresh_recovers_from_unauthenticated() {
    let far_future = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs()
        + 3600;
    let state = Arc::new(MockState {
        require_bearer: Some("Bearer fresh-token".to_string()),
        ..Default::default()
    });
    let endpoint = start_mock(state.clone()).await;

    let calls = Arc::new(AtomicU32::new(0));
    let refresher = Arc::new(OneShotRefresher {
        calls: Arc::clone(&calls),
    });

    // Seed a stale-but-unexpired token: the proactive path won't refresh it
    // (expiry is far off), so only the reactive Unauthenticated path can.
    let mut config = ClientConfig::new(&endpoint);
    config.auth = Some(AuthConfig::Oidc {
        token: "stale-token".to_string(),
        expires_at: Some(far_future),
        refresh: Some(refresher),
    });
    let client = OpenShellClient::connect(config).await.unwrap();

    let health = client.health().await.unwrap();
    assert_eq!(health.status, SdkServiceStatus::Healthy);
    assert_eq!(
        calls.load(Ordering::SeqCst),
        1,
        "forced refresh should fire exactly once on Unauthenticated"
    );
    assert_eq!(
        state.unauth_hits.load(Ordering::SeqCst),
        1,
        "first request rejected with stale token, retry accepted with fresh token"
    );
}

/// Without a refresher, an `Unauthenticated` response is surfaced as an auth
/// error rather than retried in a loop.
#[tokio::test]
async fn unauthenticated_without_refresher_surfaces_error() {
    let state = Arc::new(MockState {
        require_bearer: Some("Bearer never-matches".to_string()),
        ..Default::default()
    });
    let endpoint = start_mock(state.clone()).await;

    let mut config = ClientConfig::new(&endpoint);
    config.auth = Some(AuthConfig::oidc("static-token"));
    let client = OpenShellClient::connect(config).await.unwrap();

    let err = client.health().await.unwrap_err();
    assert_eq!(err.code(), "auth", "expected an auth error, got: {err:?}");
    assert_eq!(
        state.unauth_hits.load(Ordering::SeqCst),
        1,
        "exactly one attempt; no retry without a refresher"
    );
}

// ---- Workspace-scoped client tests ----

#[tokio::test]
async fn workspace_scoped_create_passes_workspace() {
    let state = Arc::new(MockState::default());
    let endpoint = start_mock(state.clone()).await;
    let client = connect(&endpoint).await;

    let ws = client.workspace("staging");
    let spec = SandboxSpec {
        name: Some("my-box".to_string()),
        ..Default::default()
    };
    let result = ws.create_sandbox(spec).await.unwrap();
    assert_eq!(result.name, "my-box");

    let observed = state.last_create.lock().await.clone().unwrap();
    assert_eq!(
        selected_workspace(&observed.workspace_scope),
        Some("staging")
    );
}

#[tokio::test]
async fn workspace_scoped_create_from_template_passes_workspace() {
    let state = Arc::new(MockState::default());
    let endpoint = start_mock(state.clone()).await;
    let client = connect(&endpoint).await;

    let sandbox = client
        .workspace("staging")
        .create_sandbox_from_template(SandboxTemplateCreateSpec {
            name: Some("from-template".to_string()),
            template_name: "python".to_string(),
            policy: Some(proto::SandboxPolicy {
                version: 2,
                ..Default::default()
            }),
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(sandbox.name, "from-template");

    let observed = state.last_create.lock().await.clone().unwrap();
    assert_eq!(
        selected_workspace(&observed.workspace_scope),
        Some("staging")
    );
    assert_eq!(observed.workload_template, "python");
    assert_eq!(observed.spec.unwrap().policy.unwrap().version, 2);
}

#[tokio::test]
async fn workspace_scoped_get_passes_workspace() {
    let state = Arc::new(MockState {
        phase_sequence: vec![proto::SandboxPhase::Ready],
        ..Default::default()
    });
    let endpoint = start_mock(state.clone()).await;
    let client = connect(&endpoint).await;

    let ws = client.workspace("production");
    let sandbox = ws.get_sandbox("my-box").await.unwrap();
    assert_eq!(sandbox.name, "my-box");

    let observed_ws = state.last_get_workspace.lock().await.clone();
    assert_eq!(observed_ws.as_deref(), Some("production"));
}

#[tokio::test]
async fn workspace_scoped_list_passes_workspace() {
    let state = Arc::new(MockState::default());
    let endpoint = start_mock(state.clone()).await;
    let client = connect(&endpoint).await;

    let ws = client.workspace("dev");
    let items = ws.list_all_sandboxes(ListOptions::default()).await.unwrap();
    assert_eq!(items.len(), 2);

    let observed = state.last_list_request.lock().await.clone().unwrap();
    assert_eq!(selected_workspace(&observed.workspace_scope), Some("dev"));
}

#[tokio::test]
async fn workspace_scoped_sandbox_template_crud_passes_workspace() {
    let state = Arc::new(MockState::default());
    let endpoint = start_mock(state.clone()).await;
    let client = connect(&endpoint).await;
    let ws = client.workspace("staging");

    ws.create_sandbox_template(workload_template_proto("python", "staging"))
        .await
        .unwrap();
    let observed_create = state.last_template_create.lock().await.clone().unwrap();
    assert_eq!(
        selected_workspace(&observed_create.workspace_scope),
        Some("staging")
    );

    ws.get_sandbox_template("python").await.unwrap();
    let observed_get = state.last_template_get.lock().await.clone().unwrap();
    assert_eq!(observed_get.name, "python");
    assert_eq!(
        selected_workspace(&observed_get.workspace_scope),
        Some("staging")
    );

    let listed = ws
        .list_all_sandbox_templates(SandboxTemplateListOptions::default())
        .await
        .unwrap();
    assert_eq!(listed.len(), 2);
    let observed_list = state.last_template_list.lock().await.clone().unwrap();
    assert_eq!(
        selected_workspace(&observed_list.workspace_scope),
        Some("staging")
    );

    client
        .list_all_sandbox_templates_all_workspaces(SandboxTemplateListOptions::default())
        .await
        .unwrap();
    let observed_all = state.last_template_list.lock().await.clone().unwrap();
    assert!(selects_all_workspaces(&observed_all.workspace_scope));

    let deleted = ws
        .delete_sandbox_template("python", openshell_sdk::DeleteOptions::default())
        .await
        .unwrap();
    assert_eq!(deleted.outcome, openshell_sdk::DeletionOutcome::Completed);
    let observed_delete = state.last_template_delete.lock().await.clone().unwrap();
    assert_eq!(observed_delete.name, "python");
    assert_eq!(
        selected_workspace(&observed_delete.workspace_scope),
        Some("staging")
    );
}

#[tokio::test]
async fn workspace_scoped_delete_passes_workspace() {
    let state = Arc::new(MockState::default());
    let endpoint = start_mock(state.clone()).await;
    let client = connect(&endpoint).await;

    let ws = client.workspace("staging");
    let deleted = ws
        .delete_sandbox("doomed", openshell_sdk::DeleteOptions::default())
        .await
        .unwrap();
    assert_eq!(deleted.outcome, openshell_sdk::DeletionOutcome::Completed);

    let observed_ws = state.last_delete_workspace.lock().await.clone();
    assert_eq!(observed_ws.as_deref(), Some("staging"));
}

#[tokio::test]
async fn list_sandboxes_all_workspaces_sets_flag() {
    let state = Arc::new(MockState::default());
    let endpoint = start_mock(state.clone()).await;
    let client = connect(&endpoint).await;

    let items = client
        .list_all_sandboxes_all_workspaces(ListOptions::default())
        .await
        .unwrap();
    assert_eq!(items.len(), 2);

    let observed = state.last_list_request.lock().await.clone().unwrap();
    assert!(selects_all_workspaces(&observed.workspace_scope));
}

// ---- Workspace CRUD tests ----

#[tokio::test]
async fn create_workspace_returns_ref() {
    let state = Arc::new(MockState::default());
    let endpoint = start_mock(state.clone()).await;
    let client = connect(&endpoint).await;

    let ws = client
        .create_workspace("staging", HashMap::new())
        .await
        .unwrap();
    assert_eq!(ws.name, "staging");
    assert_eq!(ws.phase, "Active");

    let observed = state.last_workspace_request.lock().await.clone();
    assert_eq!(observed.as_deref(), Some("staging"));
}

#[tokio::test]
async fn get_workspace_returns_ref() {
    let state = Arc::new(MockState::default());
    let endpoint = start_mock(state.clone()).await;
    let client = connect(&endpoint).await;

    let ws = client.get_workspace("production").await.unwrap();
    assert_eq!(ws.name, "production");
    assert_eq!(ws.phase, "Active");

    let observed = state.last_workspace_request.lock().await.clone();
    assert_eq!(observed.as_deref(), Some("production"));
}

#[tokio::test]
async fn list_workspaces_returns_all() {
    let state = Arc::new(MockState::default());
    let endpoint = start_mock(state.clone()).await;
    let client = connect(&endpoint).await;

    let workspaces = client
        .list_all_workspaces(ListOptions::default())
        .await
        .unwrap();
    assert_eq!(workspaces.len(), 2);
    assert_eq!(workspaces[0].name, "default");
    assert_eq!(workspaces[1].name, "staging");
}

#[tokio::test]
async fn delete_workspace_returns_ack() {
    let state = Arc::new(MockState::default());
    let endpoint = start_mock(state.clone()).await;
    let client = connect(&endpoint).await;

    let deleted = client
        .delete_workspace("doomed", openshell_sdk::DeleteOptions::default())
        .await
        .unwrap();
    assert_eq!(deleted.outcome, openshell_sdk::DeletionOutcome::Completed);

    let observed = state.last_workspace_request.lock().await.clone();
    assert_eq!(observed.as_deref(), Some("doomed"));
}

#[tokio::test]
async fn sandbox_result_includes_workspace_field() {
    let state = Arc::new(MockState {
        phase_sequence: vec![proto::SandboxPhase::Ready],
        ..Default::default()
    });
    let endpoint = start_mock(state.clone()).await;
    let client = connect(&endpoint).await;

    let sandbox = client.get_sandbox("my-box").await.unwrap();
    assert_eq!(sandbox.workspace, "default");
}

/// Regression (P1): raw RPCs do not drive refresh. A call through the plain
/// `raw_grpc()` accessor keeps sending the seeded token, while
/// `raw_grpc_fresh()` proactively refreshes a near-expiry token into the
/// shared slot so the subsequent raw call is accepted.
#[tokio::test]
async fn raw_grpc_fresh_refreshes_before_raw_call() {
    let state = Arc::new(MockState {
        require_bearer: Some("Bearer fresh-token".to_string()),
        ..Default::default()
    });
    let endpoint = start_mock(state.clone()).await;

    let calls = Arc::new(AtomicU32::new(0));
    let refresher = Arc::new(OneShotRefresher {
        calls: Arc::clone(&calls),
    });

    // Near-expiry token so the proactive path will refresh it.
    let near = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs()
        + 5;
    let mut config = ClientConfig::new(&endpoint);
    config.auth = Some(AuthConfig::Oidc {
        token: "stale-token".to_string(),
        expires_at: Some(near),
        refresh: Some(refresher),
    });
    let client = OpenShellClient::connect(config).await.unwrap();

    // Plain raw accessor does not refresh: the seeded token is rejected.
    let err = client
        .raw_grpc()
        .health(proto::HealthRequest {})
        .await
        .unwrap_err();
    assert_eq!(err.code(), tonic::Code::Unauthenticated);
    assert_eq!(
        calls.load(Ordering::SeqCst),
        0,
        "raw_grpc must not trigger a refresh"
    );

    // _fresh accessor refreshes the near-expiry token first; the raw call is
    // then accepted with the fresh bearer.
    let mut grpc = client.raw_grpc_fresh().await.unwrap();
    grpc.health(proto::HealthRequest {}).await.unwrap();
    assert_eq!(
        calls.load(Ordering::SeqCst),
        1,
        "raw_grpc_fresh must refresh the near-expiry token exactly once"
    );
}

#[tokio::test]
async fn watch_logs_forwards_logs_and_warnings() {
    let state = Arc::new(MockState {
        phase_sequence: vec![proto::SandboxPhase::Ready],
        watch_script: vec![WatchDial {
            events: vec![
                log_event(1, "a"),
                warning_event("lagged"),
                log_event(2, "b"),
            ],
            end: DialEnd::Clean,
        }],
        ..Default::default()
    });
    let endpoint = start_mock(state.clone()).await;
    let client = connect(&endpoint).await;

    let stream = client.watch_logs("my-box", watch_opts());
    tokio::pin!(stream);

    match stream.next().await.unwrap().unwrap() {
        WatchEvent::Log { line, cursor } => {
            assert_eq!(cursor, test_cursor(1));
            assert_eq!(line.message, "a");
        }
        e => panic!("expected log, got {e:?}"),
    }

    assert!(matches!(
        stream.next().await.unwrap().unwrap(),
        WatchEvent::Warning { .. }
    ));
    match stream.next().await.unwrap().unwrap() {
        WatchEvent::Log { cursor, .. } => assert_eq!(cursor, test_cursor(2)),
        e => panic!("expected log, got {e:?}"),
    }
    assert!(stream.next().await.is_none());
}

#[tokio::test]
async fn watch_logs_resumes_after_reconnect() {
    let state = Arc::new(MockState {
        phase_sequence: vec![proto::SandboxPhase::Ready],
        watch_script: vec![
            WatchDial {
                events: vec![log_event(1, "a"), log_event(2, "b")],
                end: DialEnd::Err(tonic::Code::Unavailable),
            },
            WatchDial {
                events: vec![log_event(3, "c")],
                end: DialEnd::Clean,
            },
        ],
        ..Default::default()
    });
    let endpoint = start_mock(state.clone()).await;
    let client = connect(&endpoint).await;

    let stream = client.watch_logs("my-box", watch_opts());
    tokio::pin!(stream);
    for want in [1u64, 2, 3] {
        assert!(
            matches!(stream.next().await.unwrap().unwrap(), WatchEvent::Log { cursor, .. } if cursor == test_cursor(want))
        );
    }
    assert!(stream.next().await.is_none());

    let reqs = state.last_watch_requests.lock().await;
    assert_eq!(reqs.len(), 2);
    assert_eq!(reqs[0].resume_after_cursor, "");
    // Resumed from the highest delivered cursor, forwarded verbatim.
    assert_eq!(reqs[1].resume_after_cursor, test_cursor(2));
}

#[tokio::test]
async fn watch_logs_resumes_from_highest_cursor_when_arrival_is_unordered() {
    // The gateway reads the log and platform sources independently during live
    // delivery, so arrival order can differ from cursor order. The resume point
    // must be the highest cursor seen, not the last one.
    let state = Arc::new(MockState {
        phase_sequence: vec![proto::SandboxPhase::Ready],
        watch_script: vec![
            WatchDial {
                events: vec![log_event(3, "c"), log_event(1, "a")],
                end: DialEnd::Err(tonic::Code::Unavailable),
            },
            WatchDial {
                events: vec![log_event(4, "d")],
                end: DialEnd::Clean,
            },
        ],
        ..Default::default()
    });
    let endpoint = start_mock(state.clone()).await;
    let client = connect(&endpoint).await;

    let stream = client.watch_logs("my-box", watch_opts());
    tokio::pin!(stream);
    for want in [3u64, 1, 4] {
        assert!(
            matches!(stream.next().await.unwrap().unwrap(), WatchEvent::Log { cursor, .. } if cursor == test_cursor(want))
        );
    }
    assert!(stream.next().await.is_none());

    let reqs = state.last_watch_requests.lock().await;
    assert_eq!(reqs.len(), 2);
    // Cursor 1 arrived last but must not rewind the resume point to 1, which
    // would make the gateway replay cursors 2 and 3 all over again.
    assert_eq!(reqs[1].resume_after_cursor, test_cursor(3));
}

#[tokio::test]
async fn watch_logs_resume_cursor_is_padded_high_water() {
    // The high-water mark is a byte-wise string comparison on an opaque token,
    // so it is only correct while the sequence segment is a fixed width. Seq 9
    // then seq 10 is the case that catches an unpadded encoding: "...:9" sorts
    // above "...:10", so the resume point would rewind to 9 and the gateway
    // would replay an event the client already has.
    let state = Arc::new(MockState {
        phase_sequence: vec![proto::SandboxPhase::Ready],
        watch_script: vec![
            WatchDial {
                events: vec![log_event(9, "i"), log_event(10, "j")],
                end: DialEnd::Err(tonic::Code::Unavailable),
            },
            WatchDial {
                events: vec![],
                end: DialEnd::Clean,
            },
        ],
        ..Default::default()
    });
    let endpoint = start_mock(state.clone()).await;
    let client = connect(&endpoint).await;

    let stream = client.watch_logs("my-box", watch_opts());
    tokio::pin!(stream);
    for want in [9u64, 10] {
        assert!(
            matches!(stream.next().await.unwrap().unwrap(), WatchEvent::Log { cursor, .. } if cursor == test_cursor(want))
        );
    }
    assert!(stream.next().await.is_none());

    let reqs = state.last_watch_requests.lock().await;
    assert_eq!(reqs.len(), 2);
    assert_eq!(reqs[1].resume_after_cursor, test_cursor(10));
}

#[tokio::test]
async fn watch_logs_normalizes_empty_log_source_to_gateway() {
    let mut event = log_event(1, "a");
    if let Some(proto::sandbox_stream_event::Payload::Log(ref mut line)) = event.payload {
        line.source = String::new();
    }

    let state = Arc::new(MockState {
        phase_sequence: vec![proto::SandboxPhase::Ready],
        watch_script: vec![WatchDial {
            events: vec![event],
            end: DialEnd::Clean,
        }],
        ..Default::default()
    });
    let endpoint = start_mock(state.clone()).await;
    let client = connect(&endpoint).await;

    let stream = client.watch_logs("my-box", watch_opts());
    tokio::pin!(stream);
    let WatchEvent::Log { line, .. } = stream.next().await.unwrap().unwrap() else {
        panic!("expected a log event");
    };
    // The wire contract treats an omitted source as "gateway".
    assert_eq!(line.source, "gateway");
}

#[tokio::test]
async fn watch_logs_retries_initial_dial_failure() {
    let state = Arc::new(MockState {
        phase_sequence: vec![proto::SandboxPhase::Ready],
        watch_script: vec![
            // First dial fails before the stream opens.
            WatchDial {
                events: vec![],
                end: DialEnd::FailDial(tonic::Code::Unavailable),
            },
            // Second dial succeeds and delivers.
            WatchDial {
                events: vec![log_event(1, "a")],
                end: DialEnd::Clean,
            },
        ],
        ..Default::default()
    });
    let endpoint = start_mock(state.clone()).await;
    let client = connect(&endpoint).await;

    let stream = client.watch_logs("my-box", watch_opts());
    tokio::pin!(stream);
    assert!(matches!(
        stream.next().await.unwrap().unwrap(),
        WatchEvent::Log { ref cursor, .. } if *cursor == test_cursor(1)
    ));
    assert!(stream.next().await.is_none());

    let reqs = state.last_watch_requests.lock().await;
    assert_eq!(reqs.len(), 2); // dialed twice: failed, then reconnected
    assert_eq!(reqs[0].resume_after_cursor, "");
    assert_eq!(reqs[1].resume_after_cursor, ""); // nothing delivered yet on retry
}

#[tokio::test]
async fn watch_logs_gap_terminates_out_of_range() {
    let state = Arc::new(MockState {
        phase_sequence: vec![proto::SandboxPhase::Ready],
        watch_script: vec![WatchDial {
            events: vec![log_event(1, "a")],
            end: DialEnd::Err(tonic::Code::OutOfRange),
        }],
        ..Default::default()
    });
    let endpoint = start_mock(state.clone()).await;
    let client = connect(&endpoint).await;

    let stream = client.watch_logs("my-box", watch_opts());
    tokio::pin!(stream);
    assert!(matches!(
        stream.next().await.unwrap().unwrap(),
        WatchEvent::Log { ref cursor, .. } if *cursor == test_cursor(1)
    ));
    let err = stream.next().await.unwrap().unwrap_err();
    assert_eq!(err.code(), "out_of_range");
    assert!(stream.next().await.is_none());

    // No redial. OUT_OF_RANGE is terminal for every cause the gateway uses it
    // for -- a trimmed cursor or one from a retired cursor space -- because
    // reconnecting would silently paper over events that are already lost.
    assert_eq!(state.last_watch_requests.lock().await.len(), 1);
}

// `sandbox` addresses a workspace-scoped canonical name, and the mock's
// `id-{name}` ids differ from the names, so sending a resolved object id here
// reaches the gateway as NOT_FOUND and the watch never streams.
#[tokio::test]
async fn watch_logs_addresses_the_sandbox_by_canonical_name() {
    for workspace in ["default", "production"] {
        let state = Arc::new(MockState {
            phase_sequence: vec![proto::SandboxPhase::Ready],
            watch_script: vec![WatchDial {
                events: vec![log_event(1, "a")],
                end: DialEnd::Clean,
            }],
            ..Default::default()
        });
        let endpoint = start_mock(state.clone()).await;
        let client = connect(&endpoint).await;

        let scoped = client.workspace(workspace);
        let mut stream: std::pin::Pin<Box<dyn tokio_stream::Stream<Item = _>>> =
            if workspace == "default" {
                Box::pin(client.watch_logs("watched", watch_opts()))
            } else {
                Box::pin(scoped.watch_logs("watched", watch_opts()))
            };

        assert!(
            matches!(
                stream.next().await.unwrap().unwrap(),
                WatchEvent::Log { ref cursor, .. } if *cursor == test_cursor(1)
            ),
            "{workspace}: first event must stream"
        );

        let reqs = state.last_watch_requests.lock().await;
        assert_eq!(reqs.len(), 1, "{workspace}");
        assert_eq!(reqs[0].sandbox, "watched", "{workspace}: name, not id");
        assert_eq!(
            selected_workspace(&reqs[0].workspace_scope),
            Some(workspace)
        );
    }
}
