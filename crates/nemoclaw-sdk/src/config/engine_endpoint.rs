// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use super::ConfigError;

/// Validate an engine address without opening a platform-specific transport.
pub fn validate_engine_endpoint(endpoint: &str) -> Result<(), ConfigError> {
    if endpoint.starts_with("ssh://") {
        return validate_ssh(endpoint);
    }
    if !endpoint.starts_with("unix:///") || endpoint.contains(['\0', '?', '#']) {
        return Err(ConfigError::new(
            "managed runtimes require an explicit Unix socket or SSH engine endpoint",
        ));
    }
    Ok(())
}

fn validate_ssh(endpoint: &str) -> Result<(), ConfigError> {
    let invalid = || {
        ConfigError::new(
            "SSH engine requires ssh://[user@]host[:port] without passwords, paths or options",
        )
    };
    let url = url::Url::parse(endpoint).map_err(|_| invalid())?;
    let safe_name = |name: &str| {
        !name.starts_with('-')
            && name
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"._-".contains(&c))
    };
    if endpoint
        .bytes()
        .any(|c| c.is_ascii_whitespace() || c.is_ascii_control() || c == b'%')
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || !url.path().is_empty()
        || !safe_name(url.username())
        || url
            .host_str()
            .is_none_or(|host| !safe_name(host) || host.is_empty())
        || url.port() == Some(0)
    {
        return Err(invalid());
    }
    Ok(())
}
