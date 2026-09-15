// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Inline recipe contracts and shared model preparation.
pub mod huggingface;
pub mod inline;
pub mod preparation;
pub(crate) fn validate(service: &crate::config::Service) -> Result<(), crate::config::ConfigError> {
    huggingface::validate(service)
}
