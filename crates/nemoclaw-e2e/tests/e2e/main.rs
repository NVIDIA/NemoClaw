// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Live end-to-end tests, linked into one binary: they use real Docker
//! engines, Kubernetes clusters, images, or inference, and stay ignored unless
//! selected. The offline checks of their helpers run with the unit tests.
//!
//! `hcl_live` runs the HCL E2E scenarios in `hcl/`, each a successful path
//! through one document in the crate's `cases/`. The modules under `rust/`
//! are live tests not yet migrated to those scenarios. Module names do not
//! include the directory, so test names and profile filters stay stable.

#[path = "hcl_live.rs"]
mod hcl_live;
#[path = "hosted_parity.rs"]
mod hosted_parity;

#[path = "rust/interfaces_live.rs"]
mod interfaces_live;
#[path = "rust/kubernetes_chart.rs"]
mod kubernetes_chart;
#[path = "rust/kubernetes_live.rs"]
mod kubernetes_live;
#[cfg(unix)]
#[path = "rust/managed_gateway.rs"]
mod managed_gateway;
#[path = "rust/pseudo_terminal.rs"]
mod pseudo_terminal;
