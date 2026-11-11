// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Live end-to-end tests, linked into one binary: they use real Docker
//! engines, Kubernetes clusters, images, or inference, and stay ignored unless
//! selected. The offline checks of their helpers run with the unit tests.
//!
//! `hcl_live` runs the HCL E2E scenarios in `hcl/`, each a successful path
//! through one document in the crate's `cases/`.

#[path = "hcl_live.rs"]
mod hcl_live;
#[path = "hosted_parity.rs"]
mod hosted_parity;
