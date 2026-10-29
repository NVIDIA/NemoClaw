// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! The endpoint policy every backend applies before it connects.

use nemoclaw_runtime::config::ConfigError;
use std::net::IpAddr;
use url::Url;

fn require(valid: bool, reason: &'static str) -> Result<(), ConfigError> {
    if valid {
        Ok(())
    } else {
        Err(ConfigError::new(reason))
    }
}
fn private(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => ip.is_private(),
        IpAddr::V6(ip) => ip.is_unique_local(),
    }
}
fn host_ip(url: &Url) -> Option<IpAddr> {
    url.host_str()?.trim_matches(['[', ']']).parse().ok()
}

/// Accept a well-formed HTTP or HTTPS endpoint: a host, no credentials, query,
/// or fragment, and no characters OpenTofu would interpolate. Destinations
/// are not checked: for endpoints handed to OpenShell, OpenShell decides
/// which a sandbox may reach when it connects.
pub fn validate_endpoint_url(raw: &str) -> Result<(), ConfigError> {
    require(
        !raw.contains(['\r', '\n', '\t', '$', '%', '{', '}', '\\']),
        "endpoint contains unsupported characters",
    )?;
    let url =
        Url::parse(raw).map_err(|_| ConfigError::new("expected an HTTP or HTTPS endpoint"))?;
    require(
        url.has_host()
            && url.username().is_empty()
            && url.password().is_none()
            && url.query().is_none()
            && url.fragment().is_none(),
        "endpoint must not include credentials, query, or fragment",
    )?;
    require(
        matches!(url.scheme(), "https" | "http"),
        "expected an HTTP or HTTPS endpoint",
    )
}

/// Accept an endpoint NemoClaw connects to itself: a well-formed HTTPS
/// endpoint, or local HTTP on a literal loopback or private inference address.
/// A gateway endpoint is an origin without a path.
pub fn validate_endpoint(raw: &str, gateway: bool) -> Result<(), ConfigError> {
    validate_endpoint_url(raw)?;
    let url =
        Url::parse(raw).map_err(|_| ConfigError::new("expected an HTTP or HTTPS endpoint"))?;
    require(
        !gateway || url.path() == "/" || url.path().is_empty(),
        "gateway endpoint must not include a path",
    )?;
    let ip = host_ip(&url);
    if let Some(ip) = ip {
        // An IPv4-mapped address would need every IPv4 rule checked twice.
        let link_local_or_mapped = match ip {
            IpAddr::V4(ip) => ip.is_link_local(),
            IpAddr::V6(ip) => ip.is_unicast_link_local() || ip.to_ipv4_mapped().is_some(),
        };
        require(
            !ip.is_unspecified() && !ip.is_multicast() && !link_local_or_mapped,
            "unspecified, multicast, link-local, and IPv4-mapped endpoints are forbidden",
        )?;
    }
    // url also parses a special scheme without `//`, which would move the
    // authority read below into the path.
    let prefix = format!("{}://", url.scheme());
    require(
        raw.get(..prefix.len())
            .is_some_and(|start| start.eq_ignore_ascii_case(&prefix)),
        "expected an HTTP or HTTPS endpoint",
    )?;
    // url normalizes shorthand IPv4 (127.1, integers, octal). Require the literal
    // address spelling from the input so normalization cannot weaken policy.
    let authority = raw[prefix.len()..].split('/').next().unwrap_or("");
    let literal_host = if authority.starts_with('[') {
        authority
            .split(']')
            .next()
            .unwrap_or("")
            .trim_start_matches('[')
    } else {
        authority.split(':').next().unwrap_or("")
    };
    if url.scheme() == "http" {
        require(
            literal_host.parse().ok() == ip
                && ip.is_some_and(|ip| ip.is_loopback() || (!gateway && private(ip))),
            "HTTP requires a literal loopback address or private inference address",
        )?;
    }
    require(
        url.host_str().is_none_or(|host| {
            !host
                .trim_end_matches('.')
                .eq_ignore_ascii_case("metadata.google.internal")
        }),
        "metadata endpoints are forbidden",
    )
}
