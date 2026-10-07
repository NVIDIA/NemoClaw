// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Runtime integration tests, linked into one binary.
//! Each file is a module; shared helpers are declared once here.

#[path = "contract.rs"]
mod contract;
#[path = "dependencies.rs"]
mod dependencies;
#[path = "entrypoint.rs"]
mod entrypoint;
#[path = "ollama_cache.rs"]
mod ollama_cache;
