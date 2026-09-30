// SPDX-FileCopyrightText: Copyright (c) 2025-2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! High-level async client over the gateway gRPC surface.
//!
//! Covers the sandbox-focused MVP slice: health, sandbox CRUD, readiness /
//! deletion waits, and non-streaming exec. Other RPCs (providers, policy,
//! logs, settings, SSH, and forwarding) are reachable via
//! [`OpenShellClient::raw_grpc`].

use crate::auth::{BearerSlot, EdgeAuthInterceptor, bearer_metadata};
use crate::config::{AuthConfig, ClientConfig};
use crate::error::{Result, SdkError};
use crate::pagination::{Page, Pager};
use crate::raw::AuthedGrpcClient;
use crate::refresh::{RefreshedToken, TokenSource};
use crate::types::{
    DeleteOptions, DeletionResult, ExecOptions, ExecResult, Health, ListOptions, SandboxPhase,
    SandboxRef, SandboxSpec, SandboxTemplateCreateSpec, SandboxTemplateListOptions,
    SandboxWorkloadTemplate, WorkspaceRef,
};
use crate::{WatchEvent, WatchOptions, transport};
use futures::{Stream, StreamExt};
use openshell_core::proto;
use std::collections::HashMap;
use std::future::Future;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tonic::transport::Channel;

/// Async client for a single `OpenShell` gateway.
///
/// Cheap to clone — the underlying tonic [`Channel`] multiplexes RPCs over a
/// shared HTTP/2 connection. Construct one per logical gateway and share it
/// across tasks; do not call [`OpenShellClient::connect`] per request.
#[derive(Clone)]
pub struct OpenShellClient {
    channel: Channel,
    interceptor: EdgeAuthInterceptor,
    /// Drives OIDC token rotation. `None` when auth is static (edge token,
    /// anonymous, or an OIDC token with no refresher).
    token_source: Option<TokenSource>,
    /// Live bearer slot the interceptor reads; refreshed tokens are written
    /// here so rotation reaches in-flight requests. `None` for non-OIDC auth.
    bearer_slot: Option<BearerSlot>,
}

impl OpenShellClient {
    /// Open a connection to the gateway described by `config`.
    ///
    /// Performs the gRPC channel handshake immediately; subsequent RPCs reuse
    /// the connection.
    pub async fn connect(config: ClientConfig) -> Result<Self> {
        let channel = transport::build_channel(&config).await?;
        let interceptor = interceptor_from_config(&config)?;
        let bearer_slot = interceptor.bearer_slot();
        let token_source = token_source_from_config(&config);
        Ok(Self {
            channel,
            interceptor,
            token_source,
            bearer_slot,
        })
    }

    /// Construct from an already-built [`Channel`] and interceptor.
    ///
    /// Use when the caller needs to customize channel construction beyond
    /// what [`ClientConfig`] exposes. The resulting client does not perform
    /// OIDC refresh; drive rotation externally via the interceptor's slot.
    pub fn from_parts(channel: Channel, interceptor: EdgeAuthInterceptor) -> Self {
        let bearer_slot = interceptor.bearer_slot();
        Self {
            channel,
            interceptor,
            token_source: None,
            bearer_slot,
        }
    }

    /// Underlying tonic [`Channel`].
    pub fn channel(&self) -> Channel {
        self.channel.clone()
    }

    /// Authenticated gRPC client for the main `OpenShell` service.
    ///
    /// Use this when the curated surface below doesn't expose the RPC or
    /// field you need.
    ///
    /// This does **not** drive OIDC refresh: it returns a client bound to
    /// the interceptor's current bearer slot without checking expiry or
    /// retrying on `Unauthenticated`. A client that only ever issues raw
    /// RPCs keeps sending the initial token until it expires. When a
    /// refresher is wired, prefer [`OpenShellClient::raw_grpc_fresh`] (or
    /// interleave a curated call) so rotation reaches the shared slot, and
    /// call [`OpenShellClient::force_refresh`] to recover on a rejected
    /// token.
    pub fn raw_grpc(&self) -> AuthedGrpcClient {
        proto::open_shell_client::OpenShellClient::with_interceptor(
            self.channel.clone(),
            self.interceptor.clone(),
        )
    }

    /// Like [`OpenShellClient::raw_grpc`], but proactively refreshes the
    /// bearer token first when a refresher is wired and the token is within
    /// the refresh skew of expiry. The returned client reads the same live
    /// slot, so the refreshed token applies to every RPC issued through it.
    ///
    /// Reactive retry on `Unauthenticated` remains the caller's
    /// responsibility for raw RPCs: on a rejected token, call
    /// [`OpenShellClient::force_refresh`] and reissue.
    pub async fn raw_grpc_fresh(&self) -> Result<AuthedGrpcClient> {
        self.ensure_fresh().await?;
        Ok(self.raw_grpc())
    }

    /// Force an OIDC refresh and write the new token into the live bearer
    /// slot, regardless of expiry. Returns `true` when a refresher is wired
    /// and a fresh token was minted, `false` for static auth. Use after a
    /// raw RPC returns `Unauthenticated` to recover before reissuing it.
    pub async fn force_refresh(&self) -> Result<bool> {
        self.refresh_on_unauthorized().await
    }

    /// Gateway health snapshot.
    pub async fn health(&self) -> Result<Health> {
        let resp = self
            .unary(|mut grpc| async move { grpc.health(proto::HealthRequest {}).await })
            .await?;
        Ok(Health {
            status: resp.status.into(),
            version: resp.version,
        })
    }

    /// Create a new sandbox from a curated [`SandboxSpec`].
    pub async fn create_sandbox(&self, spec: SandboxSpec) -> Result<SandboxRef> {
        let request = create_sandbox_request(spec);
        let response = self
            .unary(|mut grpc| {
                let request = request.clone();
                async move { grpc.create_sandbox(request).await }
            })
            .await?;
        sandbox_from_create_response(response)
    }

    /// Create a new sandbox from a workspace-scoped workload template name.
    pub async fn create_sandbox_from_template(
        &self,
        spec: SandboxTemplateCreateSpec,
    ) -> Result<SandboxRef> {
        let request = create_sandbox_from_template_request(spec);
        let response = self
            .unary(|mut grpc| {
                let request = request.clone();
                async move { grpc.create_sandbox(request).await }
            })
            .await?;
        sandbox_from_create_response(response)
    }

    /// Create a reusable sandbox template in the default workspace.
    pub async fn create_sandbox_template(
        &self,
        template: SandboxWorkloadTemplate,
    ) -> Result<SandboxWorkloadTemplate> {
        let response = self
            .unary(|mut grpc| {
                let request = proto::CreateSandboxTemplateRequest {
                    request_id: String::new(),
                    template: Some(template.clone()),
                    workspace_scope: Some(proto::workspace_selector("default")),
                };
                async move { grpc.create_sandbox_template(request).await }
            })
            .await?;
        sandbox_template_from_response(response.template)
    }

    /// Fetch a reusable sandbox template by name from the default workspace.
    pub async fn get_sandbox_template(&self, name: &str) -> Result<SandboxWorkloadTemplate> {
        let response = self
            .unary(|mut grpc| {
                let request = proto::GetSandboxTemplateRequest {
                    name: name.to_string(),
                    workspace_scope: Some(proto::workspace_selector("default")),
                };
                async move { grpc.get_sandbox_template(request).await }
            })
            .await?;
        sandbox_template_from_response(response.template)
    }

    /// List reusable sandbox templates in the default workspace.
    pub fn list_sandbox_templates(
        &self,
        opts: SandboxTemplateListOptions,
    ) -> Pager<SandboxWorkloadTemplate> {
        let client = self.clone();
        let initial_page_token = opts.page_token.clone();
        Pager::new(initial_page_token, move |page_token| {
            let client = client.clone();
            let opts = opts.clone();
            async move {
                let response = client
                    .unary(|mut grpc| {
                        let page_token = page_token.clone();
                        let request = proto::ListSandboxTemplatesRequest {
                            page_size: opts.page_size,
                            page_token,
                            label_selector: opts.label_selector.clone(),
                            workspace_scope: Some(proto::workspace_selector("default")),
                        };
                        async move { grpc.list_sandbox_templates(request).await }
                    })
                    .await?;
                Ok(Page {
                    items: response.templates,
                    next_page_token: response.next_page_token,
                })
            }
        })
    }

    /// List and collect every reusable sandbox template.
    pub async fn list_all_sandbox_templates(
        &self,
        opts: SandboxTemplateListOptions,
    ) -> Result<Vec<SandboxWorkloadTemplate>> {
        self.list_sandbox_templates(opts).collect_all().await
    }

    /// List reusable sandbox templates across all workspaces.
    pub fn list_sandbox_templates_all_workspaces(
        &self,
        opts: SandboxTemplateListOptions,
    ) -> Pager<SandboxWorkloadTemplate> {
        let client = self.clone();
        let initial_page_token = opts.page_token.clone();
        Pager::new(initial_page_token, move |page_token| {
            let client = client.clone();
            let opts = opts.clone();
            async move {
                let response = client
                    .unary(|mut grpc| {
                        let page_token = page_token.clone();
                        let request = proto::ListSandboxTemplatesRequest {
                            page_size: opts.page_size,
                            page_token,
                            label_selector: opts.label_selector.clone(),
                            workspace_scope: Some(proto::all_workspaces_selector()),
                        };
                        async move { grpc.list_sandbox_templates(request).await }
                    })
                    .await?;
                Ok(Page {
                    items: response.templates,
                    next_page_token: response.next_page_token,
                })
            }
        })
    }

    /// List and collect every reusable sandbox template across all workspaces.
    pub async fn list_all_sandbox_templates_all_workspaces(
        &self,
        opts: SandboxTemplateListOptions,
    ) -> Result<Vec<SandboxWorkloadTemplate>> {
        self.list_sandbox_templates_all_workspaces(opts)
            .collect_all()
            .await
    }

    /// Delete a reusable sandbox template by name from the default workspace.
    pub async fn delete_sandbox_template(
        &self,
        name: &str,
        opts: DeleteOptions,
    ) -> Result<DeletionResult> {
        let response = self
            .unary(|mut grpc| {
                let request = proto::DeleteSandboxTemplateRequest {
                    request_id: String::new(),
                    allow_missing: opts.allow_missing,
                    name: name.to_string(),
                    workspace_scope: Some(proto::workspace_selector("default")),
                };
                async move { grpc.delete_sandbox_template(request).await }
            })
            .await?;
        Ok(DeletionResult {
            outcome: response.outcome.into(),
            sandbox_id: None,
        })
    }

    /// Fetch a sandbox by name.
    pub async fn get_sandbox(&self, name: &str) -> Result<SandboxRef> {
        let response = self
            .unary(|mut grpc| {
                let request = proto::GetSandboxRequest {
                    name: name.to_string(),
                    workspace_scope: Some(proto::workspace_selector("default")),
                };
                async move { grpc.get_sandbox(request).await }
            })
            .await?;
        sandbox_from_response(response.sandbox)
    }

    /// List sandboxes.
    pub fn list_sandboxes(&self, opts: ListOptions) -> Pager<SandboxRef> {
        let client = self.clone();
        let initial_page_token = opts.page_token.clone();
        Pager::new(initial_page_token, move |page_token| {
            let client = client.clone();
            let opts = opts.clone();
            async move {
                let response = client
                    .unary(|mut grpc| {
                        let page_token = page_token.clone();
                        let request = proto::ListSandboxesRequest {
                            page_size: opts.page_size,
                            page_token,
                            label_selector: opts.label_selector.clone().unwrap_or_default(),
                            workspace_scope: Some(proto::workspace_selector("default")),
                        };
                        async move { grpc.list_sandboxes(request).await }
                    })
                    .await?;
                Ok(Page {
                    items: response
                        .sandboxes
                        .into_iter()
                        .map(SandboxRef::from_proto)
                        .collect(),
                    next_page_token: response.next_page_token,
                })
            }
        })
    }

    /// List and collect every sandbox in the default workspace.
    pub async fn list_all_sandboxes(&self, opts: ListOptions) -> Result<Vec<SandboxRef>> {
        self.list_sandboxes(opts).collect_all().await
    }

    /// Delete a sandbox by name.
    ///
    /// An accepted outcome is not completion. The result identifies the original
    /// sandbox; a same-name replacement is not part of this operation.
    pub async fn delete_sandbox(&self, name: &str, opts: DeleteOptions) -> Result<DeletionResult> {
        let response = self
            .unary(|mut grpc| {
                let request = proto::DeleteSandboxRequest {
                    request_id: String::new(),
                    allow_missing: opts.allow_missing,
                    name: name.to_string(),
                    workspace_scope: Some(proto::workspace_selector("default")),
                };
                async move { grpc.delete_sandbox(request).await }
            })
            .await?;
        Ok(DeletionResult {
            outcome: response.outcome.into(),
            sandbox_id: (!response.sandbox_id.is_empty()).then_some(response.sandbox_id),
        })
    }

    /// Stop a sandbox by name.
    pub async fn stop_sandbox(&self, name: &str) -> Result<SandboxRef> {
        let response = self
            .unary(|mut grpc| {
                let request = proto::StopSandboxRequest {
                    request_id: String::new(),
                    name: name.to_string(),
                    workspace_scope: Some(proto::workspace_selector("default")),
                };
                async move { grpc.stop_sandbox(request).await }
            })
            .await?;
        sandbox_from_response(response.sandbox)
    }

    /// Start a stopped sandbox by name.
    pub async fn start_sandbox(&self, name: &str) -> Result<SandboxRef> {
        let response = self
            .unary(|mut grpc| {
                let request = proto::StartSandboxRequest {
                    request_id: String::new(),
                    name: name.to_string(),
                    workspace_scope: Some(proto::workspace_selector("default")),
                };
                async move { grpc.start_sandbox(request).await }
            })
            .await?;
        sandbox_from_response(response.sandbox)
    }

    /// Poll [`OpenShellClient::get_sandbox`] until the sandbox reaches
    /// [`SandboxPhase::Ready`] or successful [`SandboxPhase::Completed`], or
    /// until the `timeout` elapses.
    ///
    /// Returns the terminal sandbox snapshot on success. Returns an
    /// [`SdkError::Connect`] when the timeout expires, or whatever error
    /// the gateway returns if the sandbox transitions into
    /// [`SandboxPhase::Stopped`] or [`SandboxPhase::Error`].
    pub async fn wait_ready(&self, name: &str, timeout: Duration) -> Result<SandboxRef> {
        self.wait_for(name, timeout, |phase| match phase {
            SandboxPhase::Ready | SandboxPhase::Completed => Some(Ok(())),
            SandboxPhase::Stopped => Some(Err(SdkError::connect(format!(
                "sandbox '{name}' main process failed"
            )))),
            SandboxPhase::Error => Some(Err(SdkError::connect(format!(
                "sandbox '{name}' entered error phase"
            )))),
            _ => None,
        })
        .await
    }

    /// Poll until the sandbox is gone (gRPC `NotFound`) or the timeout elapses.
    ///
    /// Pass the deletion result's `sandbox_id` as `expected_sandbox_id` to also
    /// complete when the name resolves to a different sandbox. With `None`,
    /// waits for the name to be absent, including any same-name replacement.
    pub async fn wait_deleted(
        &self,
        name: &str,
        timeout: Duration,
        expected_sandbox_id: Option<&str>,
    ) -> Result<()> {
        let deadline = Instant::now() + timeout;
        let mut delay = Duration::from_millis(250);
        loop {
            match self.get_sandbox(name).await {
                Err(SdkError::NotFound { .. }) => return Ok(()),
                Err(other) => return Err(other),
                Ok(snapshot) if expected_sandbox_id.is_some_and(|id| snapshot.id != id) => {
                    return Ok(());
                }
                Ok(_) => {}
            }
            if Instant::now() >= deadline {
                return Err(SdkError::connect(format!(
                    "timed out waiting for sandbox '{name}' to delete"
                )));
            }
            tokio::time::sleep(delay).await;
            delay = (delay * 2).min(Duration::from_secs(2));
        }
    }

    /// Return a workspace-scoped handle for sandbox operations.
    ///
    /// Analogous to `kube::Api::namespaced` — captures the workspace once and
    /// injects it into every request.
    pub fn workspace(&self, workspace: &str) -> WorkspaceScopedClient {
        WorkspaceScopedClient {
            client: self.clone(),
            workspace: workspace.to_string(),
        }
    }

    /// List sandboxes across all workspaces.
    pub fn list_sandboxes_all_workspaces(&self, opts: ListOptions) -> Pager<SandboxRef> {
        let client = self.clone();
        let initial_page_token = opts.page_token.clone();
        Pager::new(initial_page_token, move |page_token| {
            let client = client.clone();
            let opts = opts.clone();
            async move {
                let response = client
                    .unary(|mut grpc| {
                        let page_token = page_token.clone();
                        let request = proto::ListSandboxesRequest {
                            page_size: opts.page_size,
                            page_token,
                            label_selector: opts.label_selector.clone().unwrap_or_default(),
                            workspace_scope: Some(proto::all_workspaces_selector()),
                        };
                        async move { grpc.list_sandboxes(request).await }
                    })
                    .await?;
                Ok(Page {
                    items: response
                        .sandboxes
                        .into_iter()
                        .map(SandboxRef::from_proto)
                        .collect(),
                    next_page_token: response.next_page_token,
                })
            }
        })
    }

    /// List and collect every sandbox across all workspaces.
    pub async fn list_all_sandboxes_all_workspaces(
        &self,
        opts: ListOptions,
    ) -> Result<Vec<SandboxRef>> {
        self.list_sandboxes_all_workspaces(opts).collect_all().await
    }

    /// Create a new workspace.
    pub async fn create_workspace(
        &self,
        name: &str,
        labels: HashMap<String, String>,
    ) -> Result<WorkspaceRef> {
        let response = self
            .unary(|mut grpc| {
                let request = proto::CreateWorkspaceRequest {
                    request_id: String::new(),
                    name: name.to_string(),
                    labels: labels.clone(),
                };
                async move { grpc.create_workspace(request).await }
            })
            .await?;
        response
            .workspace
            .map(WorkspaceRef::from_proto)
            .ok_or_else(|| SdkError::invalid_config("workspace missing from gateway response"))
    }

    /// Fetch a workspace by name.
    pub async fn get_workspace(&self, name: &str) -> Result<WorkspaceRef> {
        let response = self
            .unary(|mut grpc| {
                let request = proto::GetWorkspaceRequest {
                    name: name.to_string(),
                };
                async move { grpc.get_workspace(request).await }
            })
            .await?;
        response
            .workspace
            .map(WorkspaceRef::from_proto)
            .ok_or_else(|| SdkError::invalid_config("workspace missing from gateway response"))
    }

    /// List workspaces.
    pub fn list_workspaces(&self, opts: ListOptions) -> Pager<WorkspaceRef> {
        let client = self.clone();
        let initial_page_token = opts.page_token.clone();
        Pager::new(initial_page_token, move |page_token| {
            let client = client.clone();
            let opts = opts.clone();
            async move {
                let response = client
                    .unary(|mut grpc| {
                        let page_token = page_token.clone();
                        let request = proto::ListWorkspacesRequest {
                            page_size: opts.page_size,
                            page_token,
                            label_selector: opts.label_selector.clone().unwrap_or_default(),
                        };
                        async move { grpc.list_workspaces(request).await }
                    })
                    .await?;
                Ok(Page {
                    items: response
                        .workspaces
                        .into_iter()
                        .map(WorkspaceRef::from_proto)
                        .collect(),
                    next_page_token: response.next_page_token,
                })
            }
        })
    }

    /// List and collect every workspace.
    pub async fn list_all_workspaces(&self, opts: ListOptions) -> Result<Vec<WorkspaceRef>> {
        self.list_workspaces(opts).collect_all().await
    }

    /// Delete a workspace by name.
    pub async fn delete_workspace(
        &self,
        name: &str,
        opts: DeleteOptions,
    ) -> Result<DeletionResult> {
        let response = self
            .unary(|mut grpc| {
                let request = proto::DeleteWorkspaceRequest {
                    request_id: String::new(),
                    allow_missing: opts.allow_missing,
                    name: name.to_string(),
                };
                async move { grpc.delete_workspace(request).await }
            })
            .await?;
        Ok(DeletionResult {
            outcome: response.outcome.into(),
            sandbox_id: None,
        })
    }

    /// Run a command inside a sandbox and buffer stdout/stderr to the end.
    ///
    /// For streaming output, drop down to [`OpenShellClient::raw_grpc`] and
    /// call `exec_sandbox` directly.
    pub async fn exec(&self, name: &str, cmd: &[String], opts: ExecOptions) -> Result<ExecResult> {
        let request = proto::ExecSandboxRequest {
            request_id: String::new(),
            sandbox: name.to_string(),
            workspace_scope: Some(proto::workspace_selector("default")),
            command: cmd.to_vec(),
            workdir: opts.workdir.unwrap_or_default(),
            environment: opts.environment,
            execution_timeout: opts
                .timeout
                .map(openshell_core::time::duration_from_std)
                .transpose()
                .map_err(|error| SdkError::invalid_config(error.to_string()))?,
            stdin: opts.stdin.unwrap_or_default(),
            tty: false,
            cols: 0,
            rows: 0,
            no_login_shell: opts.no_login_shell,
        };

        // Open the stream under the same OIDC-aware auth policy as unary RPCs
        // (proactive refresh, then one reactive retry on `Unauthenticated`).
        // Mid-stream rotation is out of scope; streaming retry is tracked
        // separately.
        let mut stream = self
            .unary(|mut grpc| {
                let request = request.clone();
                async move { grpc.exec_sandbox(request).await }
            })
            .await?;

        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        let mut exit_code: Option<i32> = None;

        while let Some(event) = stream.next().await {
            let event = event.map_err(map_status)?;
            match event.payload {
                Some(proto::exec_sandbox_event::Payload::Stdout(chunk)) => {
                    stdout.extend_from_slice(&chunk.data);
                }
                Some(proto::exec_sandbox_event::Payload::Stderr(chunk)) => {
                    stderr.extend_from_slice(&chunk.data);
                }
                Some(proto::exec_sandbox_event::Payload::Exit(exit)) => {
                    exit_code = Some(exit.exit_code);
                }
                None => {}
            }
        }

        Ok(ExecResult {
            exit_code: exit_code.unwrap_or(-1),
            stdout,
            stderr,
        })
    }

    /// Watch a sandbox's logs and platform events with loss-aware resume.
    ///
    /// Reconnects transparently on transient stream errors, resuming from the
    /// highest cursor already delivered. A recoverable server lag surfaces as
    /// [`WatchEvent::Warning`] and the stream continues.
    ///
    /// [`SdkError::OutOfRange`] is terminal and deliberately not retried: it
    /// means the resume point is gone (trimmed from the buffer, or issued by a
    /// cursor space the gateway no longer has), so events between it and now
    /// are unrecoverable. Auto-restarting from scratch would hide that loss,
    /// which is exactly what this API exists to surface. Callers who accept the
    /// gap can start a new watch with an empty
    /// [`WatchOptions::resume_after_cursor`]; retrying the same cursor fails
    /// identically.
    pub fn watch_logs(
        &self,
        name: &str,
        opts: WatchOptions,
    ) -> impl Stream<Item = Result<WatchEvent>> + '_ {
        let name = name.to_string();
        async_stream::try_stream!(
            let sandbox = self.get_sandbox(&name).await?;
            for await event in self.watch_logs_by_name(sandbox.name, "default".to_string(), opts) {
                yield event?;
            }
        )
    }

    /// Shared watch loop over an already-resolved canonical sandbox name.
    ///
    /// Both [`OpenShellClient::watch_logs`] and
    /// [`WorkspaceScopedClient::watch_logs`] resolve and re-confirm a name under
    /// their own workspace, then delegate here so the reconnect/resume logic
    /// lives in one place.
    fn watch_logs_by_name(
        &self,
        sandbox_name: String,
        workspace: String,
        opts: WatchOptions,
    ) -> impl Stream<Item = Result<WatchEvent>> + '_ {
        async_stream::try_stream!(
            let mut cursor = opts.resume_after_cursor;
            let mut backoff = Duration::from_millis(100);
            loop {
                let request = proto::WatchSandboxRequest {
                    sandbox: sandbox_name.clone(),
                    workspace_scope: Some(proto::workspace_selector(&workspace)),
                    follow_status: false,
                    follow_logs: opts.follow_logs,
                    follow_events: opts.follow_events,
                    log_tail_lines: opts.log_tail_lines,
                    event_tail: opts.event_tail,
                    log_sources: opts.log_sources.clone(),
                    log_min_level: opts.log_min_level.clone().unwrap_or_default(),
                    resume_after_cursor: cursor.clone(),
                    ..Default::default()
                };
                // Apply the same reconnect policy to the initial dial: `unary`
                // only retries `Unauthenticated`, so a pre-stream transient
                // (e.g. `Unavailable`) would otherwise exit without resuming.
                let mut stream = match self
                    .unary(|mut grpc| {
                        let req = request.clone();
                        async move { grpc.watch_sandbox(req).await }
                    })
                    .await
                {
                    Ok(stream) => stream,
                    // Transient — back off and redial from `cursor`.
                    Err(err) if is_retryable_stream(&err) => {
                        tokio::time::sleep(backoff).await;
                        backoff = (backoff * 2).min(Duration::from_secs(2));
                        continue;
                    }
                    // Trimmed cursor or any other error — terminal.
                    Err(err) => Err(err)?,
                };
                let mut clean_eof = true;
                while let Some(item) = stream.next().await {
                    match item {
                        Ok(event) => {
                            // A delivered event means the connection is healthy
                            // again; reset the reconnect backoff so a later drop
                            // retries promptly instead of at the capped delay.
                            backoff = Duration::from_millis(100);
                            if let Some(ev) = convert_event(event, &mut cursor) {
                                yield ev;
                            }
                        }
                        Err(status) => {
                            clean_eof = false;
                            let err = map_status(status);
                            match err {
                                // Terminal gap — never silently restart.
                                SdkError::OutOfRange { .. } => {
                                    Err(err)?;
                                }
                                // Transient — back off and redial from `cursor`.
                                _ if is_retryable_stream(&err) => {
                                    tokio::time::sleep(backoff).await;
                                    backoff = (backoff * 2).min(Duration::from_secs(2));
                                }
                                // Anything else is terminal.
                                _ => {
                                    Err(err)?;
                                }
                            }
                            break;
                        }
                    }
                }
                if clean_eof {
                    break;
                }
            }
        )
    }

    /// Run a unary RPC with OIDC-aware auth: refresh proactively before the
    /// call (if the token is near expiry) and, on an `Unauthenticated`
    /// response, force a refresh and retry exactly once. No-op auth behaves
    /// as a plain single call.
    async fn unary<T, F, Fut>(&self, call: F) -> Result<T>
    where
        F: Fn(AuthedGrpcClient) -> Fut,
        Fut: Future<Output = std::result::Result<tonic::Response<T>, tonic::Status>>,
    {
        self.ensure_fresh().await?;
        match call(self.raw_grpc()).await {
            Ok(resp) => Ok(resp.into_inner()),
            Err(status) if status.code() == tonic::Code::Unauthenticated => {
                if self.refresh_on_unauthorized().await? {
                    call(self.raw_grpc())
                        .await
                        .map(tonic::Response::into_inner)
                        .map_err(map_status)
                } else {
                    Err(map_status(status))
                }
            }
            Err(status) => Err(map_status(status)),
        }
    }

    /// Proactive refresh: if a token source is wired and the token is within
    /// the refresh skew of expiry, mint a new one and store it in the live
    /// bearer slot. Tokens with no advertised expiry are left untouched.
    async fn ensure_fresh(&self) -> Result<()> {
        if let (Some(source), Some(slot)) = (&self.token_source, &self.bearer_slot) {
            // Proactive refresh is best-effort: on a transient failure (e.g. an
            // IdP blip) the token already in the slot may still be valid, so
            // fall through and let the request proceed. A genuinely
            // expired/rejected token surfaces as `Unauthenticated`, which
            // drives the reactive refresh in `refresh_on_unauthorized`.
            match source.current().await {
                Ok(token) => store_bearer(slot, &token)?,
                Err(err) => {
                    tracing::debug!(
                        error = %err,
                        "proactive token refresh failed; using existing token"
                    );
                }
            }
        }
        Ok(())
    }

    /// Reactive refresh: force a new token (used on `Unauthenticated`) and
    /// store it in the live slot. Returns `false` when no refresher is wired,
    /// signalling the caller to surface the original error.
    async fn refresh_on_unauthorized(&self) -> Result<bool> {
        if let (Some(source), Some(slot)) = (&self.token_source, &self.bearer_slot) {
            let token = source.refresh_now().await?;
            store_bearer(slot, &token)?;
            Ok(true)
        } else {
            Ok(false)
        }
    }

    async fn wait_for<F>(&self, name: &str, timeout: Duration, mut decide: F) -> Result<SandboxRef>
    where
        F: FnMut(SandboxPhase) -> Option<Result<()>>,
    {
        let deadline = Instant::now() + timeout;
        let mut delay = Duration::from_millis(250);
        loop {
            let snapshot = self.get_sandbox(name).await?;
            if let Some(verdict) = decide(snapshot.phase) {
                verdict?;
                return Ok(snapshot);
            }
            if Instant::now() >= deadline {
                return Err(SdkError::connect(format!(
                    "timed out waiting for sandbox '{name}'"
                )));
            }
            tokio::time::sleep(delay).await;
            delay = (delay * 2).min(Duration::from_secs(2));
        }
    }
}

/// Workspace-scoped sandbox operations, analogous to `kube::Api::namespaced`.
///
/// Constructed via [`OpenShellClient::workspace`]. Captures the workspace
/// once and injects it into every request.
#[derive(Clone)]
pub struct WorkspaceScopedClient {
    client: OpenShellClient,
    workspace: String,
}

impl WorkspaceScopedClient {
    /// The workspace this client targets.
    pub fn workspace_name(&self) -> &str {
        &self.workspace
    }

    /// Create a new sandbox in this workspace.
    pub async fn create_sandbox(&self, spec: SandboxSpec) -> Result<SandboxRef> {
        let mut request = create_sandbox_request(spec);
        request.workspace_scope = Some(proto::workspace_selector(&self.workspace));
        let response = self
            .client
            .unary(|mut grpc| {
                let request = request.clone();
                async move { grpc.create_sandbox(request).await }
            })
            .await?;
        sandbox_from_create_response(response)
    }

    /// Create a new sandbox from a template in this workspace.
    pub async fn create_sandbox_from_template(
        &self,
        spec: SandboxTemplateCreateSpec,
    ) -> Result<SandboxRef> {
        let mut request = create_sandbox_from_template_request(spec);
        request.workspace_scope = Some(proto::workspace_selector(&self.workspace));
        let response = self
            .client
            .unary(|mut grpc| {
                let request = request.clone();
                async move { grpc.create_sandbox(request).await }
            })
            .await?;
        sandbox_from_create_response(response)
    }

    /// Create a reusable sandbox template in this workspace.
    pub async fn create_sandbox_template(
        &self,
        template: SandboxWorkloadTemplate,
    ) -> Result<SandboxWorkloadTemplate> {
        let response = self
            .client
            .unary(|mut grpc| {
                let request = proto::CreateSandboxTemplateRequest {
                    request_id: String::new(),
                    template: Some(template.clone()),
                    workspace_scope: Some(proto::workspace_selector(&self.workspace)),
                };
                async move { grpc.create_sandbox_template(request).await }
            })
            .await?;
        sandbox_template_from_response(response.template)
    }

    /// Fetch a reusable sandbox template by name in this workspace.
    pub async fn get_sandbox_template(&self, name: &str) -> Result<SandboxWorkloadTemplate> {
        let response = self
            .client
            .unary(|mut grpc| {
                let request = proto::GetSandboxTemplateRequest {
                    name: name.to_string(),
                    workspace_scope: Some(proto::workspace_selector(&self.workspace)),
                };
                async move { grpc.get_sandbox_template(request).await }
            })
            .await?;
        sandbox_template_from_response(response.template)
    }

    /// List reusable sandbox templates in this workspace.
    pub fn list_sandbox_templates(
        &self,
        opts: SandboxTemplateListOptions,
    ) -> Pager<SandboxWorkloadTemplate> {
        let client = self.client.clone();
        let workspace = self.workspace.clone();
        let initial_page_token = opts.page_token.clone();
        Pager::new(initial_page_token, move |page_token| {
            let client = client.clone();
            let workspace = workspace.clone();
            let opts = opts.clone();
            async move {
                let response = client
                    .unary(|mut grpc| {
                        let page_token = page_token.clone();
                        let request = proto::ListSandboxTemplatesRequest {
                            page_size: opts.page_size,
                            page_token,
                            label_selector: opts.label_selector.clone(),
                            workspace_scope: Some(proto::workspace_selector(&workspace)),
                        };
                        async move { grpc.list_sandbox_templates(request).await }
                    })
                    .await?;
                Ok(Page {
                    items: response.templates,
                    next_page_token: response.next_page_token,
                })
            }
        })
    }

    /// List and collect every reusable sandbox template in this scope.
    pub async fn list_all_sandbox_templates(
        &self,
        opts: SandboxTemplateListOptions,
    ) -> Result<Vec<SandboxWorkloadTemplate>> {
        self.list_sandbox_templates(opts).collect_all().await
    }

    /// Delete a reusable sandbox template by name in this workspace.
    pub async fn delete_sandbox_template(
        &self,
        name: &str,
        opts: DeleteOptions,
    ) -> Result<DeletionResult> {
        let response = self
            .client
            .unary(|mut grpc| {
                let request = proto::DeleteSandboxTemplateRequest {
                    request_id: String::new(),
                    allow_missing: opts.allow_missing,
                    name: name.to_string(),
                    workspace_scope: Some(proto::workspace_selector(&self.workspace)),
                };
                async move { grpc.delete_sandbox_template(request).await }
            })
            .await?;
        Ok(DeletionResult {
            outcome: response.outcome.into(),
            sandbox_id: None,
        })
    }

    /// Fetch a sandbox by name in this workspace.
    pub async fn get_sandbox(&self, name: &str) -> Result<SandboxRef> {
        let response = self
            .client
            .unary(|mut grpc| {
                let request = proto::GetSandboxRequest {
                    name: name.to_string(),
                    workspace_scope: Some(proto::workspace_selector(&self.workspace)),
                };
                async move { grpc.get_sandbox(request).await }
            })
            .await?;
        sandbox_from_response(response.sandbox)
    }

    /// List sandboxes in this workspace.
    pub fn list_sandboxes(&self, opts: ListOptions) -> Pager<SandboxRef> {
        let client = self.client.clone();
        let workspace = self.workspace.clone();
        let initial_page_token = opts.page_token.clone();
        Pager::new(initial_page_token, move |page_token| {
            let client = client.clone();
            let workspace = workspace.clone();
            let opts = opts.clone();
            async move {
                let response = client
                    .unary(|mut grpc| {
                        let page_token = page_token.clone();
                        let request = proto::ListSandboxesRequest {
                            page_size: opts.page_size,
                            page_token,
                            label_selector: opts.label_selector.clone().unwrap_or_default(),
                            workspace_scope: Some(proto::workspace_selector(&workspace)),
                        };
                        async move { grpc.list_sandboxes(request).await }
                    })
                    .await?;
                Ok(Page {
                    items: response
                        .sandboxes
                        .into_iter()
                        .map(SandboxRef::from_proto)
                        .collect(),
                    next_page_token: response.next_page_token,
                })
            }
        })
    }

    /// List and collect every sandbox in this workspace.
    pub async fn list_all_sandboxes(&self, opts: ListOptions) -> Result<Vec<SandboxRef>> {
        self.list_sandboxes(opts).collect_all().await
    }

    /// Delete a sandbox by name in this workspace.
    pub async fn delete_sandbox(&self, name: &str, opts: DeleteOptions) -> Result<DeletionResult> {
        let response = self
            .client
            .unary(|mut grpc| {
                let request = proto::DeleteSandboxRequest {
                    request_id: String::new(),
                    allow_missing: opts.allow_missing,
                    name: name.to_string(),
                    workspace_scope: Some(proto::workspace_selector(&self.workspace)),
                };
                async move { grpc.delete_sandbox(request).await }
            })
            .await?;
        Ok(DeletionResult {
            outcome: response.outcome.into(),
            sandbox_id: (!response.sandbox_id.is_empty()).then_some(response.sandbox_id),
        })
    }

    /// Stop a sandbox by name in this workspace.
    pub async fn stop_sandbox(&self, name: &str) -> Result<SandboxRef> {
        let response = self
            .client
            .unary(|mut grpc| {
                let request = proto::StopSandboxRequest {
                    request_id: String::new(),
                    name: name.to_string(),
                    workspace_scope: Some(proto::workspace_selector(&self.workspace)),
                };
                async move { grpc.stop_sandbox(request).await }
            })
            .await?;
        sandbox_from_response(response.sandbox)
    }

    /// Start a stopped sandbox by name in this workspace.
    pub async fn start_sandbox(&self, name: &str) -> Result<SandboxRef> {
        let response = self
            .client
            .unary(|mut grpc| {
                let request = proto::StartSandboxRequest {
                    request_id: String::new(),
                    name: name.to_string(),
                    workspace_scope: Some(proto::workspace_selector(&self.workspace)),
                };
                async move { grpc.start_sandbox(request).await }
            })
            .await?;
        sandbox_from_response(response.sandbox)
    }

    /// Poll until the sandbox reaches [`SandboxPhase::Ready`] or successful
    /// [`SandboxPhase::Completed`], or the timeout elapses.
    pub async fn wait_ready(&self, name: &str, timeout: Duration) -> Result<SandboxRef> {
        let deadline = Instant::now() + timeout;
        let mut delay = Duration::from_millis(250);
        loop {
            let snapshot = self.get_sandbox(name).await?;
            match snapshot.phase {
                SandboxPhase::Ready | SandboxPhase::Completed => return Ok(snapshot),
                SandboxPhase::Stopped => {
                    let detail = snapshot.exit_code.map_or_else(
                        || "stopped before becoming ready".to_string(),
                        |code| format!("main process failed with status {code}"),
                    );
                    return Err(SdkError::connect(format!("sandbox '{name}' {detail}")));
                }
                SandboxPhase::Error => {
                    return Err(SdkError::connect(format!(
                        "sandbox '{name}' entered error phase"
                    )));
                }
                _ => {}
            }
            if Instant::now() >= deadline {
                return Err(SdkError::connect(format!(
                    "timed out waiting for sandbox '{name}'"
                )));
            }
            tokio::time::sleep(delay).await;
            delay = (delay * 2).min(Duration::from_secs(2));
        }
    }

    /// Poll until the sandbox is gone (`NotFound`) or the timeout elapses.
    ///
    /// Pass the deletion result's `sandbox_id` as `expected_sandbox_id` to also
    /// complete when the name resolves to a different sandbox. With `None`,
    /// waits for the name to be absent, including any same-name replacement.
    pub async fn wait_deleted(
        &self,
        name: &str,
        timeout: Duration,
        expected_sandbox_id: Option<&str>,
    ) -> Result<()> {
        let deadline = Instant::now() + timeout;
        let mut delay = Duration::from_millis(250);
        loop {
            match self.get_sandbox(name).await {
                Err(SdkError::NotFound { .. }) => return Ok(()),
                Err(other) => return Err(other),
                Ok(snapshot) if expected_sandbox_id.is_some_and(|id| snapshot.id != id) => {
                    return Ok(());
                }
                Ok(_) => {}
            }
            if Instant::now() >= deadline {
                return Err(SdkError::connect(format!(
                    "timed out waiting for sandbox '{name}' to delete"
                )));
            }
            tokio::time::sleep(delay).await;
            delay = (delay * 2).min(Duration::from_secs(2));
        }
    }

    /// Run a command inside a sandbox and buffer stdout/stderr.
    pub async fn exec(&self, name: &str, cmd: &[String], opts: ExecOptions) -> Result<ExecResult> {
        let request = proto::ExecSandboxRequest {
            request_id: String::new(),
            sandbox: name.to_string(),
            workspace_scope: Some(proto::workspace_selector(&self.workspace)),
            command: cmd.to_vec(),
            workdir: opts.workdir.unwrap_or_default(),
            environment: opts.environment,
            execution_timeout: opts
                .timeout
                .map(openshell_core::time::duration_from_std)
                .transpose()
                .map_err(|error| SdkError::invalid_config(error.to_string()))?,
            stdin: opts.stdin.unwrap_or_default(),
            tty: false,
            cols: 0,
            rows: 0,
            no_login_shell: opts.no_login_shell,
        };

        let mut stream = self
            .client
            .unary(|mut grpc| {
                let request = request.clone();
                async move { grpc.exec_sandbox(request).await }
            })
            .await?;

        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        let mut exit_code: Option<i32> = None;

        while let Some(event) = stream.next().await {
            let event = event.map_err(map_status)?;
            match event.payload {
                Some(proto::exec_sandbox_event::Payload::Stdout(chunk)) => {
                    stdout.extend_from_slice(&chunk.data);
                }
                Some(proto::exec_sandbox_event::Payload::Stderr(chunk)) => {
                    stderr.extend_from_slice(&chunk.data);
                }
                Some(proto::exec_sandbox_event::Payload::Exit(exit)) => {
                    exit_code = Some(exit.exit_code);
                }
                None => {}
            }
        }

        Ok(ExecResult {
            exit_code: exit_code.unwrap_or(-1),
            stdout,
            stderr,
        })
    }

    /// Watch a sandbox's logs and platform events with loss-aware resume.
    ///
    /// Reconnects transparently on transient stream errors, resuming from the
    /// highest cursor already delivered. A recoverable server lag surfaces as
    /// [`WatchEvent::Warning`] and the stream continues.
    ///
    /// [`SdkError::OutOfRange`] is terminal and deliberately not retried: it
    /// means the resume point is gone (trimmed from the buffer, or issued by a
    /// cursor space the gateway no longer has), so events between it and now
    /// are unrecoverable. Auto-restarting from scratch would hide that loss,
    /// which is exactly what this API exists to surface. Callers who accept the
    /// gap can start a new watch with an empty
    /// [`WatchOptions::resume_after_cursor`]; retrying the same cursor fails
    /// identically.
    pub fn watch_logs(
        &self,
        name: &str,
        opts: WatchOptions,
    ) -> impl Stream<Item = Result<WatchEvent>> + '_ {
        let name = name.to_string();
        async_stream::try_stream!(
            let sandbox = self.get_sandbox(&name).await?;
            for await event in self.client.watch_logs_by_name(sandbox.name, self.workspace.clone(), opts) {
                yield event?;
            }
        )
    }
}

fn interceptor_from_config(config: &ClientConfig) -> Result<EdgeAuthInterceptor> {
    match &config.auth {
        None => Ok(EdgeAuthInterceptor::noop()),
        Some(AuthConfig::Oidc { token, .. }) => EdgeAuthInterceptor::new(Some(token), None),
        Some(AuthConfig::EdgeJwt(token)) => EdgeAuthInterceptor::new(None, Some(token)),
    }
}

/// Build a [`TokenSource`] when the config carries an OIDC refresher. Returns
/// `None` for static OIDC tokens, edge tokens, and anonymous auth.
fn token_source_from_config(config: &ClientConfig) -> Option<TokenSource> {
    let Some(AuthConfig::Oidc {
        token,
        expires_at,
        refresh: Some(refresher),
    }) = &config.auth
    else {
        return None;
    };
    let mut initial = RefreshedToken::new(token.clone());
    // Prefer the caller-advertised expiry; otherwise derive a deadline from
    // the token's JWT `exp` claim (reusing openshell-core's decoder) so the
    // proactive refresh path has an expiry to schedule against. Non-JWT
    // bearers fall back to reactive-only refresh.
    let deadline = expires_at
        .or_else(|| openshell_core::jwt::parse_exp_secs(token).and_then(|s| u64::try_from(s).ok()));
    if let Some(exp) = deadline {
        initial = initial.with_expires_at(exp);
    }
    Some(TokenSource::new(initial, Arc::clone(refresher)))
}

/// Overwrite the live bearer slot with a freshly minted token.
///
/// Returns an error if the refreshed token can't be encoded as gRPC metadata
/// instead of silently keeping the previous value. The [`TokenSource`] has
/// already committed the new token to its state by this point, so a silent
/// drop would leave the interceptor sending the old token with no path back
/// to a refresh; surfacing the error fails the call loudly instead.
fn store_bearer(slot: &BearerSlot, token: &str) -> Result<()> {
    let value = bearer_metadata(token)?;
    let mut guard = slot
        .write()
        .map_err(|_| SdkError::auth("bearer slot lock poisoned"))?;
    *guard = Some(value);
    Ok(())
}

fn create_sandbox_request(spec: SandboxSpec) -> proto::CreateSandboxRequest {
    let SandboxSpec {
        name,
        image,
        labels,
        environment,
        providers,
        gpu,
        command,
        tty,
        service_exposures,
    } = spec;
    let template = image.map(|image| proto::SandboxTemplate {
        image,
        ..proto::SandboxTemplate::default()
    });
    let resource_requirements = gpu.then_some(proto::ResourceRequirements {
        gpu: Some(proto::GpuResourceRequirements { count: None }),
    });
    proto::CreateSandboxRequest {
        request_id: String::new(),
        spec: Some(proto::SandboxSpec {
            environment,
            template,
            providers,
            resource_requirements,
            command,
            tty,
            ..proto::SandboxSpec::default()
        }),
        name: name.unwrap_or_default(),
        labels,
        annotations: HashMap::new(),
        workspace_scope: Some(proto::workspace_selector("default")),
        await_main_process_attachment: false,
        workload_template: String::new(),
        service_exposures: service_exposures
            .into_iter()
            .map(|exposure| proto::SandboxServiceExposure {
                service: exposure.service,
                target_port: u32::from(exposure.target_port),
            })
            .collect(),
    }
}

fn create_sandbox_from_template_request(
    spec: SandboxTemplateCreateSpec,
) -> proto::CreateSandboxRequest {
    let SandboxTemplateCreateSpec {
        name,
        template_name,
        labels,
        providers,
        command,
        tty,
        policy,
        service_exposures,
    } = spec;
    proto::CreateSandboxRequest {
        request_id: String::new(),
        spec: Some(proto::SandboxSpec {
            providers,
            command,
            tty,
            policy,
            ..proto::SandboxSpec::default()
        }),
        name: name.unwrap_or_default(),
        labels,
        annotations: HashMap::new(),
        workspace_scope: Some(proto::workspace_selector("default")),
        workload_template: template_name,
        await_main_process_attachment: false,
        service_exposures: service_exposures
            .into_iter()
            .map(|exposure| proto::SandboxServiceExposure {
                service: exposure.service,
                target_port: u32::from(exposure.target_port),
            })
            .collect(),
    }
}

fn sandbox_from_response(sandbox: Option<proto::Sandbox>) -> Result<SandboxRef> {
    sandbox
        .map(SandboxRef::from_proto)
        .ok_or_else(|| SdkError::invalid_config("sandbox missing from gateway response"))
}

fn sandbox_from_create_response(response: proto::SandboxResponse) -> Result<SandboxRef> {
    let mut sandbox = sandbox_from_response(response.sandbox)?;
    sandbox.service_urls = response.service_urls;
    Ok(sandbox)
}

fn sandbox_template_from_response(
    template: Option<proto::SandboxWorkloadTemplate>,
) -> Result<SandboxWorkloadTemplate> {
    template
        .ok_or_else(|| SdkError::invalid_config("sandbox template missing from gateway response"))
}

fn map_status(status: tonic::Status) -> SdkError {
    SdkError::from_status(status)
}

/// Convert a wire watch event into the curated [`WatchEvent`], advancing
/// `cursor` for resumable payloads.
///
/// Log and platform events carry the shared per-sandbox cursor and update it.
/// Warnings are recoverable loss notices with no cursor, so they never advance
/// it. Status snapshots and draft-policy updates are not part of the log/event
/// stream and are dropped (`None`).
///
/// `cursor` is a high-water mark, not the last cursor seen. The gateway reads
/// the log and platform sources independently during live delivery, so arrival
/// order can differ from cursor order. Taking the max keeps the resume point
/// monotonic; assigning directly would let a later lower-cursor event rewind it
/// and replay already-delivered events after a reconnect.
///
/// The comparison is a plain byte-wise string compare on an opaque token. That
/// is the one operation the gateway permits on a cursor, and it is well defined
/// here because both cursors come from the same stream: the encoding is fixed
/// width within a cursor space, and a stream never spans two spaces (a reset
/// ends it). Never parse the token — its layout is not part of the contract.
fn convert_event(event: proto::SandboxStreamEvent, cursor: &mut String) -> Option<WatchEvent> {
    match event.payload? {
        proto::sandbox_stream_event::Payload::Log(line) => {
            if event.cursor > *cursor {
                cursor.clone_from(&event.cursor);
            }
            Some(WatchEvent::Log {
                line: line.into(),
                cursor: event.cursor,
            })
        }
        proto::sandbox_stream_event::Payload::Event(platform) => {
            if event.cursor > *cursor {
                cursor.clone_from(&event.cursor);
            }
            Some(WatchEvent::Event {
                event: platform.into(),
                cursor: event.cursor,
            })
        }
        proto::sandbox_stream_event::Payload::Warning(warning) => Some(WatchEvent::Warning {
            message: warning.message,
        }),
        proto::sandbox_stream_event::Payload::Sandbox(_)
        | proto::sandbox_stream_event::Payload::DraftPolicyUpdate(_) => None,
    }
}

/// Whether a mid-stream error is a transient condition worth reconnecting on.
///
/// Only `Unavailable` (connection drop, gateway restart) is retryable; every
/// other status is terminal so the caller surfaces it instead of looping.
fn is_retryable_stream(err: &SdkError) -> bool {
    matches!(err, SdkError::Rpc { code, .. } if *code == tonic::Code::Unavailable as i32)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::refresh::{Refresh, RefreshError};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, RwLock};
    use std::time::{SystemTime, UNIX_EPOCH};
    use tonic::transport::Channel;

    struct StubRefresher {
        calls: Arc<AtomicUsize>,
    }

    #[async_trait::async_trait]
    impl Refresh for StubRefresher {
        async fn refresh(&self) -> std::result::Result<RefreshedToken, RefreshError> {
            let n = self.calls.fetch_add(1, Ordering::SeqCst) + 1;
            Ok(RefreshedToken::new(format!("token-{n}")).with_expires_at(
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_secs()
                    + 3600,
            ))
        }
    }

    struct FailingRefresher;

    #[async_trait::async_trait]
    impl Refresh for FailingRefresher {
        async fn refresh(&self) -> std::result::Result<RefreshedToken, RefreshError> {
            Err(RefreshError::Transient("idp blip".into()))
        }
    }

    /// Build an OIDC client wired to a refresher, with a near-expiry initial
    /// token, over a lazy channel that never actually connects (no RPC is
    /// issued in these tests).
    fn oidc_client_with_refresher(calls: Arc<AtomicUsize>) -> OpenShellClient {
        oidc_client_with(Arc::new(StubRefresher { calls }))
    }

    fn oidc_client_with(refresher: Arc<dyn Refresh>) -> OpenShellClient {
        let interceptor = EdgeAuthInterceptor::new(Some("initial"), None).unwrap();
        let bearer_slot = interceptor.bearer_slot();
        let near = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs()
            + 5;
        let source = TokenSource::new(
            RefreshedToken::new("initial").with_expires_at(near),
            refresher,
        );
        let channel = Channel::from_static("http://127.0.0.1:1").connect_lazy();
        OpenShellClient {
            channel,
            interceptor,
            token_source: Some(source),
            bearer_slot,
        }
    }

    fn slot_token(slot: &BearerSlot) -> String {
        slot.read()
            .unwrap()
            .clone()
            .unwrap()
            .to_str()
            .unwrap()
            .to_string()
    }

    #[tokio::test]
    async fn raw_grpc_does_not_refresh() {
        // Regression (P1): the plain raw accessor must not be relied on for
        // rotation — it hands back a client bound to the current token.
        let calls = Arc::new(AtomicUsize::new(0));
        let client = oidc_client_with_refresher(Arc::clone(&calls));
        let _raw = client.raw_grpc();
        assert_eq!(calls.load(Ordering::SeqCst), 0, "raw_grpc must not refresh");
        assert_eq!(
            slot_token(client.bearer_slot.as_ref().unwrap()),
            "Bearer initial"
        );
    }

    #[tokio::test]
    async fn raw_grpc_fresh_refreshes_near_expiry() {
        // Regression (P1): the _fresh accessor proactively rotates a
        // near-expiry token into the shared slot before returning a client.
        let calls = Arc::new(AtomicUsize::new(0));
        let client = oidc_client_with_refresher(Arc::clone(&calls));
        let _raw = client.raw_grpc_fresh().await.unwrap();
        assert_eq!(
            calls.load(Ordering::SeqCst),
            1,
            "raw_grpc_fresh must refresh a near-expiry token"
        );
        assert_eq!(
            slot_token(client.bearer_slot.as_ref().unwrap()),
            "Bearer token-1",
            "refreshed token must reach the live slot"
        );
    }

    #[tokio::test]
    async fn ensure_fresh_tolerates_proactive_refresh_failure() {
        // A transient proactive-refresh failure must not fail the request: the
        // near-expiry token in the slot may still be valid, so `ensure_fresh`
        // falls through and leaves the existing token in place for the
        // reactive `Unauthenticated` path to handle if the server rejects it.
        let client = oidc_client_with(Arc::new(FailingRefresher));
        client
            .ensure_fresh()
            .await
            .expect("proactive refresh failure must be non-fatal");
        assert_eq!(
            slot_token(client.bearer_slot.as_ref().unwrap()),
            "Bearer initial",
            "existing token must remain in the slot"
        );
    }

    #[tokio::test]
    async fn force_refresh_rotates_and_reports_wired() {
        // Regression (P1): reactive recovery path for raw callers.
        let calls = Arc::new(AtomicUsize::new(0));
        let client = oidc_client_with_refresher(Arc::clone(&calls));
        let refreshed = client.force_refresh().await.unwrap();
        assert!(refreshed, "force_refresh reports a wired refresher");
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(
            slot_token(client.bearer_slot.as_ref().unwrap()),
            "Bearer token-1"
        );
    }

    #[test]
    fn store_bearer_rejects_malformed_token_and_keeps_previous() {
        let slot: BearerSlot = Arc::new(RwLock::new(None));
        store_bearer(&slot, "good-token").expect("a valid token should store");

        // A token with a control character can't be gRPC metadata; the slot
        // must keep its previous value and the error must surface.
        assert!(store_bearer(&slot, "bad\nvalue").is_err());
        let current = slot.read().unwrap().clone().unwrap();
        assert_eq!(current.to_str().unwrap(), "Bearer good-token");
    }

    #[test]
    fn create_request_preserves_canonical_main_process() {
        let request = create_sandbox_request(SandboxSpec {
            command: vec!["/opt/agent binary".into(), "--serve exactly".into()],
            tty: false,
            ..SandboxSpec::default()
        });

        let spec = request.spec.expect("sandbox spec should be present");
        assert_eq!(spec.command, ["/opt/agent binary", "--serve exactly"]);
        assert!(!spec.tty);
    }
}
