// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Commands that must fail, which `tofu test` cannot expect: failed host and
//! readiness checks, rejected settings, foreign or lost storage, and capacity
//! that would overcommit a host.

mod discovery;
mod host;
mod service_capacity;
mod service_readiness;
mod service_storage;
