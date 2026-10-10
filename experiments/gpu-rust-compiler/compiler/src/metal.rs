// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use crate::analysis::{GPUGroup, PackedAnalysis};
use std::path::Path;

#[repr(C)]
#[derive(Default, Clone, Copy, Debug)]
pub struct Stats {
    pub gpu_ms: f64,
    pub total_ms: f64,
    pub max_sweeps: u32,
    pub reused_pipeline: u32,
    pub buffer_allocations: u32,
}

#[cfg(target_os = "macos")]
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
        uses: *const u32,
        defs: *const u32,
        phi_out: *const u32,
    }
    #[link(name = "gpulab_metal")]
    unsafe extern "C" {
        fn gpulab_create(shader: *const c_char, error: *mut c_char, capacity: usize)
            -> *mut c_void;
        fn gpulab_submit(
            context: *mut c_void,
            input: *const Input,
            error: *mut c_char,
            capacity: usize,
        ) -> c_int;
        fn gpulab_finish(
            context: *mut c_void,
            output: *mut u32,
            count: usize,
            stats: *mut Stats,
            error: *mut c_char,
            capacity: usize,
        ) -> c_int;
        fn gpulab_destroy(context: *mut c_void);
    }

    fn error_message(error: &[c_char]) -> String {
        // The native bridge always NUL terminates a nonempty error buffer.
        unsafe { CStr::from_ptr(error.as_ptr()) }
            .to_string_lossy()
            .into_owned()
    }

    pub struct Context {
        pointer: NonNull<c_void>,
        in_flight_cells: Option<usize>,
        pub submissions: usize,
    }
    impl Context {
        pub fn new(shader: &Path) -> Result<Self, String> {
            let shader = CString::new(shader.as_os_str().as_encoded_bytes())
                .map_err(|_| "Shader path contains NUL")?;
            let mut error = [0 as c_char; 1024];
            let pointer =
                unsafe { gpulab_create(shader.as_ptr(), error.as_mut_ptr(), error.len()) };
            Ok(Self {
                pointer: NonNull::new(pointer).ok_or_else(|| error_message(&error))?,
                in_flight_cells: None,
                submissions: 0,
            })
        }
        pub fn submit(&mut self, packed: &PackedAnalysis) -> Result<(), String> {
            if self.in_flight_cells.is_some() {
                return Err("Native GPU context already has an in-flight pass".into());
            }
            // Public packed fields must not expose short slices to native reads.
            if packed.row_offsets.len() < 2
                || packed.groups.is_empty()
                || packed.functions.is_empty()
                || packed.total_cells == 0
                || packed.successor_offsets.len() != packed.row_offsets.len()
                || packed.uses.len() != packed.total_cells
                || packed.defs.len() != packed.total_cells
                || packed.phi_out.len() != packed.total_cells
            {
                return Err("Invalid native GPU slice dimensions".into());
            }
            let count = |value: usize| {
                u32::try_from(value).map_err(|_| "GPU input exceeds u32 dimensions".to_string())
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
                uses: packed.uses.as_ptr(),
                defs: packed.defs.as_ptr(),
                phi_out: packed.phi_out.as_ptr(),
            };
            let mut error = [0 as c_char; 1024];
            if unsafe {
                gpulab_submit(
                    self.pointer.as_ptr(),
                    &input,
                    error.as_mut_ptr(),
                    error.len(),
                )
            } != 0
            {
                return Err(error_message(&error));
            }
            self.in_flight_cells = Some(packed.total_cells);
            self.submissions += 1;
            Ok(())
        }
        pub fn finish(&mut self) -> Result<(Vec<u32>, Stats), String> {
            let cells = self.in_flight_cells.take().ok_or("No in-flight GPU pass")?;
            let mut result = vec![0; cells];
            let mut stats = Stats::default();
            let mut error = [0 as c_char; 1024];
            if unsafe {
                gpulab_finish(
                    self.pointer.as_ptr(),
                    result.as_mut_ptr(),
                    result.len(),
                    &mut stats,
                    error.as_mut_ptr(),
                    error.len(),
                )
            } != 0
            {
                return Err(error_message(&error));
            }
            Ok((result, stats))
        }
    }
    impl Drop for Context {
        fn drop(&mut self) {
            unsafe { gpulab_destroy(self.pointer.as_ptr()) };
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod platform {
    use super::*;
    pub struct Context {
        pub submissions: usize,
    }
    impl Context {
        pub fn new(_: &Path) -> Result<Self, String> {
            Err("Native Metal requires macOS; no GPU fallback was run".into())
        }
        pub fn submit(&mut self, _: &PackedAnalysis) -> Result<(), String> {
            Err("Metal unavailable".into())
        }
        pub fn finish(&mut self) -> Result<(Vec<u32>, Stats), String> {
            Err("Metal unavailable".into())
        }
    }
}
pub use platform::Context;
