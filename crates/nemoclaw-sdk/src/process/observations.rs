// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

pub(super) fn postcondition_failures(output: &[u8]) -> Option<Vec<String>> {
    use serde_json::Value;
    use std::collections::BTreeSet;

    let mut lines = output
        .split(|byte| *byte == b'\n')
        .filter(|line| !line.is_empty());
    let version: Value = serde_json::from_slice(lines.next()?).ok()?;
    if version["type"] != "version" || version["ui"].as_str()?.split('.').next() != Some("1") {
        return None;
    }
    let mut pending = BTreeSet::new();
    let mut failed = BTreeSet::new();
    for line in lines {
        let event: Value = serde_json::from_slice(line).ok()?;
        match event["type"].as_str()? {
            "apply_start" => {
                pending.insert(event["hook"]["resource"]["addr"].as_str()?.to_owned());
            }
            "apply_complete" => {
                pending.remove(event["hook"]["resource"]["addr"].as_str()?);
            }
            "apply_errored" => return None,
            "diagnostic" => {
                let diagnostic = &event["diagnostic"];
                match diagnostic["severity"].as_str()? {
                    "warning" => continue,
                    "error" => {}
                    _ => return None,
                }
                let context = diagnostic["snippet"]["context"].as_str()?;
                let (address, index) = context.rsplit_once(".lifecycle.postcondition[")?;
                index.strip_suffix(']')?.parse::<usize>().ok()?;
                // The pinned OpenTofu JSON UI has no diagnostic code. Require
                // its postcondition category and a data address, never detail text.
                if diagnostic["summary"] != "Resource postcondition failed"
                    || !address.starts_with("data.")
                {
                    return None;
                }
                failed.insert(address.to_owned());
            }
            _ => {}
        }
    }
    (!failed.is_empty() && pending.is_empty()).then(|| failed.into_iter().collect())
}

/// The addresses of creates that a provider reported as rejected before they
/// created anything, when every resource operation of the apply finished and
/// those rejections were its only failures.
///
/// A provider marks such a create with the summary
/// [`CREATED_NOTHING_SUMMARY`] on an error that OpenTofu attributes to the
/// resource's address. Anything else leaves the creation unresolved: another
/// failure, an operation that never finished, an unattributed diagnostic, or a
/// malformed stream.
pub(super) fn uncreated_resources(output: &[u8]) -> Option<Vec<String>> {
    use nemoclaw_backend::CREATED_NOTHING_SUMMARY;
    use serde_json::Value;
    use std::collections::BTreeSet;

    let mut lines = output
        .split(|byte| *byte == b'\n')
        .filter(|line| !line.is_empty());
    let version: Value = serde_json::from_slice(lines.next()?).ok()?;
    if version["type"] != "version" || version["ui"].as_str()?.split('.').next() != Some("1") {
        return None;
    }
    let mut pending = BTreeSet::new();
    let mut errored = BTreeSet::new();
    let mut rejected = BTreeSet::new();
    for line in lines {
        let event: Value = serde_json::from_slice(line).ok()?;
        match event["type"].as_str()? {
            "apply_start" => {
                pending.insert(event["hook"]["resource"]["addr"].as_str()?.to_owned());
            }
            "apply_complete" => {
                pending.remove(event["hook"]["resource"]["addr"].as_str()?);
            }
            "apply_errored" => {
                let address = event["hook"]["resource"]["addr"].as_str()?;
                pending.remove(address);
                errored.insert(address.to_owned());
            }
            "diagnostic" => {
                let diagnostic = &event["diagnostic"];
                match diagnostic["severity"].as_str()? {
                    "warning" => continue,
                    "error" => {}
                    _ => return None,
                }
                if diagnostic["summary"] != CREATED_NOTHING_SUMMARY {
                    return None;
                }
                rejected.insert(diagnostic["address"].as_str()?.to_owned());
            }
            _ => {}
        }
    }
    // Each failed operation must have its own rejection, and each rejection a
    // failed operation: neither one proves the other alone.
    (!rejected.is_empty() && pending.is_empty() && errored == rejected)
        .then(|| rejected.into_iter().collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    fn stream(events: Vec<Value>) -> Vec<u8> {
        std::iter::once(json!({"type":"version", "ui":"1.0"}))
            .chain(events)
            .map(|value| format!("{value}\n"))
            .collect::<String>()
            .into_bytes()
    }

    fn failed_check() -> Value {
        json!({"type":"diagnostic", "diagnostic":{
            "severity":"error", "summary":"Resource postcondition failed",
            "snippet":{"context":"data.example_readiness.sandbox.lifecycle.postcondition[0]"},
            "detail":"a runtime observation failed"
        }})
    }

    #[test]
    fn completed_mutations_with_only_data_postcondition_errors_are_distinguishable() {
        let output = stream(vec![
            json!({"type":"apply_start", "hook":{"resource":{"addr":"example_sandbox.main"}}}),
            json!({"type":"apply_complete", "hook":{"resource":{"addr":"example_sandbox.main"}}}),
            failed_check(),
        ]);
        assert_eq!(
            postcondition_failures(&output),
            Some(vec!["data.example_readiness.sandbox".into()])
        );
    }

    #[test]
    fn mixed_errors_unfinished_mutations_and_malformed_streams_remain_ambiguous() {
        for event in [
            json!({"type":"diagnostic", "diagnostic":{"severity":"error", "summary":"resource write failed"}}),
            json!({"type":"apply_errored", "hook":{"resource":{"addr":"example_sandbox.main"}}}),
            json!({"type":"apply_start", "hook":{"resource":{"addr":"example_sandbox.main"}}}),
            json!({"type":"diagnostic", "diagnostic":{"severity":"error", "summary":"Resource postcondition failed", "snippet":{"context":"example_sandbox.main.lifecycle.postcondition[0]"}}}),
        ] {
            assert_eq!(
                postcondition_failures(&stream(vec![failed_check(), event])),
                None
            );
        }
        assert_eq!(postcondition_failures(&stream(vec![])), None);
        let mut truncated = stream(vec![failed_check()]);
        truncated.extend_from_slice(b"{unfinished");
        assert_eq!(postcondition_failures(&truncated), None);
    }

    fn started(address: &str) -> Value {
        json!({"type":"apply_start", "hook":{"resource":{"addr":address}}})
    }

    fn completed(address: &str) -> Value {
        json!({"type":"apply_complete", "hook":{"resource":{"addr":address}}})
    }

    fn errored(address: &str) -> Value {
        json!({"type":"apply_errored", "hook":{"resource":{"addr":address}}})
    }

    fn rejection(address: Option<&str>) -> Value {
        let mut diagnostic = json!({
            "severity":"error", "summary":"Create rejected; nothing created",
            "detail":"OpenShell CreateSandbox rejected (InvalidArgument): reserved key"
        });
        if let Some(address) = address {
            diagnostic["address"] = address.into();
        }
        json!({"type":"diagnostic", "diagnostic":diagnostic})
    }

    #[test]
    fn rejected_creates_that_were_the_only_failures_are_named() {
        let output = stream(vec![
            started("openshell_workspace.deployment"),
            started("openshell_sandbox.coder"),
            started("openshell_sandbox.reviewer"),
            completed("openshell_workspace.deployment"),
            errored("openshell_sandbox.reviewer"),
            errored("openshell_sandbox.coder"),
            rejection(Some("openshell_sandbox.coder")),
            rejection(Some("openshell_sandbox.reviewer")),
            json!({"type":"diagnostic", "diagnostic":{"severity":"warning", "summary":"Deprecated"}}),
        ]);
        assert_eq!(
            uncreated_resources(&output),
            Some(vec![
                "openshell_sandbox.coder".into(),
                "openshell_sandbox.reviewer".into()
            ])
        );
    }

    #[test]
    fn a_rejection_is_not_trusted_beside_other_failures_or_unfinished_operations() {
        let rejected = || {
            vec![
                started("openshell_sandbox.coder"),
                errored("openshell_sandbox.coder"),
                rejection(Some("openshell_sandbox.coder")),
            ]
        };
        let with = |extra: Vec<Value>| stream([rejected(), extra].concat());
        for (case, output) in [
            (
                "another error diagnostic",
                with(vec![
                    json!({"type":"diagnostic", "diagnostic":{"severity":"error", "summary":"Apply incomplete"}}),
                ]),
            ),
            (
                "another failed operation",
                with(vec![
                    started("openshell_provider.key"),
                    errored("openshell_provider.key"),
                ]),
            ),
            (
                "an operation that never finished",
                with(vec![started("openshell_provider.key")]),
            ),
            (
                "a rejection without an address",
                stream(vec![
                    started("openshell_sandbox.coder"),
                    errored("openshell_sandbox.coder"),
                    rejection(None),
                ]),
            ),
            (
                "a rejection for an operation that did not fail",
                stream(vec![
                    started("openshell_sandbox.coder"),
                    completed("openshell_sandbox.coder"),
                    rejection(Some("openshell_sandbox.coder")),
                ]),
            ),
            (
                "a failed operation without a rejection",
                stream(vec![
                    started("openshell_sandbox.coder"),
                    errored("openshell_sandbox.coder"),
                ]),
            ),
            ("no events", stream(vec![])),
        ] {
            assert_eq!(uncreated_resources(&output), None, "{case}");
        }
        let mut truncated = stream(rejected());
        truncated.extend_from_slice(b"{unfinished");
        assert_eq!(uncreated_resources(&truncated), None, "truncated stream");
    }
}
