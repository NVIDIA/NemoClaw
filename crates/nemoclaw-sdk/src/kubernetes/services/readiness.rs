// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Retry observation races without hiding persistent failures or terminal workloads.
use super::Response;
use crate::ObservationError;
use std::future::Future;
use std::time::Duration;

const OVERALL: Duration = Duration::from_secs(9 * 3600);
const TRANSIENT: Duration = Duration::from_secs(30);
/// How long a scheduler rejection must persist before readiness stops.
/// Kubernetes reports `Unschedulable` while a cluster autoscaler adds a Node,
/// a volume claim with Immediate binding is provisioned, or a GPU device
/// plugin registers; bringing up a GPU Node, including its driver
/// installation, can take this long.
const UNSCHEDULABLE_GRACE: Duration = Duration::from_secs(15 * 60);

pub(super) async fn wait<F, Fut>(mut observe: F) -> Result<Response, ObservationError>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = Result<Response, ObservationError>>,
{
    let deadline = tokio::time::Instant::now() + OVERALL;
    let mut failing_since = None;
    // Measured locally from this wait's first rejection; Pod timestamps come
    // from another clock.
    let mut unschedulable_since = None;
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
                unschedulable_since = None;
                if response.running == Some(true) {
                    return Ok(response);
                }
            }
            Err(error @ ObservationError::ModelScheduling { .. }) => {
                failing_since = None;
                let since = unschedulable_since.get_or_insert(started);
                if tokio::time::Instant::now() - *since >= UNSCHEDULABLE_GRACE {
                    return Err(error);
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
    fn pending(nominated: Option<&str>, message: &str) -> kube::api::DynamicObject {
        serde_json::from_value(serde_json::json!({
            "apiVersion": "v1", "kind": "Pod", "metadata": {},
            "status": {"phase": "Pending", "nominatedNodeName": nominated, "conditions": [{
                "type": "PodScheduled", "status": "False", "reason": "Unschedulable", "message": message}]}
        }))
        .unwrap()
    }

    /// Observe a Pod as the cluster readiness wait does before reading runtime status.
    fn observe(
        pod: &kube::api::DynamicObject,
        running: bool,
    ) -> Result<Response, ObservationError> {
        match super::super::status::scheduling(pod, "model") {
            Some(error) => Err(error),
            None => Ok(Response {
                id: Some("owned".into()),
                running: Some(running),
            }),
        }
    }

    #[tokio::test(start_paused = true)]
    async fn a_scheduler_rejection_that_clears_within_the_grace_period_does_not_stop_readiness() {
        let start = tokio::time::Instant::now();
        let rejected = pending(
            None,
            "0/1 nodes are available: 1 Insufficient nvidia.com/gpu.",
        );
        let scheduled = pending(None, "");
        let result = wait(|| {
            let elapsed = tokio::time::Instant::now() - start;
            std::future::ready(if elapsed < UNSCHEDULABLE_GRACE - Duration::from_secs(5) {
                observe(&rejected, false)
            } else {
                // Bound to a Node: the scheduler condition clears.
                let mut scheduled = scheduled.clone();
                scheduled.data["status"] = serde_json::json!({"phase": "Running"});
                observe(
                    &scheduled,
                    elapsed >= UNSCHEDULABLE_GRACE + Duration::from_secs(60),
                )
            })
        })
        .await
        .unwrap();
        assert_eq!(result.running, Some(true));
    }

    #[tokio::test(start_paused = true)]
    async fn a_persistent_scheduler_rejection_stops_after_the_grace_period() {
        let start = tokio::time::Instant::now();
        let token = "a".repeat(40);
        let pod = pending(
            None,
            &format!(
                "0/2 nodes are available: 2 Insufficient nvidia.com/gpu; token={token} {}",
                "x ".repeat(1024)
            ),
        );
        let result = wait(|| std::future::ready(observe(&pod, false))).await;
        let Err(error @ ObservationError::ModelScheduling { .. }) = result else {
            panic!("{result:?}");
        };
        let elapsed = tokio::time::Instant::now() - start;
        assert!(
            elapsed >= UNSCHEDULABLE_GRACE
                && elapsed < UNSCHEDULABLE_GRACE + Duration::from_secs(2),
            "{elapsed:?}"
        );
        let message = error.to_string();
        assert!(message.contains("Insufficient nvidia.com/gpu"), "{message}");
        assert!(!message.contains(&token), "{message}");
        assert!(message.len() < 1400, "{message}");
    }

    #[tokio::test(start_paused = true)]
    async fn the_grace_period_restarts_when_the_scheduler_rejection_clears() {
        let start = tokio::time::Instant::now();
        let rejected = pending(
            None,
            "0/1 nodes are available: 1 node(s) were unschedulable.",
        );
        let result = wait(|| {
            let elapsed = tokio::time::Instant::now() - start;
            // A brief successful placement attempt clears the condition midway.
            std::future::ready(
                if (Duration::from_secs(600)..Duration::from_secs(602)).contains(&elapsed) {
                    Ok(Response {
                        id: Some("owned".into()),
                        running: Some(false),
                    })
                } else {
                    observe(&rejected, false)
                },
            )
        })
        .await;
        assert!(matches!(
            result,
            Err(ObservationError::ModelScheduling { .. })
        ));
        let elapsed = tokio::time::Instant::now() - start;
        assert!(
            elapsed >= Duration::from_secs(602) + UNSCHEDULABLE_GRACE,
            "{elapsed:?}"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn a_pod_nominated_by_preemption_keeps_waiting_past_the_grace_period() {
        let start = tokio::time::Instant::now();
        let nominated = pending(
            Some("gpu-2"),
            "0/2 nodes are available: 2 Insufficient nvidia.com/gpu. preemption: 1 victim",
        );
        let result = wait(|| {
            let elapsed = tokio::time::Instant::now() - start;
            std::future::ready(observe(&nominated, elapsed >= 2 * UNSCHEDULABLE_GRACE))
        })
        .await
        .unwrap();
        assert_eq!(result.running, Some(true));
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
