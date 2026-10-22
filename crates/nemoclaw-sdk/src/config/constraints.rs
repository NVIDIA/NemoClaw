// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
// Spark memory defaults were informed by MiaAI Lab's start.sh and memwatch.sh.
// Upstream AGPL-3.0-or-later recipe and revision: crates/nemoclaw-sdk/NOTICE.md.
//! Values shared by normalization, validation, and the authored-input schema.
//!
//! Patterns use syntax that ECMA-262 and RE2 validators share: `$` ends the
//! input, and there is no lookaround and no `\u` escape.

pub(crate) const KIND: &str = "NemoClawConfig";
pub(crate) const SLUG: &str = nemoclaw_openshell::NAME_PATTERN;
pub(crate) const UUID: &str = r"^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$";
/// RFC 4122 UUIDs are case-insensitive on input; defaults store them lowercase.
pub(crate) const UUID_INPUT: &str =
    r"^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$";
pub(crate) const ENV: &str = r"^[A-Z_][A-Z0-9_]{0,127}$";
pub(crate) const MODEL: &str = r"^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$";
pub(crate) const APPLICATION_USER: &str = r"^[0-9]{1,9}:[0-9]{1,9}$";
pub(crate) const APPLICATION_ROOT: &str = r"^(/data|/var/lib/[a-z][a-z0-9-]{0,62})$";
/// A digest-pinned image reference in the registry reference grammar: an
/// optional registry host (with a dot or port, or `localhost`), lowercase
/// repository path components, an optional tag, and the SHA-256 digest.
pub(crate) const IMAGE: &str = concat!(
    r"^(?:(?:localhost(?::[0-9]+)?",
    r"|[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)+(?::[0-9]+)?",
    r"|[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?:[0-9]+)/)?",
    r"[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*(?:/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*)*",
    r"(?::[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,127})?@sha256:[a-f0-9]{64}$",
);
pub(crate) const GATEWAY_ENDPOINT: &str = "http://127.0.0.1:17681";
/// The engine a managed gateway uses when none is configured: Docker's default socket.
pub const GATEWAY_ENGINE: &str = "unix:///var/run/docker.sock";
pub(crate) const KUBERNETES_GATEWAY_ENDPOINT: &str = r"^https://127\.0\.0\.1:(?:[1-9][0-9]{0,3}|[1-5][0-9]{4}|6[0-4][0-9]{3}|65[0-4][0-9]{2}|655[0-2][0-9]|6553[0-5])$";
pub(crate) const NETWORK_TIER: &str = "isolated";
