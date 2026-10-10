// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Physical GPU adapters for the schema-1 leaf emission fixture. Full Rust
//! lowering, object metadata and Cargo's backend interface are separate work.
use crate::{
    codegen_service::*,
    machine_codegen::{self, MachineTarget, PackedFunction, PackedInstruction, Packet},
};
use std::{
    ffi::{c_char, c_int, c_void, CStr, CString},
    path::Path,
    ptr::NonNull,
    sync::{Arc, Mutex},
};

#[repr(C)]
#[derive(Clone, Copy, Default, Debug, serde::Serialize)]
pub struct NativeStats {
    pub gpu_ms: f64,
    pub total_ms: f64,
    pub host_prefix_ms: f64,
    pub count_gpu_ms: f64,
    pub emit_gpu_ms: f64,
    pub kernel_dispatches: u64,
    pub output_bytes: u64,
    pub buffer_allocations: u32,
    pub reused_pipeline: u32,
}
#[repr(C)]
struct Input {
    function_count: u32,
    instruction_count: u32,
    target: u32,
    reserved: u32,
    output_capacity: u64,
    functions: *const PackedFunction,
    instructions: *const PackedInstruction,
}
type Create = unsafe extern "C" fn(*const c_char, u32, *mut c_char, usize) -> *mut c_void;
type DeviceId = unsafe extern "C" fn(*mut c_void, *mut c_char, usize) -> c_int;
type Submit = unsafe extern "C" fn(*mut c_void, *const Input, *mut c_char, usize) -> c_int;
type Finish = unsafe extern "C" fn(
    *mut c_void,
    *mut u8,
    usize,
    *mut u32,
    *mut u32,
    usize,
    *mut NativeStats,
    *mut c_char,
    usize,
) -> c_int;
type Destroy = unsafe extern "C" fn(*mut c_void);

#[cfg_attr(target_os = "linux", link(name = "dl"))]
unsafe extern "C" {
    fn dlopen(path: *const c_char, flags: c_int) -> *mut c_void;
    fn dlsym(library: *mut c_void, name: *const c_char) -> *mut c_void;
    fn dlclose(library: *mut c_void) -> c_int;
    fn dlerror() -> *const c_char;
}
fn cerror(error: &[c_char]) -> String {
    unsafe { CStr::from_ptr(error.as_ptr()) }
        .to_string_lossy()
        .into_owned()
}
fn dl_error() -> String {
    let ptr = unsafe { dlerror() };
    if ptr.is_null() {
        "native codegen library loading failed".into()
    } else {
        unsafe { CStr::from_ptr(ptr) }
            .to_string_lossy()
            .into_owned()
    }
}
struct Library(NonNull<c_void>);
impl Library {
    fn open(path: &Path) -> Result<Self, String> {
        let path = CString::new(path.as_os_str().as_encoded_bytes())
            .map_err(|_| "library path contains NUL")?;
        NonNull::new(unsafe { dlopen(path.as_ptr(), 2) })
            .map(Self)
            .ok_or_else(dl_error)
    }
    fn symbol(&self, name: &[u8]) -> Result<*mut c_void, String> {
        NonNull::new(unsafe { dlsym(self.0.as_ptr(), name.as_ptr().cast()) })
            .map(NonNull::as_ptr)
            .ok_or_else(dl_error)
    }
}
impl Drop for Library {
    fn drop(&mut self) {
        unsafe {
            dlclose(self.0.as_ptr());
        }
    }
}
struct Context {
    _library: Library,
    pointer: Option<NonNull<c_void>>,
    submit: Submit,
    finish: Finish,
    destroy: Destroy,
    device_id: String,
    pending: bool,
}
// The context is accessed under one mutex; CUDA binds its device on every call.
// The DLL stays loaded until after its context is fenced and destroyed.
unsafe impl Send for Context {}
impl Drop for Context {
    fn drop(&mut self) {
        if let Some(p) = self.pointer.take() {
            unsafe {
                (self.destroy)(p.as_ptr());
            }
        }
    }
}

pub struct NativeExecutor {
    backend: GpuBackend,
    target: MachineTarget,
    context: Arc<Mutex<Context>>,
    prepared: Option<(BatchKey, Packet)>,
    stats: Arc<Mutex<Vec<NativeStats>>>,
}
impl NativeExecutor {
    pub fn new(
        backend: GpuBackend,
        target: MachineTarget,
        library: &Path,
        shader: Option<&Path>,
        device: u32,
    ) -> Result<Self, String> {
        let library = Library::open(library)?;
        let create: Create = unsafe { std::mem::transmute(library.symbol(b"gpuemit_create\0")?) };
        let device_id: DeviceId =
            unsafe { std::mem::transmute(library.symbol(b"gpuemit_device_id\0")?) };
        let submit: Submit = unsafe { std::mem::transmute(library.symbol(b"gpuemit_submit\0")?) };
        let finish: Finish = unsafe { std::mem::transmute(library.symbol(b"gpuemit_finish\0")?) };
        let destroy: Destroy =
            unsafe { std::mem::transmute(library.symbol(b"gpuemit_destroy\0")?) };
        let shader = CString::new(
            shader
                .map(|s| s.as_os_str().as_encoded_bytes())
                .unwrap_or(b""),
        )
        .map_err(|_| "shader path contains NUL")?;
        let mut error = [0 as c_char; 1024];
        let pointer = NonNull::new(unsafe {
            create(shader.as_ptr(), device, error.as_mut_ptr(), error.len())
        })
        .ok_or_else(|| cerror(&error))?;
        let mut identity = [0 as c_char; 1024];
        if unsafe { device_id(pointer.as_ptr(), identity.as_mut_ptr(), identity.len()) } != 0 {
            unsafe {
                destroy(pointer.as_ptr());
            }
            return Err("native bridge could not identify its physical device".into());
        }
        let id = cerror(&identity);
        if id.is_empty() {
            unsafe {
                destroy(pointer.as_ptr());
            }
            return Err("empty physical device identity".into());
        }
        Ok(Self {
            backend,
            target,
            context: Arc::new(Mutex::new(Context {
                _library: library,
                pointer: Some(pointer),
                submit,
                finish,
                destroy,
                device_id: id,
                pending: false,
            })),
            prepared: None,
            stats: Arc::new(Mutex::new(Vec::new())),
        })
    }
    pub fn stats(&self) -> Arc<Mutex<Vec<NativeStats>>> {
        self.stats.clone()
    }
}
impl BatchExecutor for NativeExecutor {
    fn capabilities(&self) -> DeviceCapabilities {
        let mut caps = DeviceCapabilities::physical_gpu(
            self.backend,
            self.context.lock().unwrap().device_id.clone(),
        );
        caps.max_batch_bytes = 128 * 1024 * 1024;
        caps
    }
    fn prepare(&mut self, batch: &FlatBatch) -> Result<(), String> {
        self.prepared = Some((
            batch.key().clone(),
            machine_codegen::pack(batch, self.target)?,
        ));
        Ok(())
    }
    fn submit(&mut self, batch: Arc<FlatBatch>) -> Result<Box<dyn PendingExecution>, String> {
        let (key, packet) = self
            .prepared
            .take()
            .ok_or("native batch was not prepared")?;
        if key != *batch.key() {
            return Err("native prepared identity mismatch".into());
        }
        let input = Input {
            function_count: u32::try_from(packet.functions.len())
                .map_err(|_| "function count overflow")?,
            instruction_count: u32::try_from(packet.instructions.len())
                .map_err(|_| "instruction count overflow")?,
            target: packet.target.number(),
            reserved: 0,
            output_capacity: packet.output_capacity as u64,
            functions: packet.functions.as_ptr(),
            instructions: packet.instructions.as_ptr(),
        };
        let mut context = self.context.lock().unwrap();
        if context.pending {
            return Err("native context has an outstanding batch".into());
        }
        let pointer = context
            .pointer
            .ok_or("native context was closed by a failed pending request")?;
        let mut error = [0 as c_char; 1024];
        if unsafe { (context.submit)(pointer.as_ptr(), &input, error.as_mut_ptr(), error.len()) }
            != 0
        {
            return Err(cerror(&error));
        }
        context.pending = true;
        drop(context);
        Ok(Box::new(NativePending {
            context: self.context.clone(),
            batch,
            packet,
            backend: self.backend,
            stats: self.stats.clone(),
            finished: false,
        }))
    }
}
struct NativePending {
    context: Arc<Mutex<Context>>,
    batch: Arc<FlatBatch>,
    packet: Packet,
    backend: GpuBackend,
    stats: Arc<Mutex<Vec<NativeStats>>>,
    finished: bool,
}
impl PendingExecution for NativePending {
    fn wait(mut self: Box<Self>) -> Result<Emission, String> {
        let mut output = vec![0; self.packet.output_capacity];
        let mut offsets = vec![0u32; self.packet.functions.len()];
        let mut lengths = offsets.clone();
        let mut stats = NativeStats::default();
        let mut error = [0 as c_char; 1024];
        let mut context = self.context.lock().unwrap();
        let pointer = context.pointer.ok_or("native context is closed")?;
        let status = unsafe {
            (context.finish)(
                pointer.as_ptr(),
                output.as_mut_ptr(),
                output.len(),
                offsets.as_mut_ptr(),
                lengths.as_mut_ptr(),
                offsets.len(),
                &mut stats,
                error.as_mut_ptr(),
                error.len(),
            )
        };
        if status != 0 {
            return Err(cerror(&error));
        }
        context.pending = false;
        self.finished = true;
        let device_id = context.device_id.clone();
        drop(context);
        if stats.kernel_dispatches == 0
            || stats.output_bytes == 0
            || stats.output_bytes as usize > output.len()
        {
            return Err("no valid native GPU emission was returned".into());
        }
        let mut functions = Vec::with_capacity(offsets.len());
        let mut expected = 0usize;
        for (i, (&offset, &len)) in offsets.iter().zip(&lengths).enumerate() {
            let start = offset as usize;
            let end = start
                .checked_add(len as usize)
                .ok_or("native result range overflow")?;
            if start != expected || len == 0 || end > stats.output_bytes as usize {
                return Err("native output ranges are incomplete or overlap".into());
            }
            let unwind =
                if self.batch.abis()[self.batch.functions()[i].abi as usize].requires_unwind {
                    machine_codegen::unwind_descriptor(self.packet.target, len as usize)
                } else {
                    Vec::new()
                };
            functions.push(FunctionEmission {
                symbol: self.packet.functions[i].symbol,
                code: output[start..end].to_vec(),
                relocations: Vec::new(),
                unwind,
            });
            expected = end;
        }
        if expected != stats.output_bytes as usize {
            return Err("unused native output bytes".into());
        }
        self.stats.lock().unwrap().push(stats);
        // The returned code comes from the native GPU output buffer. Object
        // publication and independent CPU/native execution checks happen later.
        Ok(Emission {
            functions,
            execution: ExecutionRecord::PhysicalGpu {
                backend: self.backend,
                device_id,
                kernel_dispatches: stats.kernel_dispatches,
                kernel_output_used: true,
            },
        })
    }
}
impl Drop for NativePending {
    fn drop(&mut self) {
        if !self.finished {
            let mut context = self.context.lock().unwrap_or_else(|p| p.into_inner());
            if let Some(pointer) = context.pointer.take() {
                unsafe {
                    (context.destroy)(pointer.as_ptr());
                }
            }
            context.pending = false;
        }
        // Retain batch and packet until after wait or the destroy fence.
        let _ = &self.batch;
    }
}
