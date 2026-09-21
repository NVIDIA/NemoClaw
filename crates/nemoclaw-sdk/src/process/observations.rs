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
}
