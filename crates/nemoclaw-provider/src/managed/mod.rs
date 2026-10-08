// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
mod podman;
pub use nemoclaw_sdk::managed::*;
mod storage;
pub use storage::{ensure_storage, observe_storage};
mod observation;
pub use observation::*;
mod backend;
pub(crate) use backend::service_engine;
mod gateway_storage;
mod keys;
mod mutation;
#[cfg(all(test, unix))]
mod planning_tests;
pub use backend::{ManagedBackend, connection_endpoint, runtime_engine};

/// Managed gateway resources and their planning rules.
pub(crate) fn definitions() -> [crate::Definition; 2] {
    use crate::{Definition, carry_prior, rerun_when_stopped};
    let validate = nemoclaw_sdk::services::validate_resource_spec;
    // Omitting image_pull_policy selects the runtime's default policy, not
    // the previous selection.
    [
        Definition::new(
            GATEWAY_KIND,
            &["spec", "running", "image_pull_policy"],
            &["running", "image_pull_policy"],
        )
        .optional(&["image_pull_policy"])
        .reset_when_omitted(&["image_pull_policy"])
        .validate_spec(validate)
        .computed("running", rerun_when_stopped),
        Definition::new(
            GATEWAY_STORAGE_KIND,
            &["spec", "image_pull_policy"],
            &["image_pull_policy"],
        )
        .optional(&["image_pull_policy"])
        .reset_when_omitted(&["image_pull_policy"])
        .validate_spec(validate)
        .computed("data_path", carry_prior),
    ]
}
