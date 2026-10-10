// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! A dynamically loaded, persistent CUDA context. The CPU artifact can load a
//! library built on its GPU runner without linking to CUDA on the build host.

use crate::analysis::{GPUGroup, PackedAnalysis};
use std::path::Path;

#[repr(u32)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Algorithm {
    Dense = 0,
    Sparse = 1,
}

/// Placement remains independent from the fixed-point algorithm. Capability
/// discovery alone does not authorize a coherent-memory execution strategy.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PlacementPolicy {
    PinnedStaging,
    CoherentUnverified,
}

#[repr(C)]
#[derive(Default, Clone, Copy, Debug)]
pub struct Stats {
    pub initialization_ms: f64,
    pub staging_ms: f64,
    pub host_to_device_ms: f64,
    pub gpu_ms: f64,
    pub device_to_host_ms: f64,
    pub total_ms: f64,
    pub max_sweeps: u32,
    pub reused_context: u32,
    pub device_allocations: u32,
    pub pinned_allocations: u32,
    pub resident_input: u32,
    pub frontier_visits: u64,
    pub edges_examined: u64,
    pub discovered_bits: u64,
}

#[derive(Default, Clone, Debug)]
pub struct Capabilities {
    pub device_name: String,
    pub device_uuid: String,
    pub placement: String,
    pub driver_version: i32,
    pub runtime_version: i32,
    pub compute_major: i32,
    pub compute_minor: i32,
    pub unified_addressing: bool,
    pub managed_memory: bool,
    pub concurrent_managed_access: bool,
    pub pageable_memory_access: bool,
    pub host_page_tables: bool,
    pub direct_managed_access: bool,
    pub async_engine_count: i32,
    pub coherent_placement_verified: bool,
}

fn json_string(value: &str) -> String {
    let mut out = String::from("\"");
    for ch in value.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if c.is_control() => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

impl Stats {
    pub fn json(&self) -> String {
        format!(concat!("{{\"initialization_ms\":{},\"staging_ms\":{},\"host_to_device_ms\":{},",
            "\"gpu_ms\":{},\"device_to_host_ms\":{},\"total_ms\":{},\"max_sweeps\":{},",
            "\"reused_context\":{},\"device_allocations\":{},\"pinned_allocations\":{},",
            "\"resident_input\":{},\"frontier_visits\":{},\"edges_examined\":{},\"discovered_bits\":{}}}"),
            self.initialization_ms, self.staging_ms, self.host_to_device_ms, self.gpu_ms,
            self.device_to_host_ms, self.total_ms, self.max_sweeps, self.reused_context,
            self.device_allocations, self.pinned_allocations, self.resident_input,
            self.frontier_visits, self.edges_examined, self.discovered_bits)
    }
}
impl Capabilities {
    pub fn fingerprint(&self, cpu_workers: usize) -> String {
        let cpu = std::fs::read_to_string("/proc/cpuinfo")
            .ok()
            .and_then(|info| {
                info.lines().find_map(|line| {
                    line.strip_prefix("model name")
                        .and_then(|name| name.split_once(':'))
                        .map(|(_, name)| name.trim().to_owned())
                })
            })
            .unwrap_or_else(|| std::env::consts::ARCH.to_owned());
        format!(
            "cuda-v1:{}:driver{}:runtime{}:cc{}.{}:cpu{}:{}:pinned_pcie",
            self.device_uuid,
            self.driver_version,
            self.runtime_version,
            self.compute_major,
            self.compute_minor,
            cpu_workers,
            cpu
        )
    }
    pub fn json(&self) -> String {
        format!(concat!("{{\"device_name\":{},\"device_uuid\":{},\"placement\":{},",
            "\"driver_version\":{},\"runtime_version\":{},\"compute_major\":{},\"compute_minor\":{},",
            "\"unified_addressing\":{},\"managed_memory\":{},\"concurrent_managed_access\":{},",
            "\"pageable_memory_access\":{},\"hmm_capability_candidate\":{},\"host_page_tables\":{},",
            "\"direct_managed_access\":{},\"async_engine_count\":{},\"coherent_placement_verified\":{}}}"),
            json_string(&self.device_name), json_string(&self.device_uuid), json_string(&self.placement),
            self.driver_version, self.runtime_version, self.compute_major, self.compute_minor,
            self.unified_addressing, self.managed_memory, self.concurrent_managed_access,
            self.pageable_memory_access, self.pageable_memory_access && !self.host_page_tables,
            self.host_page_tables, self.direct_managed_access, self.async_engine_count, self.coherent_placement_verified)
    }
}

fn validate_packed(packed: &PackedAnalysis) -> Result<(), String> {
    if packed.row_offsets.len() < 2
        || packed.functions.is_empty()
        || packed.groups.is_empty()
        || packed.total_cells == 0
        || packed.total_cells > u32::MAX as usize
        || packed.successor_offsets.len() != packed.row_offsets.len()
        || packed.predecessor_offsets.len() != packed.row_offsets.len()
        || packed.uses.len() != packed.total_cells
        || packed.defs.len() != packed.total_cells
        || packed.phi_out.len() != packed.total_cells
        || packed.predecessors.len() != packed.successors.len()
    {
        return Err("Invalid CUDA slice dimensions".into());
    }
    let blocks = packed.block_count();
    let edges = packed.successors.len();
    for offsets in [&packed.successor_offsets, &packed.predecessor_offsets] {
        if offsets[0] != 0
            || offsets[blocks] as usize != edges
            || offsets
                .windows(2)
                .any(|w| w[0] > w[1] || w[1] as usize > edges)
        {
            return Err("Invalid CUDA CSR offsets".into());
        }
    }
    let mut block_base = 0;
    let mut row_base = 0;
    let mut group_index = 0;
    for function in &packed.functions {
        if function.block_count == 0
            || function.words == 0
            || function.block_base != block_base
            || function.row_base != row_base
        {
            return Err("CUDA functions must cover packed blocks and cells exactly once".into());
        }
        let end = block_base
            .checked_add(function.block_count)
            .ok_or("CUDA block dimensions overflow")?;
        if end > blocks {
            return Err("CUDA function exceeds packed blocks".into());
        }
        for word in 0..function.words {
            let Some(group) = packed.groups.get(group_index) else {
                return Err("Missing CUDA function-word group".into());
            };
            if group.block_base as usize != block_base
                || group.row_base as usize != row_base
                || group.block_count as usize != function.block_count
                || group.words as usize != function.words
                || group.word as usize != word
            {
                return Err("Inconsistent CUDA function-word group".into());
            }
            group_index += 1;
        }
        for block in block_base..end {
            if packed.row_offsets[block] != row_base + (block - block_base) * function.words {
                return Err("Invalid CUDA bitset row offsets".into());
            }
            for (&start, &finish, values) in [
                (
                    &packed.successor_offsets[block],
                    &packed.successor_offsets[block + 1],
                    &packed.successors,
                ),
                (
                    &packed.predecessor_offsets[block],
                    &packed.predecessor_offsets[block + 1],
                    &packed.predecessors,
                ),
            ] {
                if values[start as usize..finish as usize]
                    .iter()
                    .any(|&target| (target as usize) < block_base || target as usize >= end)
                {
                    return Err("CUDA CFG edge escapes its function".into());
                }
            }
        }
        block_base = end;
        row_base = row_base
            .checked_add(
                function
                    .block_count
                    .checked_mul(function.words)
                    .ok_or("CUDA cell dimensions overflow")?,
            )
            .ok_or("CUDA cell dimensions overflow")?;
    }
    if block_base != blocks
        || row_base != packed.total_cells
        || packed.row_offsets[blocks] != row_base
        || group_index != packed.groups.len()
    {
        return Err("Incomplete CUDA function-word coverage".into());
    }
    // Both representations describe the same multiset, including repeated edges.
    let mut forward = Vec::with_capacity(edges);
    let mut reverse = Vec::with_capacity(edges);
    for block in 0..blocks {
        for edge in packed.successor_offsets[block]..packed.successor_offsets[block + 1] {
            forward.push((block as u32, packed.successors[edge as usize]));
        }
        for edge in packed.predecessor_offsets[block]..packed.predecessor_offsets[block + 1] {
            reverse.push((packed.predecessors[edge as usize], block as u32));
        }
    }
    forward.sort_unstable();
    reverse.sort_unstable();
    if forward != reverse {
        return Err("CUDA predecessor CSR does not reverse successor CSR".into());
    }
    Ok(())
}

#[cfg(unix)]
mod platform {
    use super::*;
    use std::{
        ffi::{c_char, c_int, c_void, CStr, CString},
        ptr::NonNull,
    };

    #[repr(C)]
    struct Input {
        function_count: u32,
        block_count: u32,
        cell_count: u32,
        group_count: u32,
        max_blocks: u32,
        edge_count: u32,
        groups: *const GPUGroup,
        successor_offsets: *const u32,
        successors: *const u32,
        predecessor_offsets: *const u32,
        predecessors: *const u32,
        uses: *const u32,
        defs: *const u32,
        phi_out: *const u32,
    }

    #[repr(C)]
    struct NativeCapabilities {
        device_name: [c_char; 256],
        device_uuid: [c_char; 64],
        driver_version: i32,
        runtime_version: i32,
        compute_major: i32,
        compute_minor: i32,
        unified_addressing: i32,
        managed_memory: i32,
        concurrent_managed_access: i32,
        pageable_memory_access: i32,
        host_page_tables: i32,
        direct_managed_access: i32,
        async_engine_count: i32,
        coherent_placement_verified: i32,
    }

    #[cfg_attr(target_os = "linux", link(name = "dl"))]
    unsafe extern "C" {
        fn dlopen(path: *const c_char, flags: c_int) -> *mut c_void;
        fn dlsym(library: *mut c_void, name: *const c_char) -> *mut c_void;
        fn dlerror() -> *const c_char;
        fn dlclose(library: *mut c_void) -> c_int;
    }

    type Create = unsafe extern "C" fn(*mut c_char, usize) -> *mut c_void;
    type GetCapabilities =
        unsafe extern "C" fn(*mut c_void, *mut NativeCapabilities, *mut c_char, usize) -> c_int;
    type Submit = unsafe extern "C" fn(*mut c_void, *const Input, u32, *mut c_char, usize) -> c_int;
    type SubmitResident = unsafe extern "C" fn(*mut c_void, u32, *mut c_char, usize) -> c_int;
    type Pending = unsafe extern "C" fn(*mut c_void, *mut u32, *mut c_char, usize) -> c_int;
    type Finish =
        unsafe extern "C" fn(*mut c_void, *mut u32, usize, *mut Stats, *mut c_char, usize) -> c_int;
    type Destroy = unsafe extern "C" fn(*mut c_void);

    fn message(bytes: &[c_char]) -> String {
        let bytes: Vec<_> = bytes
            .iter()
            .take_while(|&&b| b != 0)
            .map(|&b| b as u8)
            .collect();
        String::from_utf8_lossy(&bytes).into_owned()
    }

    fn loader_error() -> String {
        let error = unsafe { dlerror() };
        if error.is_null() {
            "CUDA library loader failed".into()
        } else {
            unsafe { CStr::from_ptr(error) }
                .to_string_lossy()
                .into_owned()
        }
    }

    struct Library(NonNull<c_void>);
    impl Library {
        fn open(path: &Path) -> Result<Self, String> {
            let path = CString::new(path.as_os_str().as_encoded_bytes())
                .map_err(|_| "CUDA library path contains NUL")?;
            // RTLD_NOW resolves every dependency before any CUDA context exists.
            NonNull::new(unsafe { dlopen(path.as_ptr(), 2) })
                .map(Self)
                .ok_or_else(loader_error)
        }
        unsafe fn symbol<T: Copy>(&self, name: &[u8]) -> Result<T, String> {
            assert_eq!(std::mem::size_of::<T>(), std::mem::size_of::<*mut c_void>());
            unsafe { dlerror() };
            let pointer = unsafe { dlsym(self.0.as_ptr(), name.as_ptr().cast()) };
            if pointer.is_null() {
                return Err(loader_error());
            }
            Ok(unsafe { std::mem::transmute_copy(&pointer) })
        }
    }
    impl Drop for Library {
        fn drop(&mut self) {
            unsafe { dlclose(self.0.as_ptr()) };
        }
    }

    pub struct Context {
        pointer: NonNull<c_void>,
        submit_fn: Submit,
        resident_fn: SubmitResident,
        pending_fn: Pending,
        finish_fn: Finish,
        destroy_fn: Destroy,
        capabilities: Capabilities,
        in_flight_cells: Option<usize>,
        resident_cells: Option<usize>,
        validation_ms: f64,
        pub submissions: usize,
        _library: Library,
    }
    impl Context {
        pub fn new_with_placement(path: &Path, placement: PlacementPolicy) -> Result<Self, String> {
            if placement == PlacementPolicy::CoherentUnverified {
                return Err("Coherent CUDA placement is unverified; use pinned staging until measured on coherent hardware".into());
            }
            Self::load(path)
        }
        pub fn new(path: &Path) -> Result<Self, String> {
            Self::new_with_placement(path, PlacementPolicy::PinnedStaging)
        }
        fn load(path: &Path) -> Result<Self, String> {
            let library = Library::open(path)?;
            let version: unsafe extern "C" fn() -> u32 =
                unsafe { library.symbol(b"gpulab_cuda_abi_version\0")? };
            if unsafe { version() } != 1 {
                return Err("CUDA library ABI version must be 1".into());
            }
            let create: Create = unsafe { library.symbol(b"gpulab_cuda_create\0")? };
            let capabilities_fn: GetCapabilities =
                unsafe { library.symbol(b"gpulab_cuda_capabilities\0")? };
            let submit_fn = unsafe { library.symbol(b"gpulab_cuda_submit\0")? };
            let resident_fn = unsafe { library.symbol(b"gpulab_cuda_submit_resident\0")? };
            let pending_fn = unsafe { library.symbol(b"gpulab_cuda_pending\0")? };
            let finish_fn = unsafe { library.symbol(b"gpulab_cuda_finish\0")? };
            let destroy_fn: Destroy = unsafe { library.symbol(b"gpulab_cuda_destroy\0")? };
            let mut error = [0 as c_char; 1024];
            let pointer = NonNull::new(unsafe { create(error.as_mut_ptr(), error.len()) })
                .ok_or_else(|| message(&error))?;
            let mut native: NativeCapabilities = unsafe { std::mem::zeroed() };
            if unsafe {
                capabilities_fn(
                    pointer.as_ptr(),
                    &mut native,
                    error.as_mut_ptr(),
                    error.len(),
                )
            } != 0
            {
                unsafe { destroy_fn(pointer.as_ptr()) };
                return Err(message(&error));
            }
            let capabilities = Capabilities {
                device_name: message(&native.device_name),
                device_uuid: message(&native.device_uuid),
                placement: "pinned_pcie".into(),
                driver_version: native.driver_version,
                runtime_version: native.runtime_version,
                compute_major: native.compute_major,
                compute_minor: native.compute_minor,
                unified_addressing: native.unified_addressing != 0,
                managed_memory: native.managed_memory != 0,
                concurrent_managed_access: native.concurrent_managed_access != 0,
                pageable_memory_access: native.pageable_memory_access != 0,
                host_page_tables: native.host_page_tables != 0,
                direct_managed_access: native.direct_managed_access != 0,
                async_engine_count: native.async_engine_count,
                coherent_placement_verified: native.coherent_placement_verified != 0,
            };
            Ok(Self {
                pointer,
                submit_fn,
                resident_fn,
                pending_fn,
                finish_fn,
                destroy_fn,
                capabilities,
                in_flight_cells: None,
                resident_cells: None,
                validation_ms: 0.0,
                submissions: 0,
                _library: library,
            })
        }

        pub fn capabilities(&self) -> Capabilities {
            self.capabilities.clone()
        }

        pub fn submit(
            &mut self,
            packed: &PackedAnalysis,
            algorithm: Algorithm,
        ) -> Result<(), String> {
            if self.in_flight_cells.is_some() {
                return Err("Native CUDA context already has an in-flight pass".into());
            }
            let validation_start = std::time::Instant::now();
            validate_packed(packed)?;
            let count = |value: usize| {
                u32::try_from(value).map_err(|_| "CUDA input exceeds u32 dimensions".to_string())
            };
            let input = Input {
                function_count: count(packed.functions.len())?,
                block_count: count(packed.block_count())?,
                cell_count: count(packed.total_cells)?,
                group_count: count(packed.groups.len())?,
                max_blocks: count(packed.max_blocks())?,
                edge_count: count(packed.successors.len())?,
                groups: packed.groups.as_ptr(),
                successor_offsets: packed.successor_offsets.as_ptr(),
                successors: packed.successors.as_ptr(),
                predecessor_offsets: packed.predecessor_offsets.as_ptr(),
                predecessors: packed.predecessors.as_ptr(),
                uses: packed.uses.as_ptr(),
                defs: packed.defs.as_ptr(),
                phi_out: packed.phi_out.as_ptr(),
            };
            self.validation_ms = validation_start.elapsed().as_secs_f64() * 1000.0;
            let mut error = [0 as c_char; 1024];
            if unsafe {
                (self.submit_fn)(
                    self.pointer.as_ptr(),
                    &input,
                    algorithm as u32,
                    error.as_mut_ptr(),
                    error.len(),
                )
            } != 0
            {
                self.resident_cells = None;
                return Err(message(&error));
            }
            self.in_flight_cells = Some(packed.total_cells);
            self.resident_cells = Some(packed.total_cells);
            self.submissions += 1;
            Ok(())
        }

        /// Replay only the previous upload. This does not accept changed facts.
        pub fn submit_resident(&mut self, algorithm: Algorithm) -> Result<(), String> {
            if self.in_flight_cells.is_some() {
                return Err("Native CUDA context already has an in-flight pass".into());
            }
            let cells = self.resident_cells.ok_or("No CUDA input is resident")?;
            self.validation_ms = 0.0;
            let mut error = [0 as c_char; 1024];
            if unsafe {
                (self.resident_fn)(
                    self.pointer.as_ptr(),
                    algorithm as u32,
                    error.as_mut_ptr(),
                    error.len(),
                )
            } != 0
            {
                self.resident_cells = None;
                return Err(message(&error));
            }
            self.in_flight_cells = Some(cells);
            self.submissions += 1;
            Ok(())
        }

        /// Poll the completion event. This never waits or consumes a result.
        pub fn is_pending(&mut self) -> Result<bool, String> {
            let mut pending = 0;
            let mut error = [0 as c_char; 1024];
            if unsafe {
                (self.pending_fn)(
                    self.pointer.as_ptr(),
                    &mut pending,
                    error.as_mut_ptr(),
                    error.len(),
                )
            } != 0
            {
                self.in_flight_cells = None;
                self.resident_cells = None;
                return Err(message(&error));
            }
            Ok(pending != 0)
        }

        pub fn finish(&mut self) -> Result<(Vec<u32>, Stats), String> {
            let cells = self
                .in_flight_cells
                .take()
                .ok_or("No in-flight CUDA pass")?;
            let mut output = vec![0; cells];
            let mut stats = Stats::default();
            let mut error = [0 as c_char; 1024];
            if unsafe {
                (self.finish_fn)(
                    self.pointer.as_ptr(),
                    output.as_mut_ptr(),
                    cells,
                    &mut stats,
                    error.as_mut_ptr(),
                    error.len(),
                )
            } != 0
            {
                self.resident_cells = None;
                return Err(message(&error));
            }
            stats.staging_ms += self.validation_ms;
            stats.total_ms += self.validation_ms;
            Ok((output, stats))
        }
    }
    impl Drop for Context {
        fn drop(&mut self) {
            unsafe { (self.destroy_fn)(self.pointer.as_ptr()) };
        }
    }
}

#[cfg(not(unix))]
mod platform {
    use super::*;
    pub struct Context {
        pub submissions: usize,
    }
    impl Context {
        pub fn new(_: &Path) -> Result<Self, String> {
            Err("Native CUDA library loading requires Unix; no GPU fallback was run".into())
        }
        pub fn new_with_placement(path: &Path, placement: PlacementPolicy) -> Result<Self, String> {
            if placement == PlacementPolicy::CoherentUnverified {
                return Err("Coherent CUDA placement is unverified; use pinned staging until measured on coherent hardware".into());
            }
            Self::new(path)
        }
        pub fn capabilities(&self) -> Capabilities {
            Capabilities::default()
        }
        pub fn submit(&mut self, _: &PackedAnalysis, _: Algorithm) -> Result<(), String> {
            Err("CUDA unavailable".into())
        }
        pub fn submit_resident(&mut self, _: Algorithm) -> Result<(), String> {
            Err("CUDA unavailable".into())
        }
        pub fn finish(&mut self) -> Result<(Vec<u32>, Stats), String> {
            Err("CUDA unavailable".into())
        }
        pub fn is_pending(&mut self) -> Result<bool, String> {
            Err("CUDA unavailable".into())
        }
    }
}
pub use platform::Context;

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> PackedAnalysis {
        PackedAnalysis {
            functions: vec![crate::analysis::FunctionDesc {
                module_index: 0,
                block_base: 0,
                block_count: 2,
                row_base: 0,
                words: 1,
                value_count: 1,
            }],
            groups: vec![GPUGroup {
                block_base: 0,
                block_count: 2,
                row_base: 0,
                words: 1,
                word: 0,
            }],
            successor_offsets: vec![0, 1, 1],
            successors: vec![1],
            predecessor_offsets: vec![0, 0, 1],
            predecessors: vec![0],
            row_offsets: vec![0, 1, 2],
            uses: vec![0, 1],
            defs: vec![0, 0],
            phi_out: vec![0, 0],
            total_cells: 2,
        }
    }
    #[test]
    fn malformed_csr_is_rejected_before_native_reads() {
        let mut packed = fixture();
        packed.successor_offsets.pop();
        assert!(validate_packed(&packed).is_err());
    }
    #[test]
    fn a_missing_library_reports_a_loader_error() {
        assert!(Context::new(Path::new("/no/such/gpulab-library.so")).is_err());
    }
    #[test]
    fn coherent_placement_is_rejected_until_hardware_is_verified() {
        let error = Context::new_with_placement(
            Path::new("/no/such/gpulab-library.so"),
            PlacementPolicy::CoherentUnverified,
        )
        .err()
        .expect("unverified placement must fail");
        assert!(
            error.contains("Coherent CUDA placement is unverified"),
            "{error}"
        );
    }
}
