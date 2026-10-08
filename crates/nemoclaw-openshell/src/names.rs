// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Names of the OpenShell objects NemoClaw manages.

/// A lowercase letter followed by up to 39 lowercase letters, digits, or hyphens.
pub const NAME_PATTERN: &str = r"^[a-z][a-z0-9-]{0,39}$";

/// Whether `name` matches [`NAME_PATTERN`].
pub fn valid_name(name: &str) -> bool {
    let bytes = name.as_bytes();
    (1..=40).contains(&bytes.len())
        && bytes[0].is_ascii_lowercase()
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'-')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_follow_the_published_pattern() {
        for (name, valid) in [
            ("coder", true),
            ("a", true),
            ("a-1", true),
            (&"a".repeat(40), true),
            (&"a".repeat(41), false),
            ("", false),
            ("1a", false),
            ("-a", false),
            ("Coder", false),
            ("co_der", false),
        ] {
            assert_eq!(valid_name(name), valid, "{name}");
        }
    }
}
