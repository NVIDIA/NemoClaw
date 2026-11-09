// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! The Service that publishes a managed Kubernetes gateway's endpoint; the
//! bundled Kubernetes provider owns it.

use crate::artifact_pins as pins;

pub const PROVIDER_ADDRESS: &str = "registry.opentofu.org/hashicorp/kubernetes";
pub use pins::KUBERNETES_PROVIDER_VERSION as PROVIDER_VERSION;
