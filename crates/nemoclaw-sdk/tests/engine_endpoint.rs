// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use nemoclaw_sdk::config::validate_engine_endpoint;

#[test]
fn engine_configuration_validates_without_opening_a_transport_and_redacts_rejected_values() {
    for endpoint in [
        "unix:///not/a/real/socket",
        "ssh://user@host:2222",
        "ssh://host",
    ] {
        validate_engine_endpoint(endpoint).unwrap();
    }
    for endpoint in [
        "tcp://host:2375",
        "unix://relative",
        "unix:///socket?option=secret",
        "ssh://user:secret@host",
        "ssh://-oProxyCommand@host",
        "ssh://host/path",
        "ssh://host?option=secret",
        "ssh://host#secret",
        "ssh://host:0",
        "ssh://user%40other@host",
        "ssh://host\nsecret",
    ] {
        let error = validate_engine_endpoint(endpoint).unwrap_err();
        assert!(!error.to_string().contains("secret"));
        assert!(!error.to_string().contains(endpoint));
    }
}
