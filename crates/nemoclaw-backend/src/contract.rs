// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use crate::ObservationError;
use async_trait::async_trait;
use std::collections::BTreeMap;

/// Non-secret attributes at the owning backend boundary.
pub type Row = BTreeMap<String, String>;

/// A mutation can establish identity before a later step fails. Retain that
/// state together with the diagnostic; never hide an established binding.
/// Construct outcomes through `complete`, `failed`, `partial`, or `stopped` so
/// an outcome cannot lack both state and a diagnostic.
///
/// ```compile_fail
/// use nemoclaw_backend::Mutation;
/// let empty = Mutation { state: None, error: None };
/// ```
pub struct Mutation {
    state: Option<Row>,
    error: Option<ObservationError>,
    warning: Option<ObservationError>,
}

impl Mutation {
    pub fn partial(state: Row, error: ObservationError) -> Self {
        Self {
            state: Some(state),
            error: Some(error),
            warning: None,
        }
    }
    /// Complete state for a resource that is not running, with the reason as a
    /// warning. OpenTofu taints a created resource whose apply reports an
    /// error; a warning keeps it updatable, so a resource whose `running`
    /// postcondition fails can resume on the next apply.
    pub fn stopped(state: Row, reason: ObservationError) -> Self {
        Self {
            state: Some(state),
            error: None,
            warning: Some(reason),
        }
    }
    pub fn warning(&self) -> Option<ObservationError> {
        self.warning.clone()
    }
    pub fn state(&self) -> Option<&Row> {
        self.state.as_ref()
    }
    pub fn error(&self) -> Option<ObservationError> {
        self.error.clone()
    }
    pub fn into_parts(self) -> (Option<Row>, Option<ObservationError>) {
        (self.state, self.error)
    }
    pub fn complete(state: Row) -> Self {
        Self {
            state: Some(state),
            error: None,
            warning: None,
        }
    }
    pub fn failed(error: ObservationError) -> Self {
        Self {
            state: None,
            error: Some(error),
            warning: None,
        }
    }
}

/// Shared by provider refresh, export, and direct mutation reconciliation.
/// Only authoritative absence may return `Ok(None)` from read.
#[async_trait]
pub trait Backend: Send + Sync {
    /// Check a proposed configuration against current observations without
    /// changing resources. Prior bindings are separate from desired intent.
    async fn plan(
        &self,
        _kind: &str,
        _desired: &Row,
        _prior: Option<&Row>,
    ) -> Result<(), crate::Error> {
        Ok(())
    }

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
