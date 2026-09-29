// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use crate::ObservationError;

pub trait Secrets: Send + Sync {
    fn resolve(&self, reference: &str) -> Result<String, ObservationError>;
}
pub struct EnvironmentSecrets;
impl Secrets for EnvironmentSecrets {
    fn resolve(&self, reference: &str) -> Result<String, ObservationError> {
        std::env::var(reference)
            .ok()
            .filter(|v| !v.is_empty())
            .ok_or(ObservationError::Authentication)
    }
}
