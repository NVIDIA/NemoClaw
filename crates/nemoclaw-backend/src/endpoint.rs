// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! The endpoint policy every backend applies before it connects.

use nemoclaw_runtime::config::ConfigError;
use std::net::{IpAddr, Ipv6Addr};
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

/// Whether no endpoint or Service may name `ip`: unspecified, multicast,
/// link-local, and the AWS IPv6 metadata address. IPv6 that embeds IPv4 is
/// forbidden rather than converted: IPv4-mapped `::ffff:0:0/96`,
/// IPv4-compatible `::/96` other than `::` and `::1`, and NAT64 `64:ff9b::/96`.
/// Converting would accept plain HTTP to `[::ffff:10.0.0.1]`.
pub fn forbidden_address(ip: IpAddr) -> bool {
    ip.is_unspecified()
        || ip.is_multicast()
        || match ip {
            IpAddr::V4(ip) => ip.is_link_local(),
            IpAddr::V6(ip) => {
                let [a, b, c, d, e, f, ..] = ip.segments();
                let prefix = [a, b, c, d, e, f];
                ip.is_unicast_link_local()
                    || ip == Ipv6Addr::new(0xfd00, 0xec2, 0, 0, 0, 0, 0, 0x254)
                    || ip.to_ipv4_mapped().is_some()
                    || prefix == [0x64, 0xff9b, 0, 0, 0, 0]
                    || prefix == [0; 6] && !ip.is_loopback()
            }
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
    require(
        !ip.is_some_and(forbidden_address),
        "unspecified, multicast, link-local, metadata, and IPv4-embedding endpoints are forbidden",
    )?;
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
    // GCE resolves the single label `metadata` to its metadata server too.
    require(
        url.host_str().is_none_or(|host| {
            let host = host.trim_end_matches('.');
            !host.eq_ignore_ascii_case("metadata")
                && !host.eq_ignore_ascii_case("metadata.google.internal")
        }),
        "metadata endpoints are forbidden",
    )
}
