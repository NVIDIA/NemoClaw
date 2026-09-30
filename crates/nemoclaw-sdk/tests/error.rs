// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use nemoclaw_sdk::{Error, ObservationError, config::ConfigError};
use std::error::Error as _;

#[test]
fn wrapped_sdk_errors_preserve_their_typed_sources_and_messages() {
    let diagnostic = nemoclaw_runtime::config::ConfigError::new("invalid configuration");
    for configuration in [
        Error::from(diagnostic.clone()),
        Error::from(nemoclaw_runtime::Error::Configuration(diagnostic)),
    ] {
        assert_eq!(configuration.to_string(), "invalid configuration");
        let source = configuration.source().unwrap();
        assert!(source.is::<ConfigError>());
        assert!(source.is::<nemoclaw_runtime::config::ConfigError>());
    }
    let observation = Error::from(ObservationError::Incomplete);
    assert_eq!(
        observation.to_string(),
        ObservationError::Incomplete.to_string()
    );
    assert!(observation.source().unwrap().is::<ObservationError>());
    assert!(Error::State("invalid state").source().is_none());
}
