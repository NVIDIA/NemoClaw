// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! The host inference supervisor and its descendants share one kill-on-close job.
//! Node waits for our handshake before it can start a server or download work.

use std::ffi::c_void;
use std::io::Write;
use std::os::windows::io::AsRawHandle;
use std::process::{Command, Stdio};

#[repr(C)]
#[derive(Default)]
struct BasicLimits {
    process_time: i64,
    job_time: i64,
    flags: u32,
    min_working_set: usize,
    max_working_set: usize,
    active_process_limit: u32,
    affinity: usize,
    priority: u32,
    scheduling_class: u32,
}

#[repr(C)]
#[derive(Default)]
struct ExtendedLimits {
    basic: BasicLimits,
    io_counters: [u64; 6],
    process_memory_limit: usize,
    job_memory_limit: usize,
    peak_process_memory_used: usize,
    peak_job_memory_used: usize,
}

#[link(name = "kernel32")]
unsafe extern "system" {
    fn CreateJobObjectW(attributes: *const c_void, name: *const u16) -> *mut c_void;
    fn SetInformationJobObject(job: *mut c_void, class: i32, value: *const c_void, size: u32) -> i32;
    fn AssignProcessToJobObject(job: *mut c_void, process: *mut c_void) -> i32;
    fn CloseHandle(handle: *mut c_void) -> i32;
}

struct Job(*mut c_void);
impl Drop for Job {
    fn drop(&mut self) {
        unsafe { CloseHandle(self.0); }
    }
}

pub fn run(mut command: Command) -> Result<i32, String> {
    let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
    if handle.is_null() { return Err("Windows could not create the local inference process owner.".into()); }
    let job = Job(handle);
    let mut limits = ExtendedLimits::default();
    limits.basic.flags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    if unsafe { SetInformationJobObject(job.0, 9, (&limits as *const ExtendedLimits).cast(), std::mem::size_of::<ExtendedLimits>() as u32) } == 0 {
        return Err("Windows could not protect the local inference process lifetime.".into());
    }
    let mut child = command.stdin(Stdio::piped()).spawn()
        .map_err(|_| "The local inference supervisor could not start.".to_owned())?;
    if unsafe { AssignProcessToJobObject(job.0, child.as_raw_handle()) } == 0 {
        let _ = child.kill();
        let _ = child.wait();
        return Err("Windows could not attach the local inference supervisor to its process owner.".into());
    }
    let mut input = child.stdin.take().ok_or("The local inference handshake pipe is unavailable.")?;
    input.write_all(b"start\n").and_then(|_| input.flush())
        .map_err(|_| "The local inference supervisor did not accept its start handshake.".to_owned())?;
    // Keep the pipe and non-inheritable job handle alive until the supervisor exits.
    let status = child.wait().map_err(|_| "The local inference supervisor exit could not be observed.".to_owned())?;
    drop(input);
    drop(job);
    Ok(status.code().unwrap_or(1))
}
