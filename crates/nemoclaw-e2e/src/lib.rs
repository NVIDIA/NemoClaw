// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Deterministic protocol fixtures shared by SDK and bundle lifecycle tests.
pub mod openshell;

#[cfg(unix)]
pub mod docker;
