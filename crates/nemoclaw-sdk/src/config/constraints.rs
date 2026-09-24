// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
// Spark memory defaults were informed by MiaAI Lab's start.sh and memwatch.sh.
// Upstream AGPL-3.0-or-later recipe and revision: crates/nemoclaw-sdk/NOTICE.md.
//! Values shared by normalization, validation, and the authored-input schema.

pub(crate) const KIND: &str = "NemoClawConfig";
pub(crate) const SLUG: &str = r"^[a-z][a-z0-9-]{0,39}$";
pub(crate) const UUID: &str = r"^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$";
pub(crate) const ENV: &str = r"^[A-Z_][A-Z0-9_]{0,127}$";
pub(crate) const MODEL: &str = r"^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$";
pub(crate) const IMAGE: &str = r"^[a-zA-Z0-9][a-zA-Z0-9._:/-]*@sha256:[a-f0-9]{64}$";
pub(crate) const LOCAL_IMAGE_ID: &str = r"^sha256:[a-f0-9]{64}$";
pub(crate) const SERVICE_IMAGE: &str =
    r"^(?:[a-zA-Z0-9][a-zA-Z0-9._:/-]*@sha256:[a-f0-9]{64}|sha256:[a-f0-9]{64})$";
pub(crate) const GATEWAY_ENDPOINT: &str = "http://127.0.0.1:17681";
pub(crate) const GATEWAY_ENGINE: &str = "unix:///var/run/docker.sock";
pub(crate) const RUNTIME: &str = super::ComputeDriver::Docker.as_str();
pub(crate) const NETWORK_TIER: &str = "isolated";

/// Zero in authored YAML selects the default; validation uses normalized values.
pub(crate) struct DefaultedInteger {
    pub default: i64,
    pub min: i64,
    pub max: i64,
}
