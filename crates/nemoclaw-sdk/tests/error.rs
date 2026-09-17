// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use nemoclaw_sdk::{Error, ObservationError, config::ConfigError};
use std::error::Error as _;

#[test]
fn wrapped_sdk_errors_preserve_their_typed_sources_and_messages() {
    let configuration = Error::from(ConfigError::new("invalid configuration"));
    assert_eq!(configuration.to_string(), "invalid configuration");
    assert!(configuration.source().unwrap().is::<ConfigError>());
    let observation = Error::from(ObservationError::Incomplete);
    assert_eq!(
        observation.to_string(),
        ObservationError::Incomplete.to_string()
    );
    assert!(observation.source().unwrap().is::<ObservationError>());
    assert!(Error::State("invalid state").source().is_none());
}
