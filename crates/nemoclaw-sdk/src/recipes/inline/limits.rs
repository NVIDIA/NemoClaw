// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Recipe limits shared by validation and schema generation.
pub(crate) const API_VERSION: &str = "nemoclaw.nvidia.com/recipe/v1";
pub(crate) const ARCHITECTURES: &[&str] = &["arm64", "amd64"];
pub(crate) const PROTOCOL_LABEL: &str = "org.nemoclaw.recipe.protocol";
pub(crate) const DRIVER_MAX: u64 = 10000;
pub(crate) const MEMORY_MAX: u64 = 4096;
pub(crate) const PREPARED_MAX: u64 = 1 << 40;
pub(crate) const GPU_MIN: u64 = 4 * crate::hardware::GIB;
pub(crate) const GPU_MAX: u64 = 1 << 42;
pub(crate) const PATH_MAX: usize = 4096;
pub(crate) const TOKEN_MAX: usize = 256;
pub(crate) const TOKEN: &str = r"^[a-zA-Z0-9._/][a-zA-Z0-9._/-]*$";
pub(crate) const SHA256: &str = r"^[a-f0-9]{64}$";
pub(crate) const COMPILATION_MODE_MAX: u8 = 3;
pub(crate) const CUDAGRAPH_MODES: &[&str] = &["NONE", "FULL_DECODE_ONLY"];
pub(crate) const CAPTURE_COUNT_MAX: usize = 64;
pub(crate) const CAPTURE_SIZE_MAX: u32 = 65536;
