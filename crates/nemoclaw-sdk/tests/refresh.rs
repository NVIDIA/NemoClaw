// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use nemoclaw_sdk::{Binding, Bound, Observation, ObservationError, refresh};

fn prior() -> Bound<String> {
    Bound {
        binding: Binding::new("deployment", "generation", "durable-id").unwrap(),
        configuration: "model-before".into(),
    }
}

#[test]
fn refresh_preserves_identity_and_reports_observed_configuration_drift() {
    let prior = prior();
    let observed = Bound {
        configuration: "model-after".into(),
        ..prior.clone()
    };
    assert_eq!(
        refresh(&prior, Ok(Observation::Present(observed.clone()))),
        Ok(Some(observed))
    );
    assert_eq!(prior.configuration, "model-before");
}

#[test]
fn unchanged_refresh_keeps_the_complete_binding() {
    let prior = prior();
    assert_eq!(
        refresh(&prior, Ok(Observation::Present(prior.clone()))),
        Ok(Some(prior))
    );
}

#[test]
fn only_confirmed_absence_can_retire_a_binding() {
    assert_eq!(refresh(&prior(), Ok(Observation::Absent)), Ok(None));
}

#[test]
fn observation_failures_stop_refresh_without_consuming_prior_state() {
    for error in [
        ObservationError::Authentication,
        ObservationError::Permission,
        ObservationError::Transport,
        ObservationError::Query,
        ObservationError::Extension,
        ObservationError::Incomplete,
    ] {
        let prior = prior();
        let saved = prior.clone();
        assert_eq!(refresh(&prior, Err(error)), Err(error));
        assert_eq!(prior, saved);
    }
}

#[test]
fn ownership_generation_and_durable_identity_changes_are_not_configuration_drift() {
    let prior = prior();
    for binding in [
        Binding::new("foreign", "generation", "durable-id").unwrap(),
        Binding::new("deployment", "foreign", "durable-id").unwrap(),
        Binding::new("deployment", "generation", "replacement").unwrap(),
    ] {
        let observed = Bound {
            binding,
            configuration: prior.configuration.clone(),
        };
        assert_eq!(
            refresh(&prior, Ok(Observation::Present(observed))),
            Err(ObservationError::BindingMismatch)
        );
    }
}

#[test]
fn incomplete_binding_cannot_enter_state() {
    for parts in [
        ("", "generation", "id"),
        ("owner", "", "id"),
        ("owner", "generation", ""),
    ] {
        assert_eq!(
            Binding::new(parts.0, parts.1, parts.2),
            Err(ObservationError::Incomplete)
        );
    }
}
