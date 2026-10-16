// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Provisional ownership of only a newly started inference service. Parent EOF
//! before the fixed commit record closes that service's own job. After commit,
//! its native guardian and package lease have an independent lifetime.
use super::{Handle, RawHandle};
use std::io::Read;
use std::os::windows::io::AsRawHandle;
use std::ptr::null_mut;
use std::sync::{
    Arc,
    atomic::{AtomicU8, Ordering},
};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

#[link(name = "kernel32")]
unsafe extern "system" {
    fn GetFileType(handle: RawHandle) -> u32;
    fn CancelSynchronousIo(thread: RawHandle) -> i32;
    fn WaitForMultipleObjects(
        count: u32,
        handles: *const RawHandle,
        wait_all: i32,
        milliseconds: u32,
    ) -> u32;
}
struct OwnedJob(Handle);
unsafe impl Send for OwnedJob {}
impl OwnedJob {
    fn monitor(self) -> bool {
        let mut bytes = Vec::new();
        let committed = std::io::stdin()
            .lock()
            .take(8)
            .read_to_end(&mut bytes)
            .is_ok()
            && bytes == b"commit\n";
        if !committed {
            unsafe {
                super::TerminateJobObject(self.0.0, 1);
            }
        }
        committed
    }
}
pub(super) struct Gate {
    thread: Option<JoinHandle<bool>>,
    outcome: Arc<AtomicU8>,
}
impl Gate {
    pub(super) fn start(job: RawHandle) -> Result<Self, &'static str> {
        let input = unsafe { super::GetStdHandle((-10i32) as u32) };
        if input.is_null() || input as isize == -1 || unsafe { GetFileType(input) } != 3 {
            return Err("runtime-service-startup-pipe");
        }
        let current = unsafe { super::GetCurrentProcess() };
        let mut copy = null_mut();
        if unsafe { super::DuplicateHandle(current, job, current, &mut copy, 0, 0, 2) } == 0 {
            return Err("runtime-service-startup-job");
        }
        let job = OwnedJob(Handle(copy));
        let outcome = Arc::new(AtomicU8::new(0));
        let observed = outcome.clone();
        let thread = std::thread::Builder::new()
            .name("native-service-admission".into())
            .spawn(move || {
                let committed = job.monitor();
                observed.store(if committed { 1 } else { 2 }, Ordering::Release);
                committed
            })
            .map_err(|_| "runtime-service-startup-thread")?;
        Ok(Self {
            thread: Some(thread),
            outcome,
        })
    }
    pub(super) fn wait_for_process(&self, process: RawHandle) -> Result<(), &'static str> {
        let handles = [
            process,
            self.thread
                .as_ref()
                .ok_or("runtime-service-startup-thread")?
                .as_raw_handle(),
        ];
        match unsafe { WaitForMultipleObjects(2, handles.as_ptr(), 0, u32::MAX) } {
            0 => Ok(()),
            1 if self.outcome.load(Ordering::Acquire) == 1 => {
                if unsafe { super::WaitForSingleObject(process, u32::MAX) } == 0 {
                    Ok(())
                } else {
                    Err("runtime-host-wait")
                }
            }
            1 => Err("runtime-service-uncommitted"),
            _ => Err("runtime-host-wait"),
        }
    }
    pub(super) fn finish(mut self) -> Result<bool, &'static str> {
        self.finish_inner()
    }
    fn finish_inner(&mut self) -> Result<bool, &'static str> {
        let Some(thread) = self.thread.take() else {
            return Ok(false);
        };
        let deadline = Instant::now() + Duration::from_secs(5);
        while !thread.is_finished() && Instant::now() < deadline {
            unsafe {
                CancelSynchronousIo(thread.as_raw_handle());
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        if !thread.is_finished() {
            return Err("runtime-service-startup-cleanup");
        }
        thread
            .join()
            .map_err(|_| "runtime-service-startup-panicked")
    }
}
impl Drop for Gate {
    fn drop(&mut self) {
        if self.thread.is_some() {
            let _ = self.finish_inner();
        }
    }
}
