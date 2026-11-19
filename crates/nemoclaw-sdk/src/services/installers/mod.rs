// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Package-specific service installers.

pub mod container;
mod inference;
pub mod llama_cpp;
pub mod nim;
pub mod ollama;
pub mod vllm;

#[cfg(test)]
mod tests;
