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

pub(in crate::services) struct Monitors<'a> {
    pub samples: Receiver<Result<Capacity, Error>>,
    pub ready: Receiver<bool>,
    pub trip: CancellationToken,
    pub report: &'a (dyn Fn(&str, &str, u32) -> Result<(), Error> + Sync),
}
pub(in crate::services) struct Policy {
    pub startup_timeout: Duration,
    pub protection: ProtectionPolicy,
}
pub(in crate::services) async fn supervise(
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
            ()=monitors.trip.cancelled()=>break Err(Error::Conflict("memory protection tripped by operator; explicit apply required")),
            _=child.wait()=>break Err(Error::Conflict("managed service process exited; inspect retained logs and explicitly reapply")),
            Some(true)=monitors.ready.recv()=>{
                ready=true;
                if let Err(error)=(monitors.report)("ready","managed service readiness confirmed",child.id().unwrap_or(0)) {break Err(error);}
            },
            ()=tokio::time::sleep_until(deadline),if !ready=>break Err(Error::Conflict("managed service loading exceeded startup budget; data retained")),
            sample=monitors.samples.recv()=>{
                match sample {
                    Some(Ok(memory)) if !watch.sample(memory.available,memory.free)=>{},
                    Some(Ok(memory))=>break Err(Error::Execution {
                        operation: "memory protection".into(),
                        diagnostic: format!("host memory pressure stopped the managed service: available={} free={}; explicit apply required", memory.available, memory.free),
                    }),
                    Some(Err(error))=>break Err(Error::Execution {
                        operation: "memory protection".into(),
                        diagnostic: format!("memory observation failed: {error}; managed service stopped; explicit apply required"),
                    }),
                    None=>break Err(Error::Conflict("memory sample stream closed; managed service stopped; explicit apply required")),
                }
            }
        }
    };
    terminate(child).await;
    result
}
pub(in crate::services) async fn terminate(child: &mut dyn ChildWrapper) {
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
