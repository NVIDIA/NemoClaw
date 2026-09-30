// SPDX-FileCopyrightText: Copyright (c) 2025-2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Receipt-bound provider status and bounded waits over the raw provider API.
//!
//! A wait pins the original desired identity. It cannot succeed by following a
//! later mutation, and its deadline covers RPC execution as well as polling.

use crate::raw::GrpcClient;
use openshell_core::proto::{
    GetSandboxProviderStatusRequest, ProviderMutationKind, ProviderMutationReceipt,
    ProviderReadinessReason, ProviderReadinessState, ProviderReadinessStatus, workspace_selector,
};
use std::future::Future;
use std::time::Duration;
use thiserror::Error;
use tokio::time::Instant;
use tonic::service::Interceptor;
use tonic::service::interceptor::InterceptedService;
use tonic::transport::Channel;

/// Maximum duration accepted by provider waits.
pub const MAX_PROVIDER_WAIT: Duration = Duration::from_hours(1);

/// Completion of a bounded wait, separate from the gateway's installed state.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProviderWaitOutcome {
    /// The original receipt's authority was installed or revoked as requested.
    Complete,
    /// The deadline elapsed; the last observed state remains authoritative.
    TimedOut,
    /// Installation failed, was withheld, or the desired authority was superseded.
    Terminal,
}

/// Last safe status and the reason a provider wait returned.
#[derive(Clone, Debug)]
pub struct ProviderWaitResult {
    /// Status for the original receipt, including on timeout.
    pub status: ProviderReadinessStatus,
    /// Whether installation completed, failed, or exhausted the deadline.
    pub outcome: ProviderWaitOutcome,
}

/// Errors safe to display without including raw secret-bearing RPC messages.
#[derive(Clone, Debug, Error)]
pub enum ProviderReadinessError {
    /// Provider waits require a positive timeout of at most one hour.
    #[error("provider wait timeout must be greater than zero and at most 3600 seconds")]
    InvalidTimeout,
    /// A receipt must identify a sandbox, workspace, provider, and desired state.
    #[error("provider readiness receipt is incomplete")]
    InvalidReceipt,
    /// The gateway returned no usable status or an unknown protocol state.
    #[error("gateway returned an invalid provider readiness status")]
    InvalidStatus,
    /// The RPC failed; only its protocol code is exposed.
    #[error("provider readiness request failed ({code})")]
    Rpc {
        /// gRPC status code without the server's diagnostic message or metadata.
        code: tonic::Code,
    },
}

/// Query a provider receipt or reconstruct current state when its ID is empty.
/// A receipt ID selects its provider when the request omits the provider name.
///
/// # Errors
/// Returns a safe protocol error if the gateway is unavailable or omits status.
pub async fn provider_status<I>(
    client: &mut GrpcClient<InterceptedService<Channel, I>>,
    request: GetSandboxProviderStatusRequest,
) -> Result<ProviderReadinessStatus, ProviderReadinessError>
where
    I: Interceptor + Clone + Send + Sync,
{
    let expected = request.clone();
    let status = client
        .get_sandbox_provider_status(request)
        .await
        .map_err(|error| ProviderReadinessError::Rpc { code: error.code() })?
        .into_inner()
        .status
        .ok_or(ProviderReadinessError::InvalidStatus)?;
    validate_status_for_request(&status, &expected)?;
    Ok(status)
}

fn validate_status_for_request(
    status: &ProviderReadinessStatus,
    expected: &GetSandboxProviderStatusRequest,
) -> Result<(), ProviderReadinessError> {
    validate_status(status)?;
    let receipt = status
        .receipt
        .as_ref()
        .ok_or(ProviderReadinessError::InvalidStatus)?;
    // Either a receipt ID or a provider name must select the authority. Every
    // supplied selector must still bind the response to that authority.
    if (expected.receipt_id.is_empty() && expected.provider.is_empty())
        || (!expected.receipt_id.is_empty() && receipt.receipt_id != expected.receipt_id)
        || (!expected.provider.is_empty() && receipt.provider != expected.provider)
        || request_workspace(expected).is_none_or(|workspace| workspace != receipt.workspace)
        || receipt
            .desired
            .as_ref()
            .is_none_or(|desired| desired.sandbox != expected.sandbox)
    {
        return Err(ProviderReadinessError::InvalidStatus);
    }
    Ok(())
}

/// Wait for the exact authority named by a provider receipt.
///
/// Detach requires `REVOKED`; attach and update require `READY`. A reconstructed
/// observation waits for ready or revoked according to its original provider ID.
/// This raw helper uses the authentication slot on the supplied client.
///
/// # Errors
/// Rejects an invalid timeout/receipt, malformed responses, or failed RPCs.
pub async fn wait_for_provider<I>(
    client: &mut GrpcClient<InterceptedService<Channel, I>>,
    receipt: &ProviderMutationReceipt,
    timeout: Duration,
) -> Result<ProviderWaitResult, ProviderReadinessError>
where
    I: Interceptor + Clone + Send + Sync,
{
    let deadline = provider_wait_deadline(timeout)?;
    wait_for_provider_until(client, receipt, deadline).await
}

/// Wait using a shared deadline, so a multi-sandbox update has one total bound.
///
/// # Errors
/// Returns safe protocol errors without retaining the underlying RPC message.
pub async fn wait_for_provider_until<I>(
    client: &mut GrpcClient<InterceptedService<Channel, I>>,
    receipt: &ProviderMutationReceipt,
    deadline: Instant,
) -> Result<ProviderWaitResult, ProviderReadinessError>
where
    I: Interceptor + Clone + Send + Sync,
{
    wait_with(receipt, deadline, Duration::from_millis(250), |request| {
        let mut client = client.clone();
        async move { provider_status(&mut client, request).await }
    })
    .await
}

/// Continue a bounded wait from a status that has already been observed.
///
/// Completed observations return immediately. A later failed or timed-out RPC
/// cannot discard the last observed pending state and replace it with saved intent.
///
/// # Errors
/// Rejects malformed receipts/statuses and reports only safe protocol errors.
pub async fn wait_for_provider_status_until<I>(
    client: &mut GrpcClient<InterceptedService<Channel, I>>,
    status: &ProviderReadinessStatus,
    deadline: Instant,
) -> Result<ProviderWaitResult, ProviderReadinessError>
where
    I: Interceptor + Clone + Send + Sync,
{
    let receipt = status
        .receipt
        .as_ref()
        .ok_or(ProviderReadinessError::InvalidStatus)?;
    wait_with_initial_status(
        receipt,
        status.clone(),
        deadline,
        Duration::from_millis(250),
        |request| {
            let mut client = client.clone();
            async move { provider_status(&mut client, request).await }
        },
    )
    .await
}

/// Validate a timeout and create a deadline shared across all selected sandboxes.
///
/// # Errors
/// A zero timeout or a timeout over one hour is rejected before mutation.
pub fn provider_wait_deadline(timeout: Duration) -> Result<Instant, ProviderReadinessError> {
    if timeout.is_zero() || timeout > MAX_PROVIDER_WAIT {
        return Err(ProviderReadinessError::InvalidTimeout);
    }
    Ok(Instant::now() + timeout)
}

/// Represent saved intent before any runtime observation has been fetched.
#[must_use]
pub fn persisted_status(receipt: ProviderMutationReceipt) -> ProviderReadinessStatus {
    ProviderReadinessStatus {
        receipt: Some(receipt),
        state: ProviderReadinessState::Persisted.into(),
        reason: ProviderReadinessReason::WaitingForSupervisor.into(),
        ..Default::default()
    }
}

fn validate_status(status: &ProviderReadinessStatus) -> Result<(), ProviderReadinessError> {
    if status.receipt.is_none()
        || matches!(
            ProviderReadinessState::try_from(status.state),
            Err(_) | Ok(ProviderReadinessState::Unspecified)
        )
        || ProviderReadinessReason::try_from(status.reason).is_err()
    {
        return Err(ProviderReadinessError::InvalidStatus);
    }
    // Absent observation times are expected before a report arrives. Present
    // times must be canonical so output cannot normalize malformed timestamps.
    for timestamp in [&status.observed_time, &status.evaluated_time]
        .into_iter()
        .flatten()
    {
        openshell_core::time::validate_timestamp(timestamp)
            .map_err(|_| ProviderReadinessError::InvalidStatus)?;
    }
    let receipt = status
        .receipt
        .as_ref()
        .ok_or(ProviderReadinessError::InvalidStatus)?;
    validate_provider_receipt(receipt).map_err(|_| ProviderReadinessError::InvalidStatus)?;
    let state = ProviderReadinessState::try_from(status.state)
        .map_err(|_| ProviderReadinessError::InvalidStatus)?;
    if matches!(
        state,
        ProviderReadinessState::Ready | ProviderReadinessState::Revoked
    ) {
        if state != completion_state(receipt).map_err(|_| ProviderReadinessError::InvalidStatus)? {
            return Err(ProviderReadinessError::InvalidStatus);
        }
        // A status read has the same installation contract as a wait. Enum
        // labels alone must never report ready or revoked to a direct caller.
        validate_completion(status)?;
    }
    Ok(())
}

fn completion_state(
    receipt: &ProviderMutationReceipt,
) -> Result<ProviderReadinessState, ProviderReadinessError> {
    let desired = receipt
        .desired
        .as_ref()
        .ok_or(ProviderReadinessError::InvalidReceipt)?;
    let attached = !desired.provider_id.is_empty();
    match ProviderMutationKind::try_from(receipt.kind) {
        Ok(ProviderMutationKind::Attach | ProviderMutationKind::Update) if attached => {
            Ok(ProviderReadinessState::Ready)
        }
        Ok(ProviderMutationKind::Detach) if !attached => Ok(ProviderReadinessState::Revoked),
        Ok(ProviderMutationKind::Observe) => Ok(if attached {
            ProviderReadinessState::Ready
        } else {
            ProviderReadinessState::Revoked
        }),
        _ => Err(ProviderReadinessError::InvalidReceipt),
    }
}

/// Validate saved receipt identity without fetching a runtime observation.
///
/// Initial attachment epochs may be empty and revision fingerprints may be zero;
/// the mutation kind must still agree with the presence of a provider identity.
///
/// # Errors
/// Rejects incomplete receipts, invalid persistence timestamps, and inconsistent
/// mutation/provider identities.
pub fn validate_provider_receipt(
    receipt: &ProviderMutationReceipt,
) -> Result<(), ProviderReadinessError> {
    let desired = receipt
        .desired
        .as_ref()
        .ok_or(ProviderReadinessError::InvalidReceipt)?;
    let persisted_time = receipt
        .persisted_time
        .as_ref()
        .ok_or(ProviderReadinessError::InvalidReceipt)?;
    openshell_core::time::validate_timestamp(persisted_time)
        .map_err(|_| ProviderReadinessError::InvalidReceipt)?;
    if receipt.receipt_id.is_empty()
        || receipt.mutation_id.is_empty()
        || desired.sandbox_id.is_empty()
        || desired.sandbox.is_empty()
        || receipt.provider.is_empty()
        || receipt.workspace.is_empty()
        || matches!(
            ProviderMutationKind::try_from(receipt.kind),
            Err(_) | Ok(ProviderMutationKind::Unspecified)
        )
    {
        return Err(ProviderReadinessError::InvalidReceipt);
    }
    completion_state(receipt)?;
    Ok(())
}

fn request_for_receipt(
    receipt: &ProviderMutationReceipt,
) -> Result<GetSandboxProviderStatusRequest, ProviderReadinessError> {
    validate_provider_receipt(receipt)?;
    let desired = receipt
        .desired
        .as_ref()
        .ok_or(ProviderReadinessError::InvalidReceipt)?;
    Ok(GetSandboxProviderStatusRequest {
        workspace_scope: Some(workspace_selector(&receipt.workspace)),
        sandbox: desired.sandbox.clone(),
        provider: receipt.provider.clone(),
        receipt_id: receipt.receipt_id.clone(),
    })
}

fn request_workspace(request: &GetSandboxProviderStatusRequest) -> Option<&str> {
    match request.workspace_scope.as_ref()?.selection.as_ref()? {
        workspace_selector::Selection::Workspace(workspace) => Some(workspace),
        workspace_selector::Selection::AllWorkspaces(_) => None,
    }
}

fn disposition(
    receipt: &ProviderMutationReceipt,
    status: &mut ProviderReadinessStatus,
) -> Result<Option<ProviderWaitOutcome>, ProviderReadinessError> {
    validate_status(status)?;
    let observed_receipt = status
        .receipt
        .as_ref()
        .ok_or(ProviderReadinessError::InvalidStatus)?;
    // Status reconstruction creates an immutable observation receipt too. The
    // full receipt must remain fixed; a later snapshot cannot move this target.
    if observed_receipt.desired != receipt.desired
        || observed_receipt.provider != receipt.provider
        || observed_receipt.workspace != receipt.workspace
        || (!receipt.receipt_id.is_empty()
            && (observed_receipt.receipt_id != receipt.receipt_id
                || observed_receipt.mutation_id != receipt.mutation_id
                || observed_receipt.kind != receipt.kind
                || observed_receipt.persisted_time != receipt.persisted_time))
    {
        status.receipt = Some(receipt.clone());
        status.state = ProviderReadinessState::Superseded.into();
        status.reason = ProviderReadinessReason::DesiredStateChanged.into();
        return Ok(Some(ProviderWaitOutcome::Terminal));
    }
    let state = ProviderReadinessState::try_from(status.state)
        .map_err(|_| ProviderReadinessError::InvalidStatus)?;
    let revoked = completion_state(receipt)? == ProviderReadinessState::Revoked;
    match state {
        ProviderReadinessState::Ready if !revoked => {
            validate_completion(status)?;
            Ok(Some(ProviderWaitOutcome::Complete))
        }
        ProviderReadinessState::Revoked if revoked => {
            validate_completion(status)?;
            Ok(Some(ProviderWaitOutcome::Complete))
        }
        ProviderReadinessState::Withheld
        | ProviderReadinessState::Failed
        | ProviderReadinessState::Superseded => Ok(Some(ProviderWaitOutcome::Terminal)),
        ProviderReadinessState::Ready | ProviderReadinessState::Revoked => {
            Err(ProviderReadinessError::InvalidStatus)
        }
        _ => Ok(None),
    }
}

fn validate_completion(status: &ProviderReadinessStatus) -> Result<(), ProviderReadinessError> {
    let desired = status
        .receipt
        .as_ref()
        .and_then(|receipt| receipt.desired.as_ref())
        .ok_or(ProviderReadinessError::InvalidStatus)?;
    let observed = status
        .observed
        .as_ref()
        .ok_or(ProviderReadinessError::InvalidStatus)?;
    if desired.policy_hash.is_empty()
        || status.network_instance_id.is_empty()
        || observed.session_id.is_empty()
        || observed.process_instance_id.is_empty()
        || !observed.credentials_installed
        || !observed.policy_active
        || !observed.launch_environment_installed
        || observed.reason != i32::from(ProviderReadinessReason::Unspecified)
        || status.reason != i32::from(ProviderReadinessReason::Unspecified)
        || observed.attachment_epoch != desired.attachment_epoch
        || observed.provider_env_revision != desired.provider_env_revision
        || observed.config_revision != desired.config_revision
        || observed.policy_hash != desired.policy_hash
    {
        return Err(ProviderReadinessError::InvalidStatus);
    }
    Ok(())
}

async fn wait_with<F, Fut>(
    receipt: &ProviderMutationReceipt,
    deadline: Instant,
    interval: Duration,
    fetch: F,
) -> Result<ProviderWaitResult, ProviderReadinessError>
where
    F: FnMut(GetSandboxProviderStatusRequest) -> Fut,
    Fut: Future<Output = Result<ProviderReadinessStatus, ProviderReadinessError>>,
{
    wait_with_initial_status(
        receipt,
        persisted_status(receipt.clone()),
        deadline,
        interval,
        fetch,
    )
    .await
}

async fn wait_with_initial_status<F, Fut>(
    receipt: &ProviderMutationReceipt,
    mut last: ProviderReadinessStatus,
    deadline: Instant,
    interval: Duration,
    mut fetch: F,
) -> Result<ProviderWaitResult, ProviderReadinessError>
where
    F: FnMut(GetSandboxProviderStatusRequest) -> Fut,
    Fut: Future<Output = Result<ProviderReadinessStatus, ProviderReadinessError>>,
{
    let request = request_for_receipt(receipt)?;
    if let Some(outcome) = disposition(receipt, &mut last)? {
        return Ok(ProviderWaitResult {
            status: last,
            outcome,
        });
    }
    loop {
        if Instant::now() >= deadline {
            return Ok(ProviderWaitResult {
                status: last,
                outcome: ProviderWaitOutcome::TimedOut,
            });
        }
        // The timeout also cancels an RPC that never responds; sleeping alone
        // between polls cannot enforce a bounded wait against an unavailable peer.
        match tokio::time::timeout_at(deadline, fetch(request.clone())).await {
            Ok(result) => last = result?,
            Err(_) => {
                return Ok(ProviderWaitResult {
                    status: last,
                    outcome: ProviderWaitOutcome::TimedOut,
                });
            }
        }
        if let Some(outcome) = disposition(receipt, &mut last)? {
            return Ok(ProviderWaitResult {
                status: last,
                outcome,
            });
        }
        tokio::time::sleep_until((Instant::now() + interval).min(deadline)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use openshell_core::proto::ProviderDesiredIdentity;

    fn receipt(kind: ProviderMutationKind) -> ProviderMutationReceipt {
        ProviderMutationReceipt {
            receipt_id: "receipt".into(),
            mutation_id: "mutation".into(),
            provider: "provider".into(),
            workspace: "default".into(),
            persisted_time: Some(openshell_core::time::timestamp_from_millis(1).unwrap()),
            kind: kind.into(),
            desired: Some(ProviderDesiredIdentity {
                sandbox_id: "sandbox-id".into(),
                sandbox: "sandbox".into(),
                provider_id: if kind == ProviderMutationKind::Detach {
                    String::new()
                } else {
                    "provider-id".into()
                },
                attachment_epoch: "attachment-epoch".into(),
                policy_hash: "policy-hash".into(),
                provider_env_revision: u64::MAX,
                ..Default::default()
            }),
        }
    }

    fn completed_status(
        receipt: &ProviderMutationReceipt,
        state: ProviderReadinessState,
    ) -> ProviderReadinessStatus {
        let desired = receipt.desired.as_ref().unwrap();
        ProviderReadinessStatus {
            receipt: Some(receipt.clone()),
            state: state.into(),
            network_instance_id: "network-instance".into(),
            observed: Some(openshell_core::proto::ProviderReadinessObservation {
                session_id: "session".into(),
                process_instance_id: "process-instance".into(),
                attachment_epoch: desired.attachment_epoch.clone(),
                provider_env_revision: desired.provider_env_revision,
                config_revision: desired.config_revision,
                policy_hash: desired.policy_hash.clone(),
                credentials_installed: true,
                policy_active: true,
                launch_environment_installed: true,
                ..Default::default()
            }),
            ..Default::default()
        }
    }

    #[test]
    fn receipt_requires_a_present_canonical_persistence_time() {
        let mut receipt = receipt(ProviderMutationKind::Attach);
        for (seconds, nanos, valid) in [
            (0, 1, true),
            (0, 0, true),
            (-1, 999_999_999, true),
            (1, -1, false),
            (1, 1_000_000_000, false),
            (253_402_300_800, 0, false),
            (-62_135_596_801, 0, false),
        ] {
            let timestamp = receipt.persisted_time.as_mut().unwrap();
            timestamp.seconds = seconds;
            timestamp.nanos = nanos;
            assert_eq!(
                validate_provider_receipt(&receipt).is_ok(),
                valid,
                "seconds={seconds}, nanos={nanos}"
            );
        }
        receipt.persisted_time = None;
        assert!(matches!(
            validate_provider_receipt(&receipt),
            Err(ProviderReadinessError::InvalidReceipt)
        ));
    }

    #[test]
    fn changed_persistence_nanoseconds_supersede_the_original_receipt() {
        let receipt = receipt(ProviderMutationKind::Attach);
        let mut changed = receipt.clone();
        changed.persisted_time.as_mut().unwrap().nanos += 1;
        let mut status = completed_status(&changed, ProviderReadinessState::Ready);
        assert_eq!(
            disposition(&receipt, &mut status).unwrap(),
            Some(ProviderWaitOutcome::Terminal)
        );
        assert_eq!(status.state, i32::from(ProviderReadinessState::Superseded));
        assert_eq!(status.receipt.as_ref(), Some(&receipt));
    }

    #[test]
    fn status_rejects_malformed_observation_and_evaluation_times() {
        let receipt = receipt(ProviderMutationKind::Attach);
        let mut malformed = openshell_core::time::timestamp_from_millis(1).unwrap();
        malformed.nanos = -1;
        for observation in [true, false] {
            let mut status = completed_status(&receipt, ProviderReadinessState::Ready);
            if observation {
                status.observed_time = Some(malformed);
            } else {
                status.evaluated_time = Some(malformed);
            }
            assert!(matches!(
                validate_status(&status),
                Err(ProviderReadinessError::InvalidStatus)
            ));
        }
    }

    #[test]
    fn direct_status_accepts_receipt_only_and_explicit_provider_selectors() {
        let receipt = receipt(ProviderMutationKind::Attach);
        let status = completed_status(&receipt, ProviderReadinessState::Ready);
        let mut request = GetSandboxProviderStatusRequest {
            sandbox: "sandbox".into(),
            receipt_id: receipt.receipt_id.clone(),
            workspace_scope: Some(workspace_selector("default")),
            ..Default::default()
        };
        assert!(validate_status_for_request(&status, &request).is_ok());

        request.provider = receipt.provider;
        assert!(validate_status_for_request(&status, &request).is_ok());

        request.receipt_id.clear();
        assert!(validate_status_for_request(&status, &request).is_ok());
    }

    #[test]
    fn direct_status_rejects_mismatched_explicit_selectors() {
        let receipt = receipt(ProviderMutationKind::Attach);
        let status = completed_status(&receipt, ProviderReadinessState::Ready);
        let request = GetSandboxProviderStatusRequest {
            sandbox: "sandbox".into(),
            receipt_id: receipt.receipt_id,
            workspace_scope: Some(workspace_selector("default")),
            ..Default::default()
        };
        for invalid in [
            GetSandboxProviderStatusRequest {
                receipt_id: String::new(),
                ..request.clone()
            },
            GetSandboxProviderStatusRequest {
                provider: "other-provider".into(),
                ..request.clone()
            },
            GetSandboxProviderStatusRequest {
                receipt_id: "other-receipt".into(),
                ..request.clone()
            },
            GetSandboxProviderStatusRequest {
                sandbox: "other-sandbox".into(),
                ..request.clone()
            },
            GetSandboxProviderStatusRequest {
                workspace_scope: Some(workspace_selector("other-workspace")),
                ..request
            },
        ] {
            assert!(matches!(
                validate_status_for_request(&status, &invalid),
                Err(ProviderReadinessError::InvalidStatus)
            ));
        }
    }

    #[tokio::test]
    async fn pending_process_waits_until_exact_receipt_is_ready() {
        let receipt = receipt(ProviderMutationKind::Attach);
        let mut calls = 0;
        let result = wait_with(
            &receipt,
            Instant::now() + Duration::from_secs(1),
            Duration::ZERO,
            |_| {
                calls += 1;
                let mut status = completed_status(&receipt, ProviderReadinessState::Ready);
                status.state = if calls == 1 {
                    ProviderReadinessState::Pending
                } else {
                    ProviderReadinessState::Ready
                }
                .into();
                status.reason = if calls == 1 {
                    ProviderReadinessReason::WaitingForProcess
                } else {
                    ProviderReadinessReason::Unspecified
                }
                .into();
                async { Ok(status) }
            },
        )
        .await
        .unwrap();
        assert_eq!(calls, 2);
        assert_eq!(result.outcome, ProviderWaitOutcome::Complete);
    }

    #[tokio::test]
    async fn deadline_bounds_a_hung_status_rpc() {
        let receipt = receipt(ProviderMutationKind::Update);
        let result = wait_with(
            &receipt,
            Instant::now() + Duration::from_millis(10),
            Duration::ZERO,
            |_| std::future::pending(),
        )
        .await
        .unwrap();
        assert_eq!(result.outcome, ProviderWaitOutcome::TimedOut);
        assert_eq!(
            result.status.state,
            i32::from(ProviderReadinessState::Persisted)
        );
    }

    #[test]
    fn different_authority_is_superseded_even_with_a_smaller_fingerprint() {
        let receipt = receipt(ProviderMutationKind::Update);
        let mut newer_receipt = receipt.clone();
        newer_receipt
            .desired
            .as_mut()
            .unwrap()
            .provider_env_revision = 1;
        let mut status = completed_status(&newer_receipt, ProviderReadinessState::Ready);
        assert_eq!(
            disposition(&receipt, &mut status).unwrap(),
            Some(ProviderWaitOutcome::Terminal)
        );
        assert_eq!(status.state, i32::from(ProviderReadinessState::Superseded));
    }

    #[test]
    fn detach_requires_revocation_and_installation_failure_is_terminal() {
        let receipt = receipt(ProviderMutationKind::Detach);
        let mut status = completed_status(&receipt, ProviderReadinessState::Ready);
        assert!(disposition(&receipt, &mut status).is_err());
        status.state = ProviderReadinessState::Revoked.into();
        assert_eq!(
            disposition(&receipt, &mut status).unwrap(),
            Some(ProviderWaitOutcome::Complete)
        );
        status.state = ProviderReadinessState::Failed.into();
        status.reason = ProviderReadinessReason::CredentialInstallFailed.into();
        assert_eq!(
            disposition(&receipt, &mut status).unwrap(),
            Some(ProviderWaitOutcome::Terminal)
        );
    }

    #[test]
    fn initial_empty_epoch_requires_a_complete_policy_identity() {
        let mut receipt = receipt(ProviderMutationKind::Observe);
        receipt.desired.as_mut().unwrap().attachment_epoch.clear();
        let mut status = completed_status(&receipt, ProviderReadinessState::Ready);
        assert_eq!(
            disposition(&receipt, &mut status).unwrap(),
            Some(ProviderWaitOutcome::Complete)
        );

        receipt.desired.as_mut().unwrap().policy_hash.clear();
        let mut status = completed_status(&receipt, ProviderReadinessState::Ready);
        assert!(disposition(&receipt, &mut status).is_err());
    }

    #[test]
    fn direct_status_rejects_missing_installation_and_inconsistent_authority() {
        let attached = receipt(ProviderMutationKind::Attach);
        let mut status = completed_status(&attached, ProviderReadinessState::Ready);
        status
            .observed
            .as_mut()
            .unwrap()
            .launch_environment_installed = false;
        assert!(validate_status(&status).is_err());

        let mut missing_provider = attached;
        missing_provider
            .desired
            .as_mut()
            .unwrap()
            .provider_id
            .clear();
        assert!(
            validate_status(&completed_status(
                &missing_provider,
                ProviderReadinessState::Ready
            ))
            .is_err()
        );

        let mut detach = receipt(ProviderMutationKind::Detach);
        detach.desired.as_mut().unwrap().provider_id = "still-attached".into();
        assert!(
            validate_status(&completed_status(&detach, ProviderReadinessState::Revoked)).is_err()
        );

        let mut observe = receipt(ProviderMutationKind::Observe);
        observe.desired.as_mut().unwrap().provider_id.clear();
        assert!(
            validate_status(&completed_status(&observe, ProviderReadinessState::Revoked)).is_ok()
        );
    }

    #[tokio::test]
    async fn initial_completed_status_returns_without_another_rpc() {
        let receipt = receipt(ProviderMutationKind::Attach);
        let status = completed_status(&receipt, ProviderReadinessState::Ready);
        let result = wait_with_initial_status(
            &receipt,
            status,
            Instant::now() + Duration::from_millis(10),
            Duration::ZERO,
            |_| std::future::pending(),
        )
        .await
        .unwrap();
        assert_eq!(result.outcome, ProviderWaitOutcome::Complete);
    }

    #[tokio::test]
    async fn initial_pending_status_survives_a_hung_followup_rpc() {
        let receipt = receipt(ProviderMutationKind::Attach);
        let mut status = persisted_status(receipt.clone());
        status.state = ProviderReadinessState::Pending.into();
        status.reason = ProviderReadinessReason::WaitingForProcess.into();
        let result = wait_with_initial_status(
            &receipt,
            status.clone(),
            Instant::now() + Duration::from_millis(10),
            Duration::ZERO,
            |_| std::future::pending(),
        )
        .await
        .unwrap();
        assert_eq!(result.outcome, ProviderWaitOutcome::TimedOut);
        assert_eq!(result.status, status);
    }

    #[test]
    fn rejects_unbounded_waits_and_unknown_states() {
        assert!(provider_wait_deadline(Duration::ZERO).is_err());
        assert!(provider_wait_deadline(MAX_PROVIDER_WAIT + Duration::from_secs(1)).is_err());
        let receipt = receipt(ProviderMutationKind::Attach);
        let mut status = persisted_status(receipt.clone());
        status.state = 99;
        assert!(disposition(&receipt, &mut status).is_err());
    }

    #[test]
    fn claimed_ready_without_process_acknowledgment_is_invalid() {
        let receipt = receipt(ProviderMutationKind::Attach);
        let mut status = completed_status(&receipt, ProviderReadinessState::Ready);
        status
            .observed
            .as_mut()
            .unwrap()
            .launch_environment_installed = false;
        assert!(disposition(&receipt, &mut status).is_err());
    }
}
