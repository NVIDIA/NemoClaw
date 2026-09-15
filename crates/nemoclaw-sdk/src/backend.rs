// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use crate::ObservationError;
use async_trait::async_trait;
use std::collections::BTreeMap;

/// Non-secret attributes at the owning backend boundary.
pub type Row = BTreeMap<String, String>;

/// A mutation can establish identity before a later step fails. Retain that
/// state together with the diagnostic; never hide an established binding.
/// Construct outcomes through `complete`, `failed`, or `partial` so an outcome
/// cannot lack both state and a diagnostic.
///
/// ```compile_fail
/// use nemoclaw_sdk::backend::Mutation;
/// let empty = Mutation { state: None, error: None };
/// ```
pub struct Mutation {
    state: Option<Row>,
    error: Option<ObservationError>,
}

impl Mutation {
    pub fn partial(state: Row, error: ObservationError) -> Self {
        Self {
            state: Some(state),
            error: Some(error),
        }
    }
    pub fn state(&self) -> Option<&Row> {
        self.state.as_ref()
    }
    pub fn error(&self) -> Option<ObservationError> {
        self.error
    }
    pub fn into_parts(self) -> (Option<Row>, Option<ObservationError>) {
        (self.state, self.error)
    }
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
