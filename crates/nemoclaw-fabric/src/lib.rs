// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Fabric's image contract: what an image's Fabric catalog label promises,
//! whether that satisfies a sandbox's requirements, and how the label is read.

pub mod capabilities;
pub mod catalog;
pub mod image_metadata;
#[cfg(feature = "client")]
mod observe;

pub use capabilities::{FabricObservation, FabricRequirements};
#[cfg(feature = "client")]
pub use observe::{judge_image, observe_fabric};
