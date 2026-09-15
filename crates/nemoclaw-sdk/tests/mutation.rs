// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use nemoclaw_sdk::{
    ObservationError,
    backend::{Mutation, Row},
};

#[test]
fn mutation_constructors_preserve_success_failure_and_partial_bindings() {
    let row = Row::from([("id".into(), "owned-resource".into())]);
    let complete = Mutation::complete(row.clone());
    assert_eq!(complete.state(), Some(&row));
    assert_eq!(complete.error(), None);
    assert_eq!(complete.into_parts(), (Some(row.clone()), None));
    let failed = Mutation::failed(ObservationError::Transport);
    assert_eq!(failed.state(), None);
    assert_eq!(
        failed.into_parts(),
        (None, Some(ObservationError::Transport))
    );
    let partial = Mutation::partial(row.clone(), ObservationError::Incomplete);
    assert_eq!(partial.state(), Some(&row));
    assert_eq!(partial.error(), Some(ObservationError::Incomplete));
    assert_eq!(
        partial.into_parts(),
        (Some(row), Some(ObservationError::Incomplete))
    );
}
