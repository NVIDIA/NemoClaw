// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Commands that must fail, which `tofu test` cannot expect: rejected
//! settings, foreign or lost objects, and saved plans rechecked on apply.

mod api;
mod capabilities;
mod gateway_installation;
mod gateway_readiness;
mod gateway_storage;
mod standalone;
