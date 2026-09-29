// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Recipe limits shared by validation and schema generation.
pub const API_VERSION: &str = "nemoclaw.nvidia.com/recipe/v1";
pub const ARCHITECTURES: &[&str] = &["arm64", "amd64"];
pub const PROTOCOL_LABEL: &str = "org.nemoclaw.recipe.protocol";
pub const DRIVER_MAX: u64 = 10000;
pub const MEMORY_MAX: u64 = 4096;
pub const PREPARED_MAX: u64 = 1 << 40;
pub const GPU_MIN: u64 = 4 * crate::hardware::GIB;
pub const GPU_MAX: u64 = 1 << 42;
pub const PATH_MAX: usize = 4096;
pub const TOKEN_MAX: usize = 256;
pub const TOKEN: &str = r"^[a-zA-Z0-9._/][a-zA-Z0-9._/-]*$";
pub const SHA256: &str = r"^[a-f0-9]{64}$";
pub const COMPILATION_MODE_MAX: u8 = 3;
pub const CUDAGRAPH_MODES: &[&str] = &["NONE", "FULL_DECODE_ONLY"];
pub const CAPTURE_COUNT_MAX: usize = 64;
pub const CAPTURE_SIZE_MAX: u32 = 65536;
