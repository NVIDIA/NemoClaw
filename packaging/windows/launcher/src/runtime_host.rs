// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Native guardian: create the owned Node process inside its job atomically,
//! preserving command arguments and waiting for all descendants before release.
#[path = "runtime_browser.rs"]
mod browser;
#[path = "runtime_inference_owner.rs"]
mod inference_owner;
#[path = "runtime_service_startup.rs"]
mod service_startup;
use std::ffi::{OsStr, c_void};
use std::os::windows::ffi::OsStrExt;
use std::process::Command;
use std::ptr::{null, null_mut};
use std::time::{Duration, Instant};
type RawHandle = *mut c_void;
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
    priority_class: u32,
    scheduling_class: u32,
}
#[repr(C)]
#[derive(Default)]
struct ExtendedLimits {
    basic: BasicLimits,
    io: [u64; 6],
    process_memory: usize,
    job_memory: usize,
    peak_process_memory: usize,
    peak_job_memory: usize,
}
#[repr(C)]
#[derive(Default)]
struct Accounting {
    user: i64,
    kernel: i64,
    period_user: i64,
    period_kernel: i64,
    page_faults: u32,
    total: u32,
    active: u32,
    terminated: u32,
}
#[repr(C)]
struct Startup {
    size: u32,
    reserved: *mut u16,
    desktop: *mut u16,
    title: *mut u16,
    x: u32,
    y: u32,
    xsize: u32,
    ysize: u32,
    xchars: u32,
    ychars: u32,
    fill: u32,
    flags: u32,
    show: u16,
    reserved_size: u16,
    reserved_bytes: *mut u8,
    input: RawHandle,
    output: RawHandle,
    error: RawHandle,
}
#[repr(C)]
struct StartupEx {
    base: Startup,
    attributes: *mut c_void,
}
#[repr(C)]
struct ProcessInfo {
    process: RawHandle,
    thread: RawHandle,
    pid: u32,
    tid: u32,
}
#[link(name = "kernel32")]
unsafe extern "system" {
    fn CreateJobObjectW(security: *const c_void, name: *const u16) -> RawHandle;
    fn SetInformationJobObject(job: RawHandle, class: i32, data: *const c_void, size: u32) -> i32;
    fn QueryInformationJobObject(
        job: RawHandle,
        class: u32,
        data: *mut c_void,
        size: u32,
        returned: *mut u32,
    ) -> i32;
    fn TerminateJobObject(job: RawHandle, code: u32) -> i32;
    fn IsProcessInJob(process: RawHandle, job: RawHandle, result: *mut i32) -> i32;
    fn InitializeProcThreadAttributeList(
        list: *mut c_void,
        count: u32,
        flags: u32,
        size: *mut usize,
    ) -> i32;
    fn UpdateProcThreadAttribute(
        list: *mut c_void,
        flags: u32,
        attribute: usize,
        value: *const c_void,
        size: usize,
        previous: *mut c_void,
        returned: *mut usize,
    ) -> i32;
    fn DeleteProcThreadAttributeList(list: *mut c_void);
    fn CreateProcessW(
        application: *const u16,
        line: *mut u16,
        process_attributes: *const c_void,
        thread_attributes: *const c_void,
        inherit: i32,
        flags: u32,
        environment: *const c_void,
        cwd: *const u16,
        startup: *mut Startup,
        process: *mut ProcessInfo,
    ) -> i32;
    fn GetCurrentProcess() -> RawHandle;
    fn CreatePipe(
        read: *mut RawHandle,
        write: *mut RawHandle,
        security: *const SecurityAttributes,
        size: u32,
    ) -> i32;
    fn WriteFile(
        handle: RawHandle,
        buffer: *const c_void,
        size: u32,
        written: *mut u32,
        overlapped: *mut c_void,
    ) -> i32;
    fn CreateFileW(
        path: *const u16,
        access: u32,
        share: u32,
        security: *const SecurityAttributes,
        disposition: u32,
        flags: u32,
        template: RawHandle,
    ) -> RawHandle;
    fn GetStdHandle(which: u32) -> RawHandle;
    fn DuplicateHandle(
        source_process: RawHandle,
        source: RawHandle,
        target_process: RawHandle,
        target: *mut RawHandle,
        access: u32,
        inherit: i32,
        options: u32,
    ) -> i32;
    fn CloseHandle(handle: RawHandle) -> i32;
    fn WaitForSingleObject(handle: RawHandle, milliseconds: u32) -> u32;
    fn GetExitCodeProcess(process: RawHandle, code: *mut u32) -> i32;
    fn CompareStringOrdinal(
        first: *const u16,
        first_len: i32,
        second: *const u16,
        second_len: i32,
        ignore_case: i32,
    ) -> i32;
}
#[repr(C)]
struct SecurityAttributes {
    size: u32,
    descriptor: *mut c_void,
    inherit: i32,
}
struct Handle(RawHandle);
impl Drop for Handle {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.0);
        }
    }
}
struct Attributes {
    memory: Vec<usize>,
    initialized: bool,
}
impl Attributes {
    fn new() -> Result<Self, &'static str> {
        let mut size = 0;
        unsafe { InitializeProcThreadAttributeList(null_mut(), 2, 0, &mut size) };
        if size == 0 || size > 65536 {
            return Err("runtime-host-attributes");
        }
        let mut value = Self {
            memory: vec![0; size.div_ceil(std::mem::size_of::<usize>())],
            initialized: false,
        };
        if unsafe { InitializeProcThreadAttributeList(value.pointer(), 2, 0, &mut size) } == 0 {
            return Err("runtime-host-attributes");
        }
        value.initialized = true;
        Ok(value)
    }
    fn pointer(&mut self) -> *mut c_void {
        self.memory.as_mut_ptr().cast()
    }
    fn set(
        &mut self,
        attribute: usize,
        value: *const c_void,
        size: usize,
    ) -> Result<(), &'static str> {
        if unsafe {
            UpdateProcThreadAttribute(
                self.pointer(),
                0,
                attribute,
                value,
                size,
                null_mut(),
                null_mut(),
            )
        } == 0
        {
            Err("runtime-host-attributes")
        } else {
            Ok(())
        }
    }
}
impl Drop for Attributes {
    fn drop(&mut self) {
        if self.initialized {
            unsafe {
                DeleteProcThreadAttributeList(self.memory.as_mut_ptr().cast());
            }
        }
    }
}
fn wide(value: &OsStr) -> Result<Vec<u16>, &'static str> {
    let mut v = value.encode_wide().collect::<Vec<_>>();
    if v.contains(&0) || v.len() > 32760 {
        return Err("runtime-host-argument");
    }
    v.push(0);
    Ok(v)
}
fn quoted(value: &OsStr) -> Result<Vec<u16>, &'static str> {
    let raw = wide(value)?;
    let mut output = vec![b'"' as u16];
    let mut slashes = 0;
    for &unit in &raw[..raw.len() - 1] {
        if unit == b'\\' as u16 {
            slashes += 1;
            continue;
        }
        if unit == b'"' as u16 {
            output.extend(std::iter::repeat_n(b'\\' as u16, slashes * 2 + 1));
        } else {
            output.extend(std::iter::repeat_n(b'\\' as u16, slashes));
        }
        slashes = 0;
        output.push(unit);
    }
    output.extend(std::iter::repeat_n(b'\\' as u16, slashes * 2));
    output.push(b'"' as u16);
    Ok(output)
}
fn same_name(a: &OsStr, b: &OsStr) -> bool {
    let a = a.encode_wide().collect::<Vec<_>>();
    let b = b.encode_wide().collect::<Vec<_>>();
    unsafe { CompareStringOrdinal(a.as_ptr(), a.len() as i32, b.as_ptr(), b.len() as i32, 1) == 2 }
}
fn environment(command: &Command) -> Result<Vec<u16>, &'static str> {
    // Native callers inherit their process environment and add explicit overrides;
    // they do not use Command::env_clear. Values are preserved as UTF-16.
    let mut values = std::env::vars_os().collect::<Vec<_>>();
    for (key, value) in command.get_envs() {
        values.retain(|(existing, _)| !same_name(existing, key));
        if let Some(value) = value {
            values.push((key.to_owned(), value.to_owned()));
        }
    }
    values.sort_by(|(a, _), (b, _)| {
        let a = a.encode_wide().collect::<Vec<_>>();
        let b = b.encode_wide().collect::<Vec<_>>();
        match unsafe {
            CompareStringOrdinal(a.as_ptr(), a.len() as i32, b.as_ptr(), b.len() as i32, 1)
        } {
            1 => std::cmp::Ordering::Less,
            3 => std::cmp::Ordering::Greater,
            _ => std::cmp::Ordering::Equal,
        }
    });
    let mut block = Vec::new();
    for (key, value) in values {
        let key = wide(&key)?;
        let value = wide(&value)?;
        block.extend_from_slice(&key[..key.len() - 1]);
        block.push(b'=' as u16);
        block.extend(value);
        if block.len() > 1024 * 1024 {
            return Err("runtime-host-environment");
        }
    }
    block.push(0);
    Ok(block)
}
fn duplicate(handle: RawHandle) -> Result<Handle, &'static str> {
    let mut value = null_mut();
    let current = unsafe { GetCurrentProcess() };
    if unsafe { DuplicateHandle(current, handle, current, &mut value, 0, 1, 2) } == 0 {
        return Err("runtime-host-handle");
    }
    Ok(Handle(value))
}
fn active(job: &Handle) -> Result<u32, &'static str> {
    let mut info = Accounting::default();
    if unsafe {
        QueryInformationJobObject(
            job.0,
            1,
            (&mut info as *mut Accounting).cast(),
            std::mem::size_of::<Accounting>() as u32,
            null_mut(),
        )
    } == 0
    {
        return Err("runtime-host-job-query");
    }
    Ok(info.active)
}

pub(crate) fn run(
    command: Command,
    flags: u32,
    lease_handle: RawHandle,
    start_handshake: bool,
) -> Result<i32, &'static str> {
    run_managed(command, flags, lease_handle, start_handshake, None, false)
}

pub(crate) fn run_managed(
    mut command: Command,
    flags: u32,
    lease_handle: RawHandle,
    start_handshake: bool,
    service_root: Option<&std::path::Path>,
    provisional_service: bool,
) -> Result<i32, &'static str> {
    let service = service_root
        .map(inference_owner::Pending::new)
        .transpose()?;
    if let Some(pending) = &service {
        command.env("NEMOCLAW_RUNTIME_SERVICE_PIPE", &pending.name);
    }
    let job = Handle(unsafe { CreateJobObjectW(null(), null()) });
    if job.0.is_null() {
        return Err("runtime-host-job");
    }
    let mut limits = ExtendedLimits::default();
    limits.basic.flags = 0x2000;
    if unsafe {
        SetInformationJobObject(
            job.0,
            9,
            (&limits as *const ExtendedLimits).cast(),
            std::mem::size_of::<ExtendedLimits>() as u32,
        )
    } == 0
    {
        return Err("runtime-host-job");
    }
    let browser_profile = command
        .get_args()
        .next()
        .is_some_and(|mode| mode == "web" || mode == "hermes-dashboard");
    #[cfg(test)]
    let browser_profile = browser_profile
        || command.get_envs().any(|(key, value)| {
            key == "NEMOCLAW_GUARDIAN_TEST_MODE"
                && value.is_some_and(|value| value.to_string_lossy().starts_with("browser-"))
        });
    let browser = if browser_profile {
        Some(inference_owner::Pending::browser(
            service_root.ok_or("runtime-browser-installation")?,
            job.0,
        )?)
    } else {
        None
    };
    if let Some(pending) = &browser {
        command.env("NEMOCLAW_RUNTIME_BROWSER_PIPE", &pending.name);
    } else {
        command.env_remove("NEMOCLAW_RUNTIME_BROWSER_PIPE");
    }
    let startup_gate = if provisional_service {
        Some(service_startup::Gate::start(job.0)?)
    } else {
        None
    };
    let inherited_lease = duplicate(lease_handle)?;
    let mut inherited = vec![inherited_lease];
    let mut std = [null_mut(); 3];
    let mut handshake_writer = None;
    let security = SecurityAttributes {
        size: std::mem::size_of::<SecurityAttributes>() as u32,
        descriptor: null_mut(),
        inherit: 1,
    };
    if flags & 0x10 == 0 {
        for (index, which) in [(-10i32) as u32, (-11i32) as u32, (-12i32) as u32]
            .into_iter()
            .enumerate()
        {
            let value = if index == 0 && start_handshake {
                let mut read = null_mut();
                let mut write = null_mut();
                if unsafe { CreatePipe(&mut read, &mut write, &security, 0) } == 0 {
                    return Err("runtime-host-handshake");
                }
                handshake_writer = Some(Handle(write));
                Handle(read)
            } else {
                let source = unsafe { GetStdHandle(which) };
                if !source.is_null() && source as isize != -1 {
                    duplicate(source)?
                } else {
                    let name = [b'N' as u16, b'U' as u16, b'L' as u16, 0];
                    let raw = unsafe {
                        CreateFileW(
                            name.as_ptr(),
                            if index == 0 { 0x80000000 } else { 0x40000000 },
                            3,
                            &security,
                            3,
                            0x80,
                            null_mut(),
                        )
                    };
                    if raw.is_null() || raw as isize == -1 {
                        return Err("runtime-host-standard-handle");
                    }
                    Handle(raw)
                }
            };
            std[index] = value.0;
            inherited.push(value);
        }
    }
    let handles = inherited.iter().map(|h| h.0).collect::<Vec<_>>();
    let mut attributes = Attributes::new()?;
    attributes.set(
        0x0002000d,
        (&job.0 as *const RawHandle).cast(),
        std::mem::size_of::<RawHandle>(),
    )?;
    attributes.set(
        0x00020002,
        handles.as_ptr().cast(),
        handles.len() * std::mem::size_of::<RawHandle>(),
    )?;
    let mut startup = StartupEx {
        base: Startup {
            size: std::mem::size_of::<StartupEx>() as u32,
            reserved: null_mut(),
            desktop: null_mut(),
            title: null_mut(),
            x: 0,
            y: 0,
            xsize: 0,
            ysize: 0,
            xchars: 0,
            ychars: 0,
            fill: 0,
            flags: if std.iter().all(|v| !v.is_null()) {
                0x100
            } else {
                0
            },
            show: 0,
            reserved_size: 0,
            reserved_bytes: null_mut(),
            input: std[0],
            output: std[1],
            error: std[2],
        },
        attributes: attributes.pointer(),
    };
    let application = wide(command.get_program())?;
    let mut line = quoted(command.get_program())?;
    for arg in command.get_args() {
        line.push(b' ' as u16);
        line.extend(quoted(arg)?);
    }
    if line.len() > 32760 {
        return Err("runtime-host-argument");
    }
    line.push(0);
    let env = environment(&command)?;
    let cwd = wide(
        command
            .get_current_dir()
            .ok_or("runtime-host-cwd")?
            .as_os_str(),
    )?;
    let mut child = ProcessInfo {
        process: null_mut(),
        thread: null_mut(),
        pid: 0,
        tid: 0,
    };
    if unsafe {
        CreateProcessW(
            application.as_ptr(),
            line.as_mut_ptr(),
            null(),
            null(),
            1,
            flags | 0x80000 | 0x400,
            env.as_ptr().cast(),
            cwd.as_ptr(),
            &mut startup.base,
            &mut child,
        )
    } == 0
    {
        return Err("runtime-host-start");
    }
    let process = Handle(child.process);
    let _thread = Handle(child.thread);
    let service_worker = service
        .map(|pending| pending.start(process.0, child.pid))
        .transpose()?;
    drop(inherited);
    let browser_worker = browser
        .map(|pending| pending.start(process.0, child.pid))
        .transpose()?;
    if let Some(writer) = &handshake_writer {
        let mut written = 0;
        if unsafe {
            WriteFile(
                writer.0,
                b"start\n".as_ptr().cast(),
                6,
                &mut written,
                null_mut(),
            )
        } == 0
            || written != 6
        {
            return Err("runtime-host-handshake");
        }
    }
    let mut in_job = 0;
    if unsafe { IsProcessInJob(process.0, job.0, &mut in_job) } == 0 || in_job == 0 {
        return Err("runtime-host-job-assignment");
    }
    if let Some(gate) = &startup_gate {
        gate.wait_for_process(process.0)?;
    } else if unsafe { WaitForSingleObject(process.0, u32::MAX) } != 0 {
        return Err("runtime-host-wait");
    }
    let mut code = 1;
    if unsafe { GetExitCodeProcess(process.0, &mut code) } == 0 {
        return Err("runtime-host-exit");
    }
    let browser_result = browser_worker.map(|worker| worker.finish()).transpose();
    let service_result = service_worker.map(|worker| worker.finish()).transpose();
    let startup_result = startup_gate.map(|gate| gate.finish()).transpose();
    let settle_deadline = Instant::now() + Duration::from_secs(5);
    while active(&job)? != 0 && Instant::now() < settle_deadline {
        std::thread::sleep(Duration::from_millis(25));
    }
    if active(&job)? != 0 {
        if unsafe { TerminateJobObject(job.0, 1) } == 0 {
            return Err("runtime-host-descendants");
        }
        let deadline = Instant::now() + Duration::from_secs(5);
        while active(&job)? != 0 && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(25));
        }
        if active(&job)? != 0 {
            return Err("runtime-host-descendants");
        }
        return Err("runtime-host-left-descendants");
    }
    if let Err(error) = browser_result {
        if code == 0 {
            return Err(error);
        }
        eprintln!("The native browser request owner also failed cleanup.");
    }
    if let Err(error) = service_result {
        if code == 0 {
            return Err(error);
        }
        eprintln!("The native service request owner also failed cleanup.");
    }
    match startup_result {
        Ok(Some(false)) if code == 0 => return Err("runtime-service-uncommitted"),
        Err(error) if code == 0 => return Err(error),
        Err(_) => eprintln!("The provisional native service owner also failed cleanup."),
        _ => {}
    }
    Ok(code as i32)
}

#[cfg(test)]
#[path = "runtime_host_windows_tests.rs"]
mod tests;
