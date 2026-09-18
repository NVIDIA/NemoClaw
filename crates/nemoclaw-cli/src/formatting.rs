// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use crate::{args::OutputFormat, dispatch::CommandResult};
use nemoclaw_sdk::{Error, OperationResult};

pub(crate) fn render(
    result: CommandResult,
    format: OutputFormat,
) -> Result<String, Box<dyn std::error::Error>> {
    match result {
        CommandResult::OnboardExit => Ok(String::new()),
        CommandResult::Export(document) => Ok(document.yaml()?),
        CommandResult::Operation(result) => match format {
            OutputFormat::Text => Ok(plan(&result)),
            OutputFormat::Json => Ok(format!("{}\n", serde_json::to_string_pretty(&result)?)),
        },
    }
}

pub(crate) fn render_error(error: &(dyn std::error::Error + 'static)) -> String {
    if let Some(Error::Health { health }) = error.downcast_ref::<Error>() {
        return serde_json::json!({
            "error": "fabric_readiness", "health": health, "resourcesRetained": true
        })
        .to_string();
    }
    if let Some(Error::SandboxStartup { .. }) = error.downcast_ref::<Error>() {
        return format!(
            "{error}\nInspect with openshell sandbox get NAME -o json using the deployment's gateway and workspace. Collect OpenShell gateway and supervisor logs before cleanup."
        );
    }
    error.to_string()
}

fn plan(result: &OperationResult) -> String {
    let mut output = match result.changes.len() {
        0 => "No resource changes planned.\n".to_owned(),
        1 => "Plan: 1 resource would change.\n".to_owned(),
        count => format!("Plan: {count} resources would change.\n"),
    };
    if !result.changes.is_empty() {
        let actions: Vec<_> = result
            .changes
            .iter()
            .map(|change| change.actions.join(" -> "))
            .collect();
        let width = actions.iter().map(String::len).max().unwrap_or(0).max(6);
        output.push_str(&format!("\n  {:width$}  RESOURCE\n", "ACTION"));
        for (change, action) in result.changes.iter().zip(actions) {
            output.push_str(&format!("  {action:width$}  {}\n", change.resource));
        }
    }
    if !result.retained.is_empty() {
        output.push_str("\nRetained resources:\n");
        for resource in &result.retained {
            output.push_str(&format!("  - {resource}\n"));
        }
    }
    if !result.deferred.is_empty() {
        output.push_str("\nDeferred (plan is incomplete):\n");
        for reason in &result.deferred {
            output.push_str(&format!("  - {reason}\n"));
        }
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::args::Cli;
    use clap::Parser;
    use serde_json::{Value, json};

    fn render(args: &[&str], result: Value) -> String {
        let cli = Cli::try_parse_from(args).unwrap();
        super::render(
            CommandResult::Operation(serde_json::from_value(result).unwrap()),
            cli.command.output_format(),
        )
        .unwrap()
    }

    #[test]
    fn default_plan_shows_actions_and_explains_deferred_work() {
        let result = json!({
            "outcome": "planned",
            "changes": [
                {"resource": "nemoclaw_managed_gateway.runtime", "actions": ["create"]},
                {"resource": "fabric_runtime.assistant", "actions": ["update"]}
            ],
            "deferred": ["OpenShell registration and sandbox require the managed gateway"]
        });
        let expected = "Plan: 2 resources would change.\n\n  ACTION  RESOURCE\n  create  nemoclaw_managed_gateway.runtime\n  update  fabric_runtime.assistant\n\nDeferred (plan is incomplete):\n  - OpenShell registration and sandbox require the managed gateway\n";
        assert_eq!(
            render(&["nemoclaw", "plan", "spark.yaml"], result.clone()),
            expected
        );
        assert_eq!(
            render(&["nemoclaw", "plan", "spark.yaml", "-o", "text"], result),
            expected
        );
    }

    #[test]
    fn destroy_preview_distinguishes_deleted_and_retained_resources() {
        let result = json!({
            "outcome": "planned",
            "changes": [{"resource": "nemoclaw_sandbox.assistant", "actions": ["delete"]}],
            "retained": ["nemoclaw_gateway_storage.runtime", "nemoclaw_inference_storage.inference_local"]
        });
        assert_eq!(
            render(&["nemoclaw", "plan", "--destroy"], result),
            "Plan: 1 resource would change.\n\n  ACTION  RESOURCE\n  delete  nemoclaw_sandbox.assistant\n\nRetained resources:\n  - nemoclaw_gateway_storage.runtime\n  - nemoclaw_inference_storage.inference_local\n"
        );
    }

    #[test]
    fn empty_plan_keeps_incomplete_observation_visible() {
        let mut result = json!({"outcome": "planned", "changes": []});
        assert_eq!(
            render(&["nemoclaw", "plan", "spark.yaml"], result.clone()),
            "No resource changes planned.\n"
        );
        result["deferred"] = json!(["Model inventory requires recovery"]);
        assert_eq!(
            render(&["nemoclaw", "plan", "spark.yaml"], result),
            "No resource changes planned.\n\nDeferred (plan is incomplete):\n  - Model inventory requires recovery\n"
        );
    }

    #[test]
    fn replacement_preserves_action_order_without_counting_two_resources() {
        let result = json!({
            "outcome": "planned",
            "changes": [{"resource": "nemoclaw_inference_service.inference_local", "actions": ["delete", "create"]}]
        });
        let output = render(&["nemoclaw", "plan", "spark.yaml"], result);
        assert!(output.starts_with("Plan: 1 resource would change.\n"));
        assert!(output.contains("delete -> create  nemoclaw_inference_service.inference_local"));
    }

    #[test]
    fn json_is_indented_and_preserves_the_sdk_result_for_scripts() {
        let result = json!({
            "outcome": "planned",
            "changes": [{"resource": "nemoclaw_sandbox.assistant", "actions": ["delete"]}],
            "retained": ["nemoclaw_gateway_storage.runtime"],
            "deferred": ["Pending observation"]
        });
        for input in ["spark.yaml", "--destroy"] {
            let output = render(&["nemoclaw", "plan", input, "-o", "json"], result.clone());
            assert_eq!(serde_json::from_str::<Value>(&output).unwrap(), result);
            assert!(output.starts_with("{\n  \"outcome\": \"planned\",\n"));
            assert!(output.contains("\n      \"resource\": \"nemoclaw_sandbox.assistant\","));
            assert!(output.ends_with("\n}\n"));
        }
    }

    #[test]
    fn apply_reports_health_without_changing_the_command_surface() {
        let value = serde_json::json!({
            "outcome": "succeeded", "changes": [], "health": [{
                "sandbox": "research", "agents": ["researcher", "writer"],
                "supported": false, "report": null, "reason_code": "fabric_health_unsupported"
            }]
        });
        let result = CommandResult::Operation(serde_json::from_value(value.clone()).unwrap());
        let output: serde_json::Value =
            serde_json::from_str(&super::render(result, OutputFormat::Json).unwrap()).unwrap();
        assert_eq!(output, value);
    }

    #[test]
    fn sandbox_failure_points_to_openshell_diagnostics() {
        let error = Error::SandboxStartup {
            phase: "SANDBOX_PHASE_ERROR",
            reason: "ControlSupervisorExited",
            exit_code: "unknown".into(),
        };
        let output = render_error(&error);
        assert!(output.contains("ControlSupervisorExited"));
        assert!(output.contains("openshell sandbox get NAME -o json"));
        assert!(output.contains("gateway and workspace"));
        assert!(output.contains("resources retained"));
    }

    #[test]
    fn health_failure_keeps_structured_evidence_in_stderr() {
        let health = serde_json::from_value(serde_json::json!({
            "sandbox": "research", "agents": ["researcher"],
            "supported": true, "report": null, "reason_code": "fabric_health_timeout"
        }))
        .unwrap();
        let error = Error::Health {
            health: Box::new(health),
        };
        let output: serde_json::Value = serde_json::from_str(&render_error(&error)).unwrap();
        assert_eq!(output["health"]["reason_code"], "fabric_health_timeout");
        assert_eq!(output["resourcesRetained"], true);
        assert_eq!(
            render_error(&Error::Conflict("fixed message")),
            "fixed message"
        );
    }
}
