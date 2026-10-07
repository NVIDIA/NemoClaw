// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use nemoclaw_sdk::{Error, ObservationError, config::ConfigError};
use std::error::Error as _;

#[test]
fn workload_details_redact_short_bearer_and_quoted_credentials() {
    for detail in [
        "Authorization: Bearer short-secret",
        r#"{"api_key":"short-secret"}"#,
        r#"{"Authorization": "Bearer short-secret"}"#,
        "token='short-secret'",
    ] {
        let safe = ObservationError::sanitized_detail(detail);
        assert!(!safe.contains("short-secret"), "{safe}");
    }
}

#[test]
fn workload_details_are_single_line_bounded_and_redact_token_like_runs() {
    let token = "0123456789abcdef".repeat(4);
    let detail = format!(
        "stopped: model digest mismatch\n\u{1b}[31m Bearer short-secret token=small {token} {}",
        "diagnostic ".repeat(200)
    );
    let safe = ObservationError::sanitized_detail(&detail);
    assert!(safe.len() <= 1024);
    assert!(safe.bytes().all(|byte| (b' '..=b'~').contains(&byte)));
    assert!(safe.contains("model digest mismatch"));
    for secret in [token.as_str(), "short-secret", "small"] {
        assert!(!safe.contains(secret));
    }
}

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
