// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
#[cfg(test)]
mod tests;

use crate::{
    CancellationToken, Error,
    hardware::{Capacity, ProtectionPolicy, Watchdog},
};
use process_wrap::tokio::ChildWrapper;
use std::time::Duration;
use tokio::sync::mpsc::Receiver;

pub(crate) struct Monitors<'a> {
    pub samples: Receiver<Result<Capacity, Error>>,
    pub ready: Receiver<bool>,
    pub trip: CancellationToken,
    pub report: &'a (dyn Fn(&str, &str, u32) -> Result<(), Error> + Sync),
}
pub(crate) struct Policy {
    pub startup_timeout: Duration,
    pub protection: ProtectionPolicy,
}
pub(crate) async fn supervise(
    policy: Policy,
    child: &mut dyn ChildWrapper,
    mut monitors: Monitors<'_>,
    cancel: &CancellationToken,
) -> Result<(), Error> {
    let mut watch = Watchdog::from_policy(policy.protection);
    let deadline = tokio::time::Instant::now() + policy.startup_timeout;
    let mut ready = false;
    let result = loop {
        tokio::select! {
            ()=cancel.cancelled()=>break Err(Error::Conflict("runtime stopped by operator; persistent data retained")),
            ()=monitors.trip.cancelled()=>break Err(Error::Conflict("memory protection tripped by operator; reapply required")),
            _=child.wait()=>break Err(Error::Exited(None)),
            Some(true)=monitors.ready.recv()=>{
                ready=true;
                if let Err(error)=(monitors.report)("ready","managed service readiness confirmed",child.id().unwrap_or(0)) {break Err(error);}
            },
            ()=tokio::time::sleep_until(deadline),if !ready=>break Err(Error::Conflict("managed service loading exceeded startup budget; data retained")),
            sample=monitors.samples.recv()=>{
                match sample {
                    Some(Ok(memory)) if !watch.sample(memory.available,memory.free)=>{},
                    Some(Ok(memory))=>break Err(Error::Protection(format!("host memory pressure stopped the managed service: available={} free={}; reapply required", memory.available, memory.free))),
                    Some(Err(error))=>break Err(Error::Protection(format!("memory observation failed: {error}; managed service stopped; reapply required"))),
                    None=>break Err(Error::Conflict("memory sample stream closed; managed service stopped; reapply required")),
                }
            }
        }
    };
    terminate(child).await;
    result
}
pub(crate) async fn terminate(child: &mut dyn ChildWrapper) {
    let _ = child.signal(15);
    if tokio::time::timeout(Duration::from_secs(30), child.wait())
        .await
        .is_err()
    {
        let _ = child.start_kill();
        let _ = child.wait().await;
    }
    // The group belongs to this runtime only. Workers may outlive the API
    // process; select by this established group, never a process name.
    let _ = child.start_kill();
}

/// Supervise the backend while the filter serves its published port. The filter
/// stops only by failing, which leaves the backend unreachable, so the backend
/// stops too; when supervision ends first, the filter stops before this returns.
pub(crate) async fn with_filter(
    policy: Policy,
    child: &mut dyn ChildWrapper,
    monitors: Monitors<'_>,
    cancel: &CancellationToken,
    mut filter: tokio::task::JoinHandle<std::convert::Infallible>,
) -> Result<(), Error> {
    let supervised = tokio::select! {
        result = supervise(policy, &mut *child, monitors, cancel) => Some(result),
        _ = &mut filter => None,
    };
    match supervised {
        Some(result) => {
            filter.abort();
            // Cancellation completes once the listener and connections close.
            let _ = filter.await;
            result
        }
        None => {
            terminate(child).await;
            Err(Error::Conflict(
                "inference route filter failed; managed service stopped; reapply required",
            ))
        }
    }
}
