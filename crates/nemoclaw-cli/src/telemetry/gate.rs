// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Whether this process may send a record: one decision at process start.

use super::record::{TEST_LABEL_PATTERN, matches};

/// The off switch. It, or any of [`CI_VARIABLES`], set stops the record.
const OFF_SWITCH: &str = nemoclaw_sdk::telemetry::DISABLE_ENV;

/// Any of these, set, means the run is in CI and nothing is sent.
const CI_VARIABLES: [&str; 6] = [
    "CI",
    "GITHUB_ACTIONS",
    "TF_BUILD",
    "BUILD_ID",
    "TEAMCITY_VERSION",
    "CODEBUILD_BUILD_ID",
];

/// The test label to send when this process may send a record (empty when
/// none is set), or `None` when it must send nothing. Unit-test builds never send.
pub fn check() -> Option<String> {
    if cfg!(test) {
        return None;
    }
    decide(|name| std::env::var_os(name).map(|value| value.to_string_lossy().into_owned()))
}

fn decide(var: impl Fn(&str) -> Option<String>) -> Option<String> {
    // The rule the managed gateway's telemetry follows too, so `1`, `yes`,
    // and `TRUE` all turn telemetry off.
    let set = |value: String| nemoclaw_sdk::telemetry::is_set(Some(value.as_ref()));
    if std::iter::once(&OFF_SWITCH)
        .chain(&CI_VARIABLES)
        .any(|name| var(name).is_some_and(set))
    {
        return None;
    }
    // A label that is set must be valid; an empty one is not, as in NemoClaw v0.
    match var("NEMOCLAW_TELEMETRY_TEST_LABEL") {
        None => Some(String::new()),
        Some(label) if !label.is_empty() && matches(TEST_LABEL_PATTERN, &label) => Some(label),
        Some(_) => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn decide_with(vars: &[(&str, &str)]) -> Option<String> {
        decide(|name| {
            vars.iter()
                .find(|(key, _)| *key == name)
                .map(|(_, value)| value.to_string())
        })
    }

    #[test]
    fn sends_by_default_with_an_empty_label() {
        assert_eq!(decide_with(&[]), Some(String::new()));
    }

    #[test]
    fn any_set_off_switch_stops_the_record() {
        let var = OFF_SWITCH;
        for value in ["1", "yes", "true", "TRUE", "on", "no", "off", "ture"] {
            assert_eq!(decide_with(&[(var, value)]), None, "{value:?}");
        }
        for value in ["", "0", "false", "FALSE", "False"] {
            assert!(decide_with(&[(var, value)]).is_some(), "{value:?}");
        }
    }

    #[test]
    fn any_set_ci_variable_stops_the_record() {
        for name in CI_VARIABLES {
            for value in ["true", "1", "8812", "yes"] {
                assert_eq!(decide_with(&[(name, value)]), None, "{name}={value}");
            }
            for value in ["", "false", "FALSE", "False", "0"] {
                assert!(decide_with(&[(name, value)]).is_some(), "{name}={value:?}");
            }
        }
    }

    #[test]
    fn a_valid_label_is_sent_and_a_malformed_one_stops_the_record() {
        let label = "qa-1120a:onboard-hermes:attempt-2";
        let var = "NEMOCLAW_TELEMETRY_TEST_LABEL";
        assert_eq!(decide_with(&[(var, label)]), Some(label.into()));
        for bad in [
            "",
            "qa-run:case:attempt-0",
            "qa-run:case:attempt-1000",
            "qa-Run:case:attempt-1",
            "qa-run:/home/user/x:attempt-1",
            "qa-run:case:attempt-1\n",
            "run:case:attempt-1",
        ] {
            assert_eq!(decide_with(&[(var, bad)]), None, "{bad:?}");
        }
        assert!(decide_with(&[(var, &format!("qa-{}:c:attempt-1", "a".repeat(32)))]).is_some());
        assert_eq!(
            decide_with(&[(var, &format!("qa-{}:c:attempt-1", "a".repeat(33)))]),
            None
        );
    }

    #[test]
    fn unit_test_builds_never_send() {
        assert_eq!(check(), None);
    }
}
