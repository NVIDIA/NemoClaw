// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum MemoryArchitecture {
    Unified,
    Dedicated,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "kebab-case")]
/// GPU-family contracts, not model or whole-system qualifications. System profiles fix ARM64; GPU profiles require architecture. Each currently requires one visible GPU.
pub enum HardwareProfile {
    DgxSpark,
    DgxStation,
    Gb200,
    Gb300,
    Gh200,
    H100,
    H200,
    A100,
    A10,
    A10g,
    A40,
    L4,
    L40,
    L40s,
    T4,
    #[serde(rename = "rtx-6000-ada")]
    Rtx6000Ada,
    #[serde(rename = "rtx-pro-6000-blackwell")]
    RtxPro6000Blackwell,
    #[serde(rename = "rtx-3090")]
    Rtx3090,
    #[serde(rename = "rtx-4090")]
    Rtx4090,
    #[serde(rename = "rtx-5090")]
    Rtx5090,
}

impl HardwareProfile {
    pub(crate) const UNIFIED_MEMORY: [Self; 1] = [Self::DgxSpark];

    pub(crate) fn memory_architecture(self) -> MemoryArchitecture {
        if Self::UNIFIED_MEMORY.contains(&self) {
            MemoryArchitecture::Unified
        } else {
            MemoryArchitecture::Dedicated
        }
    }

    pub(crate) fn min_host_memory_bytes(self) -> u64 {
        match self {
            Self::DgxSpark => 118 * (1 << 30),
            _ => 0,
        }
    }

    pub(crate) const ARM64_SYSTEMS: [Self; 5] = [
        Self::DgxSpark,
        Self::DgxStation,
        Self::Gb200,
        Self::Gb300,
        Self::Gh200,
    ];

    pub(crate) fn architecture(self) -> Option<&'static str> {
        Self::ARM64_SYSTEMS.contains(&self).then_some("arm64")
    }

    // NVIDIA's CUDA GPU table, checked 2026-09-18: https://developer.nvidia.com/cuda/gpus
    pub(crate) fn compute_capability(self) -> u32 {
        match self {
            Self::DgxSpark => 121,
            Self::DgxStation | Self::Gb300 => 103,
            Self::Gb200 => 100,
            Self::Gh200 | Self::H100 | Self::H200 => 90,
            Self::A100 => 80,
            Self::A10 | Self::A10g | Self::A40 | Self::Rtx3090 => 86,
            Self::L4 | Self::L40 | Self::L40s | Self::Rtx6000Ada | Self::Rtx4090 => 89,
            Self::T4 => 75,
            Self::RtxPro6000Blackwell | Self::Rtx5090 => 120,
        }
    }

    pub(crate) fn matches_gpu(self, observed: &str) -> bool {
        let family = match self {
            Self::DgxSpark => return observed == "NVIDIA GB10",
            Self::DgxStation | Self::Gb300 => "GB300",
            Self::Gb200 => "GB200",
            Self::Gh200 => "GH200",
            Self::H100 => "H100",
            Self::H200 => "H200",
            Self::A100 => "A100",
            Self::A10 => "A10",
            Self::A10g => "A10G",
            Self::A40 => "A40",
            Self::L4 => "L4",
            Self::L40 => "L40",
            Self::L40s => "L40S",
            Self::T4 => "T4",
            Self::Rtx6000Ada => "RTX 6000 Ada",
            Self::RtxPro6000Blackwell => "RTX PRO 6000 Blackwell",
            Self::Rtx3090 => "GeForce RTX 3090",
            Self::Rtx4090 => "GeForce RTX 4090",
            Self::Rtx5090 => "GeForce RTX 5090",
        };
        let name = observed
            .strip_prefix("NVIDIA ")
            .or_else(|| observed.strip_prefix("Tesla "))
            .unwrap_or(observed);
        name.strip_prefix(family)
            .is_some_and(|suffix| suffix.is_empty() || suffix.starts_with([' ', '-']))
    }
}
