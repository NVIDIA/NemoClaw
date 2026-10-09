// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Retry observation races without hiding persistent failures or terminal workloads.
use super::Response;
use crate::ObservationError;
use std::future::Future;
use std::time::Duration;

const OVERALL: Duration = Duration::from_secs(9 * 3600);
const TRANSIENT: Duration = Duration::from_secs(30);

pub(super) async fn wait<F, Fut>(mut observe: F) -> Result<Response, ObservationError>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = Result<Response, ObservationError>>,
{
    let deadline = tokio::time::Instant::now() + OVERALL;
    let mut failing_since = None;
    loop {
        let started = tokio::time::Instant::now();
        if started >= deadline {
            return Err(ObservationError::Backend(
                "model runtime readiness timed out; storage retained; unchanged apply resumes waiting",
            ));
        }
        let observation_deadline = deadline.min(failing_since.unwrap_or(started) + TRANSIENT);
        let result = tokio::time::timeout_at(observation_deadline, observe())
            .await
            .unwrap_or(Err(ObservationError::Transport));
        match result {
            Ok(response) => {
                failing_since = None;
                if response.running == Some(true) {
                    return Ok(response);
                }
            }
            Err(
                error @ (ObservationError::Transport
                | ObservationError::Query
                | ObservationError::Incomplete),
            ) => {
                let since = failing_since.get_or_insert(started);
                if tokio::time::Instant::now() - *since >= TRANSIENT {
                    return Err(error);
                }
            }
            Err(error) => return Err(error),
        }
        tokio::time::sleep(
            Duration::from_secs(1)
                .min(deadline.saturating_duration_since(tokio::time::Instant::now())),
        )
        .await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{cell::Cell, time::Duration};
    #[tokio::test(start_paused = true)]
    async fn authentication_permission_and_binding_failures_do_not_consume_a_retry_budget() {
        for error in [
            ObservationError::Authentication,
            ObservationError::Permission,
            ObservationError::BindingMismatch,
            ObservationError::KubernetesObjectMismatch {
                kind: "Pod".into(),
                namespace: "agents".into(),
                name: "model".into(),
                field: "metadata.uid",
            },
        ] {
            let start = tokio::time::Instant::now();
            let result = wait(|| std::future::ready(Err(error.clone()))).await;
            assert_eq!(result, Err(error));
            assert_eq!(tokio::time::Instant::now(), start);
        }
    }
    #[tokio::test(start_paused = true)]
    async fn a_stalled_observation_is_bounded_by_the_same_transient_budget() {
        let start = tokio::time::Instant::now();
        let result = wait(std::future::pending).await;
        assert_eq!(result, Err(ObservationError::Transport));
        assert_eq!(tokio::time::Instant::now() - start, Duration::from_secs(30));
    }
    #[tokio::test(start_paused = true)]
    async fn pending_work_stops_at_the_overall_budget_and_can_be_observed_again() {
        let start = tokio::time::Instant::now();
        let result = wait(|| {
            std::future::ready(Ok(Response {
                id: Some("owned".into()),
                running: Some(false),
            }))
        })
        .await;
        assert!(
            matches!(result, Err(ObservationError::Backend(message)) if message.contains("unchanged apply resumes waiting"))
        );
        assert_eq!(tokio::time::Instant::now() - start, OVERALL);
    }
    #[tokio::test(start_paused = true)]
    async fn transient_failures_retry_but_consecutive_failures_stop_after_thirty_seconds() {
        let start = tokio::time::Instant::now();
        let result = wait(|| async { Err(ObservationError::Transport) }).await;
        assert_eq!(result, Err(ObservationError::Transport));
        assert_eq!(tokio::time::Instant::now() - start, Duration::from_secs(30));
    }
    #[tokio::test(start_paused = true)]
    async fn successful_observation_resets_the_transient_failure_budget() {
        let calls = Cell::new(0);
        let result = wait(|| {
            let call = calls.get();
            calls.set(call + 1);
            std::future::ready(if call == 20 {
                Ok(Response {
                    id: Some("owned".into()),
                    running: Some(false),
                })
            } else if call == 40 {
                Ok(Response {
                    id: Some("owned".into()),
                    running: Some(true),
                })
            } else {
                Err(ObservationError::Incomplete)
            })
        })
        .await
        .unwrap();
        assert_eq!(result.running, Some(true));
        assert_eq!(calls.get(), 41);
    }
    #[tokio::test(start_paused = true)]
    async fn model_preparation_can_run_longer_than_the_runtime_loading_budget() {
        let start = tokio::time::Instant::now();
        let result = wait(|| {
            std::future::ready(Ok(Response {
                id: Some("owned".into()),
                running: Some(tokio::time::Instant::now() - start >= Duration::from_secs(2 * 3600)),
            }))
        })
        .await
        .unwrap();
        assert_eq!(result.running, Some(true));
    }
}
