// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::{Deployment, Progress};
use crate::Error;
use std::{future::Future, time::Instant};

/// Outcome of a measured deployment step; diagnostics are reported separately.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StepOutcome {
    Succeeded,
    Failed,
    Cancelled,
}
impl std::fmt::Display for StepOutcome {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Succeeded => "succeeded",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
        })
    }
}

impl Deployment {
    pub(super) fn report_timing<T>(
        &self,
        operation: &'static str,
        started: Instant,
        result: Result<T, Error>,
    ) -> Result<T, Error> {
        let outcome = match &result {
            Ok(_) => StepOutcome::Succeeded,
            Err(Error::Cancelled) => StepOutcome::Cancelled,
            Err(_) => StepOutcome::Failed,
        };
        (self.progress)(Progress::Completed {
            operation,
            elapsed: started.elapsed(),
            outcome,
        });
        result
    }

    pub(super) async fn timed<T>(
        &self,
        operation: &'static str,
        future: impl Future<Output = Result<T, Error>>,
    ) -> Result<T, Error> {
        let started = Instant::now();
        (self.progress)(Progress::Waiting {
            operation,
            elapsed: started.elapsed(),
        });
        tokio::pin!(future);
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(10));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        interval.tick().await;
        loop {
            tokio::select! {
                result = &mut future => return self.report_timing(operation, started, result),
                _ = interval.tick() => (self.progress)(Progress::Waiting { operation, elapsed: started.elapsed() }),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    #[tokio::test]
    async fn waiting_is_reported_before_a_step_completes() {
        let events = Arc::new(Mutex::new(Vec::new()));
        let received = events.clone();
        let deployment = Deployment::new("unused".as_ref(), "unused".as_ref())
            .with_progress(Arc::new(move |event| received.lock().unwrap().push(event)));
        deployment
            .timed("runtime.ready", async {
                assert!(matches!(
                    events.lock().unwrap().as_slice(),
                    [Progress::Waiting {
                        operation: "runtime.ready",
                        ..
                    }]
                ));
                Ok(())
            })
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn timings_preserve_results_and_report_failure_and_cancellation_without_diagnostics() {
        let events = Arc::new(Mutex::new(Vec::new()));
        let received = events.clone();
        let deployment = Deployment::new("unused".as_ref(), "unused".as_ref())
            .with_progress(Arc::new(move |event| received.lock().unwrap().push(event)));
        assert_eq!(
            deployment.timed("test", async { Ok(42) }).await.unwrap(),
            42
        );
        assert!(matches!(
            deployment
                .timed::<()>("test", async { Err(Error::State("secret-sentinel")) })
                .await,
            Err(Error::State("secret-sentinel"))
        ));
        assert!(matches!(
            deployment
                .timed::<()>("test", async { Err(Error::Cancelled) })
                .await,
            Err(Error::Cancelled)
        ));
        let events = events.lock().unwrap();
        assert_eq!(events.len(), 6);
        for (event, expected) in events
            .iter()
            .filter(|event| matches!(event, Progress::Completed { .. }))
            .zip([
                StepOutcome::Succeeded,
                StepOutcome::Failed,
                StepOutcome::Cancelled,
            ])
        {
            assert!(
                matches!(event, Progress::Completed { operation: "test", outcome, .. } if *outcome == expected)
            );
        }
        assert!(!format!("{events:?}").contains("secret-sentinel"));
    }
}
