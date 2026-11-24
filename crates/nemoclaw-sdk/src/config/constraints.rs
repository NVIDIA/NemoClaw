// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
// Spark memory defaults were informed by MiaAI Lab's start.sh and memwatch.sh.
// Upstream AGPL-3.0-or-later recipe and revision: crates/nemoclaw-sdk/NOTICE.md.
//! Values shared by normalization, validation, and the authored-input schema.
//!
//! Patterns use syntax that ECMA-262 and RE2 validators share: `$` ends the
//! input, and there is no lookaround and no `\u` escape.

/// Whether `value` matches one of the SDK's constant patterns. Each pattern
/// compiles once: managed and Kubernetes resources check their identities on
/// every compile and observation, and compiling costs more than matching.
pub(crate) fn matches(pattern: &'static str, value: &str) -> bool {
    static COMPILED: std::sync::LazyLock<
        std::sync::Mutex<std::collections::HashMap<&'static str, regex::Regex>>,
    > = std::sync::LazyLock::new(Default::default);
    let regex = COMPILED
        .lock()
        .expect("pattern cache")
        .entry(pattern)
        .or_insert_with(|| regex::Regex::new(pattern).expect("constant pattern"))
        .clone();
    regex.is_match(value)
}

pub(crate) const KIND: &str = "NemoClawConfig";
pub(crate) const SLUG: &str = nemoclaw_openshell::NAME_PATTERN;
/// What [`SLUG`] allows, for a map key that names a definition.
pub(crate) const SLUG_KEYS_ERROR: &str = "names must start with a lowercase letter and use only lowercase letters, digits, and hyphens, up to 40 characters";
pub(crate) const IMAGE_METADATA_TARGETS: &str = "image.metadata is available only for Kubernetes and OpenShift; Docker and Podman use engine image inspection";
pub(crate) const UUID: &str = r"^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$";
/// RFC 4122 UUIDs are case-insensitive on input; defaults store them lowercase.
pub(crate) const UUID_INPUT: &str =
    r"^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$";
pub(crate) const ENV: &str = r"^[A-Z_][A-Z0-9_]{0,127}$";
pub(crate) const MODEL: &str = r"^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$";
pub(crate) const APPLICATION_USER: &str = r"^[0-9]{1,9}:[0-9]{1,9}$";
pub(crate) const APPLICATION_ROOT: &str = r"^(/data|/var/lib/[a-z][a-z0-9-]{0,62})$";
pub(crate) const IMAGE: &str = r"^[a-zA-Z0-9][a-zA-Z0-9._:/-]*@sha256:[a-f0-9]{64}$";
/// One GPU as `nvidia-smi` names it: its UUID, or an index. `all` or a
/// comma-separated value would go straight into Docker's `device=` syntax.
pub const GPU_DEVICE: &str =
    r"^(?:GPU-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|0|[1-9][0-9]{0,2})$";
/// The loopback port a managed Docker or Podman gateway listens on when its
/// target names none.
pub const GATEWAY_PORT: u16 = 17681;
/// The ports a managed Docker or Podman gateway accepts: unprivileged ones.
pub(crate) const GATEWAY_PORTS: nemoclaw_runtime::schema::DefaultedInteger =
    nemoclaw_runtime::schema::DefaultedInteger {
        default: GATEWAY_PORT as i64,
        min: 1024,
        max: 65535,
    };
/// The engine a managed gateway uses when none is configured: Docker's default socket.
pub const GATEWAY_ENGINE: &str = "unix:///var/run/docker.sock";
/// The address clients dial for a managed cluster gateway with `expose`: a
/// lowercase DNS name or IPv4 address and an explicit nonzero port.
pub(crate) const KUBERNETES_EXPOSED_GATEWAY_ENDPOINT: &str = r"^https://[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*:(?:[1-9][0-9]{0,3}|[1-5][0-9]{4}|6[0-4][0-9]{3}|65[0-4][0-9]{2}|655[0-2][0-9]|6553[0-5])$";
/// A Kubernetes object name that must be a DNS subdomain, such as a ConfigMap's
/// or a StorageClass's.
pub(crate) const KUBERNETES_SUBDOMAIN_NAME: &str =
    r"^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?(?:\.[a-z0-9](?:[-a-z0-9]*[a-z0-9])?)*$";
/// A CPU quantity: cores with up to three decimals, or whole millicores.
pub(crate) const KUBERNETES_CPU: &str = r"^(?:[0-9]{1,6}(?:\.[0-9]{1,3})?|[1-9][0-9]{0,8}m)$";
/// A memory quantity in whole mebibytes or gibibytes. Kubernetes also accepts
/// a lowercase `m`, thousandths of a byte, which no gateway can run with.
pub(crate) const KUBERNETES_MEMORY: &str = r"^[1-9][0-9]{0,8}(?:Mi|Gi)$";
pub(crate) const NETWORK_TIER: &str = "isolated";
/// Sandboxes in a document with a Kubernetes or OpenShift gateway. The cluster
/// schedules their pods; a document is one gateway, namespace and state, so
/// this bounds what one gateway outage or slow plan affects.
pub(crate) const CLUSTER_SANDBOXES: usize = 256;
/// Sandboxes in a document with a Docker or Podman gateway, which runs every
/// sandbox on one host.
pub(crate) const HOST_SANDBOXES: usize = 32;
