// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
mod podman;
pub use nemoclaw_docker::{ensure_storage, observe_storage};
pub use nemoclaw_sdk::managed::*;
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
    let definition = |kind, fields: &[&'static str], mutable: &[&'static str]| {
        let fields: Vec<_> = GATEWAY_ATTRIBUTES.iter().chain(fields).copied().collect();
        // Omitting image_pull_policy selects the runtime's default policy, not
        // the previous selection.
        Definition::new(kind, &fields, mutable)
            .optional(&["image_pull_policy"])
            .reset_when_omitted(&["image_pull_policy"])
            .validate_attribute(|attribute, value| {
                check_gateway_attribute(attribute, value).map_err(Into::into)
            })
            .generated("owner", nemoclaw_backend::generate_owner)
            .generated("generation", nemoclaw_backend::generate_generation)
    };
    [
        definition(
            GATEWAY_KIND,
            &["running", "image_pull_policy"],
            &["running", "image_pull_policy"],
        )
        .computed("running", rerun_when_stopped),
        // Docker gateway data does not depend on the listen endpoint.
        definition(
            GATEWAY_STORAGE_KIND,
            &["image_pull_policy"],
            &["image_pull_policy"],
        )
        .optional(&["endpoint"])
        .reset_when_omitted(&["endpoint"])
        .computed("data_path", carry_prior),
    ]
}
