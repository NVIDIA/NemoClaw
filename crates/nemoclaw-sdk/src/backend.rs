// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use crate::ObservationError;
use async_trait::async_trait;
use std::collections::BTreeMap;

/// Non-secret attributes at the owning backend boundary.
pub type Row = BTreeMap<String, String>;

/// A mutation can establish identity before a later step fails. Retain that
/// state together with the diagnostic; never hide an established binding.
pub struct Mutation {
    pub state: Option<Row>,
    pub error: Option<ObservationError>,
}

impl Mutation {
    pub fn complete(state: Row) -> Self {
        Self {
            state: Some(state),
            error: None,
        }
    }
    pub fn failed(error: ObservationError) -> Self {
        Self {
            state: None,
            error: Some(error),
        }
    }
}

/// Shared by provider refresh, export, and direct mutation reconciliation.
/// Only authoritative absence may return `Ok(None)` from read.
#[async_trait]
pub trait Backend: Send + Sync {
    async fn read(
        &self,
        kind: &str,
        prior: &Row,
        removing: bool,
    ) -> Result<Option<Row>, ObservationError>;
    async fn ensure(&self, kind: &str, desired: &Row) -> Mutation;
    async fn remove(
        &self,
        kind: &str,
        prior: &Row,
        destroying: bool,
    ) -> Result<(), ObservationError>;
}
