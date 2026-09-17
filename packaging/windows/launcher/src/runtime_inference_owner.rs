// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Fixed inference-start requests from the actual held agent Node process.
//! The guardian stays outside the agent job; the existing inference launcher
//! owns a separate package lease/job, with no breakaway permission.
use super::{Handle, RawHandle, SecurityAttributes, wide};
use std::ffi::{OsStr, c_void};
use std::io::{Read, Write};
use std::os::windows::io::{AsRawHandle, FromRawHandle};
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::ptr::null_mut;
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

#[repr(C)]
#[derive(Default)]
struct FileTime {
    low: u32,
    high: u32,
}
#[link(name = "kernel32")]
unsafe extern "system" {
    fn CreateNamedPipeW(
        name: *const u16,
        open_mode: u32,
        pipe_mode: u32,
        instances: u32,
        output: u32,
        input: u32,
        timeout: u32,
        security: *const SecurityAttributes,
    ) -> RawHandle;
    fn ConnectNamedPipe(pipe: RawHandle, overlapped: *mut c_void) -> i32;
    fn GetNamedPipeClientProcessId(pipe: RawHandle, pid: *mut u32) -> i32;
    fn GetProcessTimes(
        process: RawHandle,
        created: *mut FileTime,
        exited: *mut FileTime,
        kernel: *mut FileTime,
        user: *mut FileTime,
    ) -> i32;
    fn CancelSynchronousIo(thread: RawHandle) -> i32;
    fn LocalFree(value: *mut c_void) -> *mut c_void;
}
#[link(name = "advapi32")]
unsafe extern "system" {
    fn ConvertStringSecurityDescriptorToSecurityDescriptorW(
        text: *const u16,
        revision: u32,
        output: *mut *mut c_void,
        length: *mut u32,
    ) -> i32;
}
#[link(name = "bcrypt")]
unsafe extern "system" {
    fn BCryptGenRandom(algorithm: RawHandle, bytes: *mut u8, length: u32, flags: u32) -> i32;
}

struct Pipe(Handle);
// An exclusively owned Windows kernel handle may move between threads. It is
// never copied, shared as a mutable File, or exposed to the client process.
unsafe impl Send for Pipe {}
impl Pipe {
    fn into_file(self) -> std::fs::File {
        let raw = self.0.0;
        std::mem::forget(self);
        unsafe { std::fs::File::from_raw_handle(raw) }
    }
}
struct Agent {
    handle: Handle,
    pid: u32,
    created: u64,
}
unsafe impl Send for Agent {}
impl Agent {
    fn live(&self) -> bool {
        (unsafe { super::WaitForSingleObject(self.handle.0, 0) == 258 })
            && creation(self.handle.0).ok() == Some(self.created)
    }
    fn accepts(&self, pipe: RawHandle) -> bool {
        let mut pid = 0;
        (unsafe { GetNamedPipeClientProcessId(pipe, &mut pid) != 0 })
            && pid == self.pid
            && self.live()
    }
}
pub(super) fn creation(handle: RawHandle) -> Result<u64, &'static str> {
    let mut created = FileTime::default();
    let mut exited = FileTime::default();
    let mut kernel = FileTime::default();
    let mut user = FileTime::default();
    if unsafe { GetProcessTimes(handle, &mut created, &mut exited, &mut kernel, &mut user) } == 0 {
        return Err("runtime-service-identity");
    }
    Ok((u64::from(created.high) << 32) | u64::from(created.low))
}
fn clone_process(handle: RawHandle) -> Result<Handle, &'static str> {
    let current = unsafe { super::GetCurrentProcess() };
    let mut copy = null_mut();
    if unsafe { super::DuplicateHandle(current, handle, current, &mut copy, 0, 0, 2) } == 0 {
        return Err("runtime-service-identity");
    }
    Ok(Handle(copy))
}
fn stopped(stop: &AtomicBool, agent: &Agent) -> bool {
    stop.load(Ordering::Acquire) || !agent.live()
}
fn read_action(file: &mut std::fs::File) -> Result<String, &'static str> {
    let mut value = Vec::new();
    let mut byte = [0u8; 1];
    while value.len() < 16 {
        if file
            .read(&mut byte)
            .map_err(|_| "runtime-service-channel")?
            != 1
        {
            return Err("runtime-service-channel");
        }
        if byte[0] == b'\n' {
            return String::from_utf8(value).map_err(|_| "runtime-service-request");
        }
        if !byte[0].is_ascii_lowercase() {
            return Err("runtime-service-request");
        }
        value.push(byte[0]);
    }
    Err("runtime-service-request")
}
fn reply(file: &mut std::fs::File, value: &str) -> Result<(), &'static str> {
    file.write_all(value.as_bytes())
        .map_err(|_| "runtime-service-channel")
}
fn start_existing(installation: &Path) -> Result<Child, &'static str> {
    let mut command = Command::new(installation.join("bin").join("NemoClaw.exe"));
    command
        .args(["--native-inference", "serve", "--startup-owned"])
        .current_dir(installation)
        .creation_flags(0x08000000 | 8)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .env_clear();
    for (key, value) in std::env::vars_os() {
        if matches!(
            key.to_string_lossy().to_ascii_lowercase().as_str(),
            "localappdata"
                | "systemroot"
                | "systemdrive"
                | "temp"
                | "tmp"
                | "windir"
                | "comspec"
                | "number_of_processors"
                | "processor_architecture"
                | "os"
                | "pathext"
        ) {
            command.env(key, value);
        }
    }
    let system = std::env::var_os("SystemRoot").ok_or("runtime-service-environment")?;
    let mut path = system.clone();
    path.push("\\System32;");
    path.push(&system);
    command
        .env("PATH", path)
        .env("NEMOCLAW_NATIVE_INSTALL_ROOT", installation);
    command.spawn().map_err(|_| "runtime-service-start")
}
fn cancel_started(child: &mut Child) -> Result<(), &'static str> {
    if child
        .try_wait()
        .map_err(|_| "runtime-service-status")?
        .is_some()
    {
        return Ok(());
    }
    child.kill().map_err(|_| "runtime-service-cancel")?;
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        if child
            .try_wait()
            .map_err(|_| "runtime-service-status")?
            .is_some()
        {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    Err("runtime-service-cancel")
}

// An exclusive duplicate keeps the private job alive only for its guardian worker.
struct BrowserJob(Handle);
unsafe impl Send for BrowserJob {}
pub(super) struct Pending {
    pipe: Pipe,
    pub(super) name: String,
    installation: PathBuf,
    browser_job: Option<BrowserJob>,
}
pub(super) struct Worker {
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<Result<(), &'static str>>>,
}
impl Pending {
    pub(super) fn new(installation: &Path) -> Result<Self, &'static str> {
        let mut nonce = [0u8; 16];
        if unsafe { BCryptGenRandom(null_mut(), nonce.as_mut_ptr(), 16, 2) } < 0 {
            return Err("runtime-service-random");
        }
        let suffix = nonce.iter().map(|v| format!("{v:02x}")).collect::<String>();
        let name = format!("\\\\.\\pipe\\NemoClawRuntime-{suffix}");
        let security_text = wide(OsStr::new("D:P(A;;GA;;;SY)(A;;GA;;;OW)"))?;
        let mut descriptor = null_mut();
        if unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                security_text.as_ptr(),
                1,
                &mut descriptor,
                null_mut(),
            )
        } == 0
        {
            return Err("runtime-service-security");
        }
        let attributes = SecurityAttributes {
            size: std::mem::size_of::<SecurityAttributes>() as u32,
            descriptor,
            inherit: 0,
        };
        let handle = unsafe {
            CreateNamedPipeW(
                wide(OsStr::new(&name))?.as_ptr(),
                3 | 0x80000,
                8,
                1,
                4096,
                4096,
                0,
                &attributes,
            )
        };
        unsafe {
            LocalFree(descriptor);
        }
        if handle.is_null() || handle as isize == -1 {
            return Err("runtime-service-pipe");
        }
        Ok(Self {
            pipe: Pipe(Handle(handle)),
            name,
            installation: installation.to_owned(),
            browser_job: None,
        })
    }
    pub(super) fn browser(installation: &Path, job: RawHandle) -> Result<Self, &'static str> {
        let mut pending = Self::new(installation)?;
        pending.browser_job = Some(BrowserJob(clone_process(job)?));
        Ok(pending)
    }
    pub(super) fn start(self, process: RawHandle, pid: u32) -> Result<Worker, &'static str> {
        let agent = Agent {
            handle: clone_process(process)?,
            pid,
            created: creation(process)?,
        };
        let stop = Arc::new(AtomicBool::new(false));
        let worker_stop = stop.clone();
        let thread = std::thread::Builder::new()
            .name("native-inference-start".into())
            .spawn(move || self.serve(agent, worker_stop))
            .map_err(|_| "runtime-service-thread")?;
        Ok(Worker {
            stop,
            thread: Some(thread),
        })
    }
    fn serve(self, agent: Agent, stop: Arc<AtomicBool>) -> Result<(), &'static str> {
        let mut child: Option<Child> = None;
        let mut committed = false;
        let result = (|| {
            let raw = self.pipe.0.0;
            if stopped(&stop, &agent) {
                return Ok(());
            }
            let connected = unsafe { ConnectNamedPipe(raw, null_mut()) } != 0;
            if !connected && std::io::Error::last_os_error().raw_os_error() != Some(535) {
                return if stopped(&stop, &agent) {
                    Ok(())
                } else {
                    Err("runtime-service-connect")
                };
            }
            if !agent.accepts(raw) {
                return Err("runtime-service-client");
            }
            // The File owns the same unique handle after the Pipe guard is moved.
            let mut file = self.pipe.into_file();
            if let Some(job) = &self.browser_job {
                return super::browser::serve(file, || !stopped(&stop, &agent), job.0.0);
            }
            if stopped(&stop, &agent) {
                return Ok(());
            }
            if read_action(&mut file)? != "start" {
                return Err("runtime-service-request");
            }
            if stopped(&stop, &agent) {
                return Ok(());
            }
            child = Some(start_existing(&self.installation)?);
            let started = child.as_ref().ok_or("runtime-service-identity")?;
            let identity = creation(started.as_raw_handle())?;
            let pid = started.id();
            reply(&mut file, &format!("started {pid} {identity:016x}\n"))?;
            for _ in 0..4096 {
                if stopped(&stop, &agent) {
                    return Ok(());
                }
                let action = read_action(&mut file)?;
                if stopped(&stop, &agent) {
                    return Ok(());
                }
                let owned = child.as_mut().ok_or("runtime-service-identity")?;
                match action.as_str() {
                    "status" => match owned.try_wait().map_err(|_| "runtime-service-status")? {
                        None => reply(&mut file, "running\n")?,
                        Some(status) => reply(
                            &mut file,
                            &format!("exited {}\n", status.code().unwrap_or(1) as u32),
                        )?,
                    },
                    "commit" => {
                        if owned
                            .try_wait()
                            .map_err(|_| "runtime-service-status")?
                            .is_some()
                        {
                            return Err("runtime-service-exited");
                        }
                        let mut startup =
                            owned.stdin.take().ok_or("runtime-service-startup-pipe")?;
                        startup
                            .write_all(b"commit\n")
                            .and_then(|_| startup.flush())
                            .map_err(|_| "runtime-service-startup-commit")?;
                        drop(startup);
                        committed = true;
                        reply(&mut file, "committed\n")?;
                        return Ok(());
                    }
                    "cancel" => {
                        cancel_started(owned)?;
                        reply(&mut file, "cancelled\n")?;
                        return Ok(());
                    }
                    _ => return Err("runtime-service-request"),
                }
            }
            Err("runtime-service-request-limit")
        })();
        if !committed {
            if let Some(owned) = child.as_mut() {
                if let Err(cleanup) = cancel_started(owned) {
                    return result.and(Err(cleanup));
                }
            }
        }
        if stopped(&stop, &agent) && result == Err("runtime-service-channel") {
            Ok(())
        } else {
            result
        }
    }
}
impl Worker {
    pub(super) fn finish(mut self) -> Result<(), &'static str> {
        self.finish_inner()
    }
    fn finish_inner(&mut self) -> Result<(), &'static str> {
        self.stop.store(true, Ordering::Release);
        let Some(thread) = self.thread.take() else {
            return Ok(());
        };
        let deadline = Instant::now() + Duration::from_secs(6);
        while !thread.is_finished() && Instant::now() < deadline {
            // This dedicated thread performs only this owned pipe's I/O. The
            // stop flag prevents another read/spawn between cancellation calls.
            unsafe {
                CancelSynchronousIo(thread.as_raw_handle());
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        if !thread.is_finished() {
            return Err("runtime-service-worker-cleanup");
        }
        thread
            .join()
            .map_err(|_| "runtime-service-worker-panicked")?
    }
}
impl Drop for Worker {
    fn drop(&mut self) {
        if self.thread.is_some() {
            let _ = self.finish_inner();
        }
    }
}
