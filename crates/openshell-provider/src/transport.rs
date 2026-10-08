// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::*;
use async_trait::async_trait;
use nemoclaw_backend::Error;
use nemoclaw_openshell::GatewayCapabilities;
use openshell_sdk::OpenShellClient;
use std::{sync::Arc, time::Duration};
use tonic::Request;

/// Largest sandbox command output the client accepts.
pub const RESPONSE_LIMIT: usize = 4 * 1024 * 1024;

#[derive(Clone)]
pub struct OpenShell {
    pub(super) gateway: Arc<dyn OpenShellGateway>,
}

#[derive(Clone)]
pub(super) struct ConnectedOpenShellGateway {
    pub(super) client: Arc<OpenShellClient>,
    pub(super) secrets: Arc<dyn Secrets>,
}

/// Whether a sandbox has finished starting.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SandboxPhase {
    Pending,
    Ready,
}

#[async_trait]
/// Domain operations required by reconciliation.
///
/// The connected implementation keeps SDK and raw gRPC selection, wire types,
/// deadlines, and transport errors behind this boundary.
pub(super) trait OpenShellGateway: Send + Sync {
    async fn observe(
        &self,
        kind: &str,
        workspace: &str,
        name: &str,
        removing: bool,
    ) -> Result<Option<Row>, ObservationError>;
    async fn create(&self, kind: &str, want: &Row) -> Result<String, ObservationError>;
    async fn update_provider(&self, want: &Row, live: &Row) -> Result<(), ObservationError>;
    async fn delete_bound_sandbox(&self, want: &Row) -> Result<(), ObservationError>;
    async fn delete(&self, kind: &str, workspace: &str, name: &str)
    -> Result<(), ObservationError>;
    async fn gateway_capabilities(&self) -> Result<GatewayCapabilities, ObservationError>;
    async fn sandbox_phase(
        &self,
        binding: &Row,
        check_configuration: bool,
    ) -> Result<SandboxPhase, Error>;
    async fn exec(
        &self,
        binding: &Row,
        command: Vec<String>,
        environment: Row,
        seconds: u32,
        stdin: Vec<u8>,
    ) -> Result<(i32, Vec<u8>), Error>;
}

impl OpenShell {
    /// Configure a lazy channel without network mutation or automatic RPC retry.
    /// Secret references are resolved locally; raw credentials never enter rows.
    pub fn connect(
        connection: &nemoclaw_openshell::Connection,
        secrets: Arc<dyn Secrets>,
    ) -> Result<Self, ObservationError> {
        Ok(Self {
            gateway: Arc::new(ConnectedOpenShellGateway::connect(connection, secrets)?),
        })
    }

    #[cfg(test)]
    pub(super) fn with_gateway(gateway: Arc<dyn OpenShellGateway>) -> Self {
        Self { gateway }
    }

    pub async fn observe(
        &self,
        kind: &str,
        workspace: &str,
        name: &str,
        removing: bool,
    ) -> Result<Option<Row>, ObservationError> {
        if name.is_empty()
            || ((kind == "workspace") != workspace.is_empty())
            || name.contains('\0')
            || workspace.contains('\0')
        {
            return Err(ObservationError::Query);
        }
        self.gateway.observe(kind, workspace, name, removing).await
    }
}

impl OpenShell {
    pub async fn exec_bound(
        &self,
        binding: &Row,
        command: Vec<String>,
        environment: Row,
        seconds: u32,
    ) -> Result<(i32, Vec<u8>), Error> {
        self.exec_input(binding, command, environment, seconds, Vec::new())
            .await
    }
    /// Run one command in the bound sandbox with `stdin`, returning its exit
    /// code and bounded output.
    pub async fn exec_input(
        &self,
        binding: &Row,
        command: Vec<String>,
        environment: Row,
        seconds: u32,
        stdin: Vec<u8>,
    ) -> Result<(i32, Vec<u8>), Error> {
        tokio::time::timeout(
            Duration::from_secs(u64::from(seconds)),
            self.gateway
                .exec(binding, command, environment, seconds, stdin),
        )
        .await
        .map_err(|_| Error::Conflict("sandbox exec timed out; invocation may have had effects"))?
    }
    /// The bound sandbox's phase; `ready` requires its runtime to report readiness.
    pub async fn sandbox_phase(&self, binding: &Row, ready: bool) -> Result<SandboxPhase, Error> {
        self.gateway.sandbox_phase(binding, ready).await
    }
}

impl ConnectedOpenShellGateway {
    pub(crate) fn connect(
        connection: &nemoclaw_openshell::Connection,
        secrets: Arc<dyn Secrets>,
    ) -> Result<Self, ObservationError> {
        Ok(Self {
            client: Arc::new(nemoclaw_openshell::client(connection, secrets.as_ref())?),
            secrets,
        })
    }
    pub(super) fn request<T>(&self, value: T) -> Request<T> {
        nemoclaw_openshell::request(value)
    }
    async fn workspace(&self, name: &str, removing: bool) -> Result<Option<Row>, ObservationError> {
        let response = authoritative(
            self.client
                .raw_grpc()
                .get_workspace(self.request(proto::GetWorkspaceRequest { name: name.into() }))
                .await,
        )?;
        response
            .map(|response| workspace_row(response, name, removing))
            .transpose()
    }
    async fn observe(
        &self,
        kind: &str,
        workspace: &str,
        name: &str,
        removing: bool,
    ) -> Result<Option<Row>, ObservationError> {
        let row = match kind {
            "workspace" => return self.workspace(name, removing).await,
            "provider_profile" => self.observe_profile(workspace, name).await?,
            "provider" => {
                let response = authoritative(
                    self.client
                        .raw_grpc()
                        .get_provider(self.request(proto::GetProviderRequest {
                            name: name.into(),
                            workspace_scope: Some(proto::workspace_selector(workspace)),
                        }))
                        .await,
                )?;
                response
                    .map(|response| provider_row(response, name, removing))
                    .transpose()?
            }
            "sandbox" => {
                let Some(response) = authoritative(
                    self.client
                        .raw_grpc()
                        .get_sandbox(self.request(proto::GetSandboxRequest {
                            name: name.into(),
                            workspace_scope: Some(proto::workspace_selector(workspace)),
                        }))
                        .await,
                )?
                else {
                    return Ok(None);
                };
                let (row, ready) = sandbox_row(response, name, removing)?;
                if ready {
                    let status = self
                        .client
                        .raw_grpc()
                        .get_sandbox_policy_status(self.request(
                            proto::GetSandboxPolicyStatusRequest {
                                sandbox: name.into(),
                                workspace_scope: Some(proto::workspace_selector(workspace)),
                                ..Default::default()
                            },
                        ))
                        .await
                        .map_err(|error| remote_error(&error))?
                        .into_inner();
                    active_policy(status, &policy_json(&row_policy(&row)?)?)?;
                }
                Some(row)
            }
            _ => return Err(ObservationError::Query),
        };
        Ok(row.map(|mut row| {
            row.insert("workspace".into(), workspace.into());
            row
        }))
    }
}

#[async_trait]
impl OpenShellGateway for ConnectedOpenShellGateway {
    async fn observe(
        &self,
        kind: &str,
        workspace: &str,
        name: &str,
        removing: bool,
    ) -> Result<Option<Row>, ObservationError> {
        ConnectedOpenShellGateway::observe(self, kind, workspace, name, removing).await
    }

    async fn create(&self, kind: &str, want: &Row) -> Result<String, ObservationError> {
        match kind {
            "workspace" => self.create_workspace(want).await,
            "provider" => self.create_provider(want).await,
            "provider_profile" => self.create_profile(want).await,
            "sandbox" => self.create_sandbox(want).await,
            _ => Err(ObservationError::Query),
        }
    }

    async fn update_provider(&self, want: &Row, live: &Row) -> Result<(), ObservationError> {
        ConnectedOpenShellGateway::update_provider(self, want, live).await
    }

    async fn delete_bound_sandbox(&self, want: &Row) -> Result<(), ObservationError> {
        ConnectedOpenShellGateway::delete_bound_sandbox(self, want).await
    }

    async fn delete(
        &self,
        kind: &str,
        workspace: &str,
        name: &str,
    ) -> Result<(), ObservationError> {
        ConnectedOpenShellGateway::delete(self, kind, workspace, name).await
    }

    async fn gateway_capabilities(&self) -> Result<GatewayCapabilities, ObservationError> {
        ConnectedOpenShellGateway::gateway_capabilities(self).await
    }

    async fn sandbox_phase(
        &self,
        binding: &Row,
        check_configuration: bool,
    ) -> Result<SandboxPhase, Error> {
        ConnectedOpenShellGateway::sandbox_phase(self, binding, check_configuration).await
    }

    async fn exec(
        &self,
        binding: &Row,
        command: Vec<String>,
        environment: Row,
        seconds: u32,
        stdin: Vec<u8>,
    ) -> Result<(i32, Vec<u8>), Error> {
        ConnectedOpenShellGateway::exec(self, binding, command, environment, seconds, stdin).await
    }
}

fn row_value<'a>(row: &'a Row, key: &str) -> &'a str {
    row.get(key).map(String::as_str).unwrap_or("")
}

pub(super) fn decode_sandbox_phase(
    status: proto::SandboxStatus,
    check_configuration: bool,
) -> Result<SandboxPhase, Error> {
    if check_configuration
        && let Some(admission) = &status.configuration_admission
        && admission.state == proto::ConfigurationAdmissionState::Rejected as i32
    {
        // The pinned gateway replaces runtime parser text with public admission
        // diagnostics. Keep only its fixed vocabulary; never echo unknown text,
        // policy load_error, credentials, or supervisor instance identifiers.
        let reason = match admission.error.as_str() {
            "Effective configuration could not be activated; replace the policy or repair attached providers" => {
                "Effective configuration could not be activated; replace the policy or repair attached providers"
            }
            "Effective provider configuration is invalid; repair credential bindings, attached providers, or their policy layers" => {
                "Effective provider configuration is invalid; repair credential bindings, attached providers, or their policy layers"
            }
            "Effective middleware configuration is invalid; repair the policy middleware bindings or registered services" => {
                "Effective middleware configuration is invalid; repair the policy middleware bindings or registered services"
            }
            "Stored policy structure or safety validation failed; submit a complete valid replacement policy" => {
                "Stored policy structure or safety validation failed; submit a complete valid replacement policy"
            }
            _ => "inspect the sandbox configuration; repair its policy or attached providers",
        };
        return Err(ObservationError::SandboxConfigurationRejected { reason }.into());
    }
    if let Ok(
        phase @ (proto::SandboxPhase::Error
        | proto::SandboxPhase::Deleting
        | proto::SandboxPhase::Stopped
        | proto::SandboxPhase::Completed),
    ) = proto::SandboxPhase::try_from(status.phase)
    {
        return Err(Error::SandboxStartup {
            phase: phase.as_str_name(),
            // Conditions are backend-controlled. Only fixed known reasons may
            // cross the diagnostic boundary; messages can contain credentials.
            reason: status
                .conditions
                .iter()
                .find_map(|condition| {
                    if condition.r#type != "Ready" || condition.status != "False" {
                        return None;
                    }
                    match condition.reason.as_str() {
                        "ControlSupervisorExited" => Some("ControlSupervisorExited"),
                        "ContainerExited" => Some("ContainerExited"),
                        "ControlSupervisorStartFailed" => Some("ControlSupervisorStartFailed"),
                        "IdentityResolutionFailed" => Some("IdentityResolutionFailed"),
                        _ => None,
                    }
                })
                .unwrap_or("unknown"),
            exit_code: status
                .exit_code
                .map_or_else(|| "unknown".into(), |code| code.to_string()),
        });
    }
    Ok(if status.phase == proto::SandboxPhase::Ready as i32 {
        SandboxPhase::Ready
    } else {
        SandboxPhase::Pending
    })
}

impl ConnectedOpenShellGateway {
    async fn bound_sandbox(&self, binding: &Row) -> Result<proto::Sandbox, Error> {
        let sandbox = self
            .client
            .raw_grpc()
            .get_sandbox(self.request(proto::GetSandboxRequest {
                name: row_value(binding, "name").into(),
                workspace_scope: Some(proto::workspace_selector(row_value(binding, "workspace"))),
            }))
            .await
            .map_err(|error| remote_error(&error))?
            .into_inner()
            .sandbox
            .ok_or(ObservationError::Incomplete)?;
        verify_identity(
            binding,
            &base(sandbox.metadata.clone(), row_value(binding, "name"), false)?,
        )?;
        let (observed, _) = sandbox_row(
            proto::SandboxResponse {
                sandbox: Some(sandbox.clone()),
                ..Default::default()
            },
            row_value(binding, "name"),
            false,
        )?;
        for field in ["runtime_json", "agent_name", "agent_runtime"] {
            if binding.get(field) != observed.get(field) {
                return Err(ObservationError::BindingMismatch.into());
            }
        }
        Ok(sandbox)
    }

    async fn sandbox_phase(
        &self,
        binding: &Row,
        check_configuration: bool,
    ) -> Result<SandboxPhase, Error> {
        decode_sandbox_phase(
            self.bound_sandbox(binding)
                .await?
                .status
                .ok_or(ObservationError::Incomplete)?,
            check_configuration,
        )
    }

    async fn exec(
        &self,
        binding: &Row,
        command: Vec<String>,
        environment: Row,
        seconds: u32,
        stdin: Vec<u8>,
    ) -> Result<(i32, Vec<u8>), Error> {
        // Exec is name-addressed upstream; verify the retained identity immediately
        // before sending and never retry an ambiguous invocation.
        let sandbox = self.bound_sandbox(binding).await?;
        let mut request = self.request(proto::ExecSandboxRequest {
            sandbox: sandbox.metadata.ok_or(ObservationError::Incomplete)?.name,
            workspace_scope: Some(proto::workspace_selector(row_value(binding, "workspace"))),
            command,
            stdin,
            no_login_shell: true,
            environment: environment.into_iter().collect(),
            execution_timeout: Some(
                openshell_core::time::duration_from_std(Duration::from_secs(u64::from(seconds)))
                    .expect("u32 seconds fit protobuf duration"),
            ),
            ..Default::default()
        });
        request.set_timeout(Duration::from_secs(u64::from(seconds)));
        let mut stream = self
            .client
            .raw_grpc()
            .exec_sandbox(request)
            .await
            .map_err(|error| remote_error(&error))?
            .into_inner();
        let mut output = Vec::new();
        let mut exit = None;
        while let Some(event) = stream
            .message()
            .await
            .map_err(|error| remote_error(&error))?
        {
            if exit.is_some() {
                return Err(ObservationError::Incomplete.into());
            }
            match event.payload.ok_or(ObservationError::Incomplete)? {
                proto::exec_sandbox_event::Payload::Stdout(chunk) => {
                    if output.len() + chunk.data.len() > RESPONSE_LIMIT {
                        return Err(Error::Conflict("sandbox exec output exceeds limit"));
                    }
                    output.extend(chunk.data);
                }
                proto::exec_sandbox_event::Payload::Stderr(_) => {}
                proto::exec_sandbox_event::Payload::Exit(result) => exit = Some(result.exit_code),
            }
        }
        Ok((exit.ok_or(ObservationError::Incomplete)?, output))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use nemoclaw_backend::{Backend, Error};
    use nemoclaw_openshell::GatewayCapabilities;
    use std::sync::{
        Mutex,
        atomic::{AtomicUsize, Ordering},
    };

    struct FixtureGateway {
        observations: AtomicUsize,
        creations: AtomicUsize,
        observed: Mutex<Option<Row>>,
    }

    #[async_trait]
    impl OpenShellGateway for FixtureGateway {
        async fn observe(
            &self,
            _kind: &str,
            _workspace: &str,
            _name: &str,
            _removing: bool,
        ) -> Result<Option<Row>, ObservationError> {
            self.observations.fetch_add(1, Ordering::Relaxed);
            Ok(self.observed.lock().unwrap().clone())
        }

        async fn create(&self, _kind: &str, want: &Row) -> Result<String, ObservationError> {
            self.creations.fetch_add(1, Ordering::Relaxed);
            let mut row = want.clone();
            row.insert("id".into(), "physical".into());
            *self.observed.lock().unwrap() = Some(row);
            Ok("physical".into())
        }

        async fn update_provider(&self, _want: &Row, _live: &Row) -> Result<(), ObservationError> {
            unreachable!()
        }

        async fn delete_bound_sandbox(&self, _want: &Row) -> Result<(), ObservationError> {
            unreachable!()
        }

        async fn delete(
            &self,
            _kind: &str,
            _workspace: &str,
            _name: &str,
        ) -> Result<(), ObservationError> {
            unreachable!()
        }

        async fn gateway_capabilities(&self) -> Result<GatewayCapabilities, ObservationError> {
            unreachable!()
        }

        async fn sandbox_phase(
            &self,
            _binding: &Row,
            _check_configuration: bool,
        ) -> Result<SandboxPhase, Error> {
            unreachable!()
        }

        async fn exec(
            &self,
            _binding: &Row,
            _command: Vec<String>,
            _environment: Row,
            _seconds: u32,
            _stdin: Vec<u8>,
        ) -> Result<(i32, Vec<u8>), Error> {
            unreachable!()
        }
    }

    #[tokio::test]
    async fn reconciliation_observes_through_the_gateway_boundary() {
        let gateway = Arc::new(FixtureGateway {
            observations: AtomicUsize::new(0),
            creations: AtomicUsize::new(0),
            observed: Mutex::new(Some([("name".into(), "fixture".into())].into())),
        });
        let openshell = OpenShell::with_gateway(gateway.clone());

        let observed = openshell
            .observe("workspace", "", "fixture", false)
            .await
            .unwrap()
            .unwrap();

        assert_eq!(observed["name"], "fixture");
        assert_eq!(gateway.observations.load(Ordering::Relaxed), 1);
    }

    #[tokio::test]
    async fn reconciliation_mutates_through_the_gateway_boundary() {
        let gateway = Arc::new(FixtureGateway {
            observations: AtomicUsize::new(0),
            creations: AtomicUsize::new(0),
            observed: Mutex::new(None),
        });
        let openshell = OpenShell::with_gateway(gateway.clone());
        let desired: Row = [
            ("name", "fixture"),
            ("owner", "deployment"),
            ("generation", "generation"),
        ]
        .into_iter()
        .map(|(key, value)| (key.into(), value.into()))
        .collect();

        let mutation = openshell.ensure("workspace", &desired).await;

        assert_eq!(mutation.error(), None);
        assert_eq!(mutation.state().unwrap()["id"], "physical");
        assert_eq!(gateway.creations.load(Ordering::Relaxed), 1);
        assert_eq!(gateway.observations.load(Ordering::Relaxed), 2);
    }

    #[test]
    fn startup_failures_name_the_sandbox_and_explain_known_reasons_without_backend_text() {
        for (reason, guidance) in [
            (
                "IdentityResolutionFailed",
                "check policy.process.run_as_user and run_as_group",
            ),
            (
                "ControlSupervisorStartFailed",
                "check the sandbox policy and attached providers",
            ),
        ] {
            let failure = decode_sandbox_phase(
                proto::SandboxStatus {
                    phase: proto::SandboxPhase::Error as i32,
                    conditions: vec![proto::SandboxCondition {
                        r#type: "Ready".into(),
                        status: "False".into(),
                        reason: reason.into(),
                        message: "PRIVATE_SENTINEL".into(),
                        ..Default::default()
                    }],
                    ..Default::default()
                },
                false,
            )
            .unwrap_err();
            let direct = failure.to_string();
            let observation = failure.into_observation();
            assert_eq!(direct, observation.to_string());
            let message = nemoclaw_tofu::observation_message(observation, Some("coder"));
            for expected in ["sandbox/coder", reason, guidance, "resources retained"] {
                assert!(message.contains(expected), "{message}");
            }
            assert!(!message.contains("PRIVATE_SENTINEL"));
        }
    }

    #[test]
    fn terminal_sandbox_reports_known_failure_without_backend_text() {
        for (kind, status, reason, expected) in [
            (
                "Ready",
                "False",
                "ControlSupervisorExited",
                "ControlSupervisorExited",
            ),
            ("Ready", "False", "ContainerExited", "ContainerExited"),
            (
                "Ready",
                "False",
                "ControlSupervisorStartFailed",
                "ControlSupervisorStartFailed",
            ),
            (
                "Ready",
                "False",
                "IdentityResolutionFailed",
                "IdentityResolutionFailed",
            ),
            ("Ready", "False", "secret-sentinel", "unknown"),
            ("Ready", "True", "ControlSupervisorExited", "unknown"),
            ("Other", "False", "ControlSupervisorExited", "unknown"),
        ] {
            let error = decode_sandbox_phase(
                proto::SandboxStatus {
                    phase: proto::SandboxPhase::Error as i32,
                    conditions: vec![proto::SandboxCondition {
                        r#type: kind.into(),
                        status: status.into(),
                        reason: reason.into(),
                        message: "secret-sentinel".into(),
                        ..Default::default()
                    }],
                    ..Default::default()
                },
                false,
            )
            .unwrap_err()
            .into_observation()
            .to_string();
            assert!(error.contains(&format!("reason {expected}")), "{error}");
            assert!(error.contains("exit code unknown"));
            assert!(error.contains("resources retained"));
            assert!(!error.contains("secret-sentinel"));
        }
    }
}
