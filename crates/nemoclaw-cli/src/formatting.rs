// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use crate::{
    args::{Cli, Command, OutputFormat},
    dispatch::CommandResult,
    style::{Palette, Tone},
};
use nemoclaw_sdk::{Error, OperationResult, Outcome};
use std::{
    borrow::Cow,
    collections::BTreeSet,
    io::IsTerminal,
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

/// Presentation context and mutation facts reported by the SDK.
pub(crate) struct RenderContext {
    operation: &'static str,
    mutation_started: Arc<AtomicBool>,
    warnings: Arc<Mutex<BTreeSet<String>>>,
    state_dir: PathBuf,
    input: Option<PathBuf>,
    verbose: bool,
    started: Instant,
    output_palette: Palette,
    error_palette: Palette,
}

impl RenderContext {
    pub(crate) fn new(cli: &Cli) -> Self {
        let (operation, input) = match &cli.command {
            Command::Plan { destroy: true, .. } => ("Destroy plan", None),
            Command::Plan { file, .. } => ("Plan", file.clone()),
            Command::Apply { file, .. } => ("Apply", Some(file.clone())),
            Command::Destroy { .. } => ("Destroy", None),
            Command::Export { .. } => ("Export", None),
            Command::Onboard { file, .. } => ("Onboard", file.clone()),
        };
        Self {
            operation,
            mutation_started: Arc::new(AtomicBool::new(false)),
            warnings: Arc::new(Mutex::new(BTreeSet::new())),
            input,
            state_dir: cli.state_dir.clone(),
            verbose: cli.verbose,
            started: Instant::now(),
            output_palette: Palette::detect(
                std::io::stdout().is_terminal()
                    && !matches!(cli.progress, crate::args::ProgressMode::Plain),
            ),
            error_palette: Palette::detect(
                std::io::stderr().is_terminal()
                    && !matches!(cli.progress, crate::args::ProgressMode::Plain),
            ),
        }
    }

    pub(crate) fn progress(
        &self,
        display: Arc<dyn Fn(nemoclaw_sdk::Progress) + Send + Sync>,
    ) -> Arc<dyn Fn(nemoclaw_sdk::Progress) + Send + Sync> {
        let mutation_started = self.mutation_started.clone();
        let warnings = self.warnings.clone();
        Arc::new(move |event| {
            // Record synchronously even when progress rendering is disabled or
            // its display channel is closed. Later stages never reset this fact.
            if event == nemoclaw_sdk::Progress::MutationStarted {
                mutation_started.store(true, Ordering::Relaxed);
            }
            if let nemoclaw_sdk::Progress::Warning { message } = &event {
                warnings
                    .lock()
                    .expect("warning collection")
                    .insert(message.clone());
            }
            display(event);
        })
    }

    fn warnings(&self) -> Vec<String> {
        self.warnings
            .lock()
            .expect("warning collection")
            .iter()
            .cloned()
            .collect()
    }

    fn add_warnings(&self, value: &mut serde_json::Value) {
        let warnings = self.warnings();
        if !warnings.is_empty() {
            value["warnings"] = serde_json::json!(warnings);
        }
    }

    fn append_warnings(&self, output: &mut String) {
        let warnings = self.warnings();
        if !warnings.is_empty() {
            output.push_str("\nWarnings:\n");
            for warning in warnings {
                output.push_str(&format!("  {}\n", terminal_text(&warning)));
            }
        }
    }

    pub(crate) fn header(&self) -> String {
        let input = self
            .input
            .as_ref()
            .map(|path| format!(" · {}", terminal_text(&path.display().to_string())))
            .unwrap_or_default();
        format!(
            "{}{input}\nState: {}",
            self.operation,
            terminal_text(&self.state_dir.display().to_string())
        )
    }
}

pub(crate) fn render(
    result: CommandResult,
    format: OutputFormat,
    context: &RenderContext,
) -> Result<String, Box<dyn std::error::Error>> {
    match result {
        CommandResult::Export(document) => Ok(document.yaml()?),
        CommandResult::Authored(path) => Ok(path.map(|path| format!("Authored desired state: {}\nRun nemoclaw plan with this file when you are ready to check deployment.\n", terminal_text(&path.display().to_string()))).unwrap_or_default()),
        CommandResult::Operation(result) => match format {
            OutputFormat::Text => {
                let mut output = operation(&result, context);
                context.append_warnings(&mut output);
                Ok(output)
            },
            OutputFormat::Json => {
                let mut value = serde_json::to_value(&result)?;
                context.add_warnings(&mut value);
                if result.outcome == Outcome::Planned {
                    value["complete"] = serde_json::Value::Bool(result.deferred.is_empty());
                }
                Ok(format!("{}\n", serde_json::to_string_pretty(&value)?))
            }
        },
    }
}

/// External labels are text, never instructions to a terminal emulator.
pub(crate) fn terminal_text(value: &str) -> String {
    value
        .chars()
        .flat_map(|character| {
            if character.is_control()
                || matches!(character, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
            {
                character.escape_default().collect::<Vec<_>>()
            } else {
                vec![character]
            }
        })
        .collect()
}

pub(crate) fn duration(elapsed: Duration) -> String {
    let seconds = elapsed.as_secs();
    if seconds >= 3600 {
        format!(
            "{}h {}m {}s",
            seconds / 3600,
            seconds / 60 % 60,
            seconds % 60
        )
    } else if seconds >= 60 {
        format!("{}m {}s", seconds / 60, seconds % 60)
    } else if seconds == 0 {
        "<1s".into()
    } else {
        format!("{seconds}s")
    }
}

/// Map only addresses generated by this SDK. Unknown addresses remain visible.
pub(crate) fn resource_label(address: &str) -> String {
    let label = match address {
        "docker_container.managed_gateway_runtime" | "openshell_podman_gateway.runtime" => {
            "gateway".to_owned()
        }
        "openshell_gateway_storage.runtime" => "gateway storage".to_owned(),
        "openshell_workspace.deployment" => "OpenShell workspace".to_owned(),
        _ => {
            // Web search addresses carry an image scope and credential reference
            // to distinguish them in state. The default label names the search
            // provider; verbose retains the address.
            if let Some(rest) = address.strip_prefix("openshell_web_search.") {
                let provider = rest.split('_').next().unwrap_or_default();
                return terminal_text(&format!("web search/{provider}"));
            }
            if let Some(name) = address
                .strip_prefix("vllm_credential_storage.inference_")
                .and_then(|name| name.strip_suffix("_auth"))
            {
                return terminal_text(&format!("inference credentials/{name}"));
            }
            let mappings = [
                ("fabric_agent.", "agent runtime/"),
                ("terraform_data.agent_", "agent configuration/"),
                ("data.ollama_model.", "Ollama model/"),
                ("ollama_proxy_credential_storage.", "proxy credentials/"),
                ("docker_container.ollama_proxy_", "ollama proxy/"),
                ("docker_container.ollama_service_", "ollama/"),
                ("docker_volume.ollama_service_storage_", "model cache/"),
                (
                    "vllm_credential_storage.inference_",
                    "inference credentials/",
                ),
                (
                    "docker_container.inference_service_inference_",
                    "inference/",
                ),
                ("docker_volume.inference_storage_inference_", "model cache/"),
                ("openshell_sandbox.", "sandbox/"),
                ("openshell_inference.inference_", "provider/"),
                ("docker_image.", "image binding/"),
            ];
            mappings
                .iter()
                .find_map(|(prefix, kind)| {
                    address
                        .strip_prefix(prefix)
                        .map(|name| format!("{kind}{name}"))
                })
                .unwrap_or_else(|| address.to_owned())
        }
    };
    terminal_text(&label)
}

fn action_label(actions: &[String]) -> String {
    if actions.is_empty() {
        "unspecified action".into()
    } else {
        actions
            .iter()
            .map(|action| terminal_text(action))
            .collect::<Vec<_>>()
            .join(" → ")
    }
}

fn styled_action(actions: &[String], palette: Palette) -> String {
    let tone = if actions.iter().any(|action| action == "delete") {
        Tone::Warning
    } else if actions.iter().all(|action| action == "create") {
        Tone::Success
    } else {
        Tone::Accent
    };
    palette.paint(&action_label(actions), tone)
}

fn result_resource_label(result: &OperationResult, address: &str) -> String {
    if let Some(source) = result.resource_sources.get(address) {
        let kind = "provider";
        format!(
            "{kind}/{} at {}",
            terminal_text(&source.name),
            terminal_text(&source.path)
        )
    } else {
        resource_label(address)
    }
}

fn operation(result: &OperationResult, context: &RenderContext) -> String {
    let planned = result.outcome == Outcome::Planned;
    let mut output = if planned {
        if !result.deferred.is_empty() {
            format!(
                "{} incomplete · {} known resource changes\n",
                context.operation,
                result.changes.len()
            )
        } else if result.changes.is_empty() {
            "No resource changes planned.\n".into()
        } else {
            format!(
                "{}: {} OpenTofu resource{} would change.\n",
                context.operation,
                result.changes.len(),
                if result.changes.len() == 1 { "" } else { "s" }
            )
        }
    } else {
        let mut summary = format!(
            "{} complete · {}\n",
            context.operation,
            duration(context.started.elapsed())
        );
        if result.changes.is_empty() {
            summary.push_str(if result.outcome == Outcome::Destroyed {
                "Nothing to remove. Retained data unchanged.\n"
            } else {
                "No resource changes.\n"
            });
        }
        summary
    };
    let tone = if !result.deferred.is_empty() {
        Tone::Warning
    } else if planned {
        Tone::Accent
    } else {
        Tone::Success
    };
    if let Some((heading, rest)) = output.split_once('\n') {
        output = format!("{}\n{rest}", context.output_palette.paint(heading, tone));
    }
    if let Some(connection) = &result.connection {
        output.push_str(&format!(
            "\nOpenShell gateway: {}\nOpenShell workspace: {}\n",
            terminal_text(&connection.gateway_endpoint),
            terminal_text(&connection.workspace),
        ));
    }
    if !result.service_urls.is_empty() {
        output.push_str("\nService URLs:\n");
        for (sandbox, services) in &result.service_urls {
            for (service, url) in services {
                // The unnamed endpoint is the sandbox's own.
                let label = if service.is_empty() {
                    terminal_text(sandbox)
                } else {
                    format!("{}/{}", terminal_text(sandbox), terminal_text(service))
                };
                output.push_str(&format!("  {label}: {}\n", terminal_text(url)));
            }
        }
    }
    if !result.changes.is_empty() {
        output.push_str(if planned {
            "\nPlanned actions:\n"
        } else {
            "\nCompleted actions:\n"
        });
        let mut images = std::collections::BTreeMap::<Vec<String>, usize>::new();
        for change in &result.changes {
            if !context.verbose && change.resource.starts_with("docker_image.") {
                *images.entry(change.actions.clone()).or_default() += 1;
                continue;
            }
            let action = styled_action(&change.actions, context.output_palette);
            let label = result_resource_label(result, &change.resource);
            output.push_str(&format!("  {action}  {label}\n"));
            if context.verbose && label != change.resource {
                output.push_str(&format!("    {}\n", terminal_text(&change.resource)));
            }
            if let Some(reason) = &change.reason {
                output.push_str(&format!("    {}\n", terminal_text(reason)));
            }
            if change.resource.starts_with("openshell_sandbox.")
                && change.actions.iter().any(|action| action == "delete")
            {
                let warning = if planned {
                    "Deletes sandbox files and conversation history."
                } else {
                    "Sandbox files and conversation history deleted."
                };
                output.push_str(&format!(
                    "    {}\n",
                    context.output_palette.paint(warning, Tone::Warning)
                ));
            }
            if change.actions.iter().any(|action| action == "delete")
                && change.actions.iter().any(|action| action == "create")
            {
                output.push_str(&format!(
                    "    {}\n",
                    context.output_palette.paint(
                        "Replacement; service interruption may occur.",
                        Tone::Warning
                    )
                ));
            }
        }
        for (actions, count) in images {
            output.push_str(&format!(
                "  {}  {count} image binding{}\n",
                styled_action(&actions, context.output_palette),
                if count == 1 { "" } else { "s" }
            ));
        }
    }
    if planned && !result.discovery.is_empty() {
        output.push_str("\nDiscovery:\n");
        if !result.discovery.resources.is_empty() {
            let resources = &result.discovery.resources;
            let established = resources.iter().filter(|resource| resource.existed).count();
            let unchanged = resources
                .iter()
                .filter(|resource| resource.existed && resource.planned_actions == ["no-op"])
                .count();
            output.push_str(&format!(
                "  Resources: {established} established ({unchanged} unchanged, {} with planned changes); {} new.\n",
                established - unchanged, resources.len() - established,
            ));
            let refreshed = resources.iter().filter(|resource| resource.drifted).count();
            if refreshed > 0 {
                output.push_str(&format!("  Refresh differences: {refreshed} resource{}; may include computed metadata.\n", if refreshed == 1 { "" } else { "s" }));
            }
        }
        let catalogs: Vec<_> = result
            .discovery
            .observations
            .values()
            .filter_map(|observation| {
                if let nemoclaw_sdk::ReportedObservation::Discovery(
                    nemoclaw_sdk::DiscoveryObservation::Inference(observation),
                ) = observation
                {
                    Some(observation)
                } else {
                    None
                }
            })
            .collect();
        if !catalogs.is_empty() {
            let models: usize = catalogs.iter().map(|catalog| catalog.models.len()).sum();
            output.push_str(&format!(
                "  Model catalogs: {models} advertised model{}; inference unverified.\n",
                if models == 1 { "" } else { "s" }
            ));
        }
        if !result.discovery.credentials.is_empty() {
            let available = result
                .discovery
                .credentials
                .iter()
                .filter(|credential| {
                    credential.status == nemoclaw_sdk::discovery::ObservationStatus::Available
                })
                .count();
            output.push_str(&format!(
                "  Credential references: {available}/{} available.\n",
                result.discovery.credentials.len()
            ));
        }
        if context.verbose {
            for (name, observation) in &result.discovery.observations {
                use nemoclaw_sdk::{
                    PlanObservation as Plan, ReportedObservation as Observation,
                    discovery::ObservationStatus,
                };
                let status = match observation {
                    Observation::Discovery(value) => Some(value.status()),
                    Observation::Plan(Plan::RuntimeImage(value)) => Some(value.status),
                    Observation::Plan(Plan::Service { ready, .. }) => ready.map(|value| {
                        if value {
                            ObservationStatus::Available
                        } else {
                            ObservationStatus::Unavailable
                        }
                    }),
                    Observation::Plan(Plan::Unresolved { .. }) => None,
                };
                let label = match status {
                    Some(ObservationStatus::Available) => "observed",
                    Some(ObservationStatus::Unavailable) => "unavailable",
                    Some(ObservationStatus::Unknown) | None => "unverified",
                };
                output.push_str(&format!("  {}: {label}\n", terminal_text(name)));
            }
        }
    }
    if !result.retained.is_empty() {
        output.push_str("\nRetained resources:\n");
        for resource in &result.retained {
            let label = resource_label(resource);
            output.push_str(&format!("  {label}\n"));
            if context.verbose && label != *resource {
                output.push_str(&format!("    {}\n", terminal_text(resource)));
            }
        }
    }
    if matches!(context.operation, "Destroy" | "Destroy plan")
        && result.changes.iter().any(|change| {
            change.resource.starts_with("docker_image.")
                && change.actions.iter().any(|action| action == "delete")
        })
    {
        output.push_str(if planned {
            "\nDownloaded images and local deployment state will be retained.\n"
        } else {
            "\nDownloaded images and local deployment state retained.\n"
        });
    }
    if !result.deferred.is_empty() {
        output.push_str("\nNot yet observed:\n");
        for reason in &result.deferred {
            output.push_str(&format!("  {}\n", terminal_text(reason)));
        }
    }
    if !result.unverified.is_empty() {
        output.push_str("\nUnverified checks:\n");
        for reason in &result.unverified {
            output.push_str(&format!("  {}\n", terminal_text(reason)));
        }
    }
    if planned {
        output.push_str("\nNo runtime resources changed.\n");
    }
    if result.outcome == Outcome::Succeeded && !result.interfaces.is_empty() {
        output.push_str(&interface_access(result));
    }
    if result.outcome == Outcome::Succeeded {
        output.push_str("\nModel and agent responses were not tested.\n");
    }
    output
}

/// How to reach each enabled interface: the commands a person runs, under the
/// gateway and workspace selection that the interface guide describes. Only
/// the person's own retrieval command discloses a token. A terminal interface
/// is opened by running its launcher in the sandbox; it has no forward or
/// token.
fn interface_access(result: &OperationResult) -> String {
    use nemoclaw_sdk::SignIn;
    let mut output = String::from("\nAgent interfaces:\n");
    if let Some(connection) = &result.connection {
        output.push_str("  In each terminal, select this deployment's gateway and workspace:\n");
        let endpoint = terminal_text(&connection.gateway_endpoint);
        if connection.plaintext_loopback() {
            output.push_str(&format!(
                "    unset OPENSHELL_GATEWAY\n    export OPENSHELL_GATEWAY_ENDPOINT={endpoint}\n"
            ));
        } else {
            output.push_str(&format!(
                "    unset OPENSHELL_GATEWAY_ENDPOINT\n    export OPENSHELL_GATEWAY=REPLACE_WITH_PROFILE_NAME  # your profile for {endpoint}\n"
            ));
        }
        output.push_str(&format!(
            "    export OPENSHELL_WORKSPACE={}\n",
            terminal_text(&connection.workspace)
        ));
    }
    for access in &result.interfaces {
        let sandbox = terminal_text(&access.sandbox);
        let interface = terminal_text(&access.interface);
        match access.port {
            Some(port) => {
                output.push_str(&format!("  {sandbox}/{interface} on port {port}\n"));
                output.push_str(&format!(
                    "    Forward:  openshell forward service {sandbox} --target-port {port} --local 127.0.0.1:{port}\n"
                ));
            }
            None => output.push_str(&format!("  {sandbox}/{interface}\n")),
        }
        if access.sign_in == SignIn::SandboxExec {
            match &access.launcher {
                Some(launcher) => {
                    let launcher = terminal_text(launcher);
                    output.push_str(&format!(
                        "    Open:     openshell sandbox exec -n {sandbox} --tty -- {launcher}\n              (on a noexec mount: openshell sandbox exec -n {sandbox} --tty -- sh {launcher})\n"
                    ));
                }
                None => output.push_str(
                    "    Open:     unavailable; the deployment state records no runtime ID for this agent\n",
                ),
            }
        }
        let token = matches!(
            access.sign_in,
            SignIn::TokenInUrlFragment | SignIn::BearerToken
        );
        match &access.token_path {
            Some(path) => output.push_str(&format!(
                "    Token:    openshell sandbox exec -n {sandbox} --no-tty -- cat {}\n",
                terminal_text(path)
            )),
            None if token => output.push_str(
                "    Token:    unavailable; the deployment state records no runtime ID for this agent\n",
            ),
            None => {}
        }
        let port = access
            .port
            .map_or("PORT".to_owned(), |port| port.to_string());
        output.push_str(&match access.sign_in {
            SignIn::TokenInUrlFragment => format!(
                "    Sign in:  open http://127.0.0.1:{port}/#token=TOKEN, replacing TOKEN with the token\n"
            ),
            SignIn::BearerToken => "    Sign in:  send the header Authorization: Bearer TOKEN, replacing TOKEN with the token\n".into(),
            SignIn::None => "    Sign in:  none; anyone who can reach the forward can use it\n".into(),
            SignIn::SandboxExec => "    Sign in:  none; anyone who can run openshell sandbox exec in this workspace can open it\n".into(),
            SignIn::AdapterDocumented => "    Sign in:  see the adapter's documentation\n".into(),
        });
    }
    let (launchers, others): (Vec<_>, Vec<_>) = result
        .interfaces
        .iter()
        .partition(|access| access.sign_in == SignIn::SandboxExec);
    if !others.is_empty() {
        output.push_str(
            "  The agent's own tools can read these tokens and reach these ports; see docs/interfaces.md.\n",
        );
    }
    if !launchers.is_empty() {
        output.push_str(
            "  The agent's own tools can change a terminal launcher, and a terminal session's agent server listens in the sandbox without authentication; see docs/interfaces.md.\n",
        );
    }
    output
}

fn error_in_chain<'a, T: std::error::Error + 'static>(
    error: &'a (dyn std::error::Error + 'static),
) -> Option<&'a T> {
    let mut current = Some(error);
    while let Some(error) = current {
        if let Some(error) = error.downcast_ref::<T>() {
            return Some(error);
        }
        current = error.source();
    }
    None
}

pub(crate) fn error_exit_code(error: &(dyn std::error::Error + 'static)) -> u8 {
    if matches!(error_in_chain::<Error>(error), Some(Error::Cancelled)) {
        130
    } else {
        1
    }
}

pub(crate) fn render_output_error(
    error: &(dyn std::error::Error + 'static),
    context: &RenderContext,
) -> String {
    format!(
        "{} completed, but its result could not be reported.\n{}\n",
        context.operation,
        diagnostic_text(&error.to_string())
    )
}

fn diagnostic_text(value: &str) -> String {
    value
        .lines()
        .map(terminal_text)
        .collect::<Vec<_>>()
        .join("\n")
}

pub(crate) fn render_error(
    error: &(dyn std::error::Error + 'static),
    format: OutputFormat,
    context: &RenderContext,
) -> String {
    let sdk = error_in_chain::<Error>(error);
    let interrupted = matches!(sdk, Some(Error::Cancelled));
    let message = if interrupted {
        "Operation interrupted.".into()
    } else {
        diagnostic_text(&error.to_string())
    };
    let mut details = serde_json::json!({
        "outcome": if interrupted { "interrupted" } else { "failed" },
        "operation": context.operation,
        "stateDirectory": context.state_dir,
        "error": { "message": message },
    });
    context.add_warnings(&mut details);
    if let Some(input) = &context.input {
        details["input"] = serde_json::json!(input);
    }
    let remaining = match sdk {
        _ if !context.mutation_started.load(Ordering::Relaxed)
            && matches!(context.operation, "Apply" | "Destroy") =>
        {
            "No runtime resources changed."
        }
        Some(Error::SandboxStartup { .. }) => "Resources retained; sandbox startup failed.",
        _ if matches!(context.operation, "Apply" | "Destroy") => {
            "Resource state is not confirmed. Changes may already have been made; preserve the deployment state directory."
        }
        _ => "",
    };
    if !remaining.is_empty() {
        details["remainingState"] = serde_json::json!(remaining);
    }
    let help = match sdk {
        Some(Error::SandboxStartup { .. }) => Some(Cow::Borrowed(
            "Inspect the sandbox with OpenShell using this deployment's gateway and workspace; collect gateway and supervisor logs before cleanup.",
        )),
        Some(Error::DockerModelUpdateRefused { service }) => Some(Cow::Owned(format!(
            "To replace the running model container, set spec.services.{service}.updatePolicy: Recreate and apply again; the model is unavailable until the replacement starts. See docs/inference.md#set-container-limits-and-update-policy."
        ))),
        _ => None,
    };
    if let Some(help) = &help {
        details["help"] = serde_json::json!(help);
    }
    match format {
        OutputFormat::Json => format!(
            "{}\n",
            serde_json::to_string_pretty(&details).expect("JSON values serialize")
        ),
        OutputFormat::Text => {
            let mut output = format!(
                "{} {} · {}\n",
                context.operation,
                if interrupted { "interrupted" } else { "failed" },
                duration(context.started.elapsed())
            );
            output = context.error_palette.paint(
                &output,
                if interrupted {
                    Tone::Warning
                } else {
                    Tone::Error
                },
            );
            if let Some(input) = &context.input {
                output.push_str(&format!(
                    "Input: {}\n",
                    terminal_text(&input.display().to_string())
                ));
            }
            output.push_str(&format!(
                "State: {}\n\n{message}\n",
                terminal_text(&context.state_dir.display().to_string())
            ));
            if !remaining.is_empty() {
                output.push_str(&format!("\n{remaining}\n"));
            }
            if let Some(help) = help {
                output.push_str(&format!("\n{}\n", terminal_text(&help)));
            }
            context.append_warnings(&mut output);
            output
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::Parser;
    use serde_json::{Value, json};

    fn render(args: &[&str], result: Value) -> String {
        let cli = Cli::try_parse_from(args).unwrap();
        super::render(
            CommandResult::Operation(serde_json::from_value(result).unwrap()),
            cli.command.output_format(),
            &RenderContext::new(&cli),
        )
        .unwrap()
    }

    #[test]
    fn warnings_survive_hidden_progress_and_successful_or_failed_json_output() {
        let message = "Service qwen relies on NetworkPolicy enforcement.\u{1b}[2J";
        for command in ["plan", "apply"] {
            let cli = Cli::try_parse_from(["nemoclaw", "--progress", "off", command, "model.yaml"])
                .unwrap();
            let context = RenderContext::new(&cli);
            let progress = context.progress(Arc::new(|_| {}));
            progress(nemoclaw_sdk::Progress::Warning {
                message: message.into(),
            });
            progress(nemoclaw_sdk::Progress::Warning {
                message: message.into(),
            });
            let result: OperationResult = serde_json::from_value(json!({"outcome":if command == "plan" {"planned"} else {"succeeded"}, "changes":[]})).unwrap();
            let text = super::render(
                CommandResult::Operation(Box::new(result.clone())),
                OutputFormat::Text,
                &context,
            )
            .unwrap();
            assert!(text.contains("NetworkPolicy"), "{text}");
            assert!(!text.contains('\u{1b}'));
            let machine: Value = serde_json::from_str(
                &super::render(
                    CommandResult::Operation(Box::new(result)),
                    OutputFormat::Json,
                    &context,
                )
                .unwrap(),
            )
            .unwrap();
            assert_eq!(machine["warnings"], json!([message]));
            let error = Error::Bundle("bundle unavailable");
            let failed = render_error(&error, OutputFormat::Text, &context);
            assert!(failed.contains("NetworkPolicy"));
            assert!(!failed.contains('\u{1b}'));
            let failed: Value =
                serde_json::from_str(&render_error(&error, OutputFormat::Json, &context)).unwrap();
            assert_eq!(failed["warnings"], json!([message]));
        }
    }

    fn interfaces() -> Value {
        json!([
            {"sandbox": "assistant", "interface": "dashboard", "port": 18789,
             "tokenPath": "/sandbox/artifacts/.fabric/openclaw/runtimes/rt-1/interfaces/dashboard.token",
             "signIn": "token_in_url_fragment"},
            {"sandbox": "reviewer", "interface": "api", "port": 8642,
             "tokenPath": "/sandbox/artifacts/.fabric/hermes/runtimes/rt-2/interfaces/api.token",
             "signIn": "bearer_token"},
            {"sandbox": "reviewer", "interface": "dashboard", "port": 9119, "signIn": "none"}
        ])
    }

    /// After apply, each enabled interface gets its forward, the command that
    /// reads its token, and its sign-in, under this deployment's gateway and
    /// workspace selection. The output names where the token is, never a token.
    #[test]
    fn apply_output_tells_how_to_reach_each_interface() {
        let connection = json!({"gatewayEndpoint": "http://127.0.0.1:17671", "workspace": "nc-1234567890abcdef"});
        let result = json!({"outcome": "succeeded", "changes": [], "connection": connection, "interfaces": interfaces()});
        let text = render(&["nemoclaw", "apply", "deployment.yaml"], result.clone());
        let lines: Vec<&str> = text.lines().map(str::trim).collect();
        for expected in [
            "unset OPENSHELL_GATEWAY",
            "export OPENSHELL_GATEWAY_ENDPOINT=http://127.0.0.1:17671",
            "export OPENSHELL_WORKSPACE=nc-1234567890abcdef",
            "Forward: openshell forward service assistant --target-port 18789 --local 127.0.0.1:18789",
            "Token: openshell sandbox exec -n assistant --no-tty -- cat /sandbox/artifacts/.fabric/openclaw/runtimes/rt-1/interfaces/dashboard.token",
            "Sign in: open http://127.0.0.1:18789/#token=TOKEN, replacing TOKEN with the token",
            "Forward: openshell forward service reviewer --target-port 8642 --local 127.0.0.1:8642",
            "Token: openshell sandbox exec -n reviewer --no-tty -- cat /sandbox/artifacts/.fabric/hermes/runtimes/rt-2/interfaces/api.token",
            "Sign in: send the header Authorization: Bearer TOKEN, replacing TOKEN with the token",
            "Forward: openshell forward service reviewer --target-port 9119 --local 127.0.0.1:9119",
            "Sign in: none; anyone who can reach the forward can use it",
        ] {
            assert!(
                lines
                    .iter()
                    .any(|line| line.split_whitespace().collect::<Vec<_>>().join(" ") == expected),
                "missing {expected:?}:\n{text}"
            );
        }
        // Only the two interfaces with a token get a command that reads one.
        assert_eq!(text.matches("sandbox exec").count(), 2, "{text}");
        let machine: Value = serde_json::from_str(&render(
            &["nemoclaw", "apply", "deployment.yaml", "-o", "json"],
            result,
        ))
        .unwrap();
        assert_eq!(machine["interfaces"], interfaces());
    }

    /// A gateway the client can't reach as plaintext loopback is selected by
    /// its OpenShell profile, which NemoClaw doesn't know.
    #[test]
    fn interface_access_selects_a_remote_gateway_by_profile() {
        let connection = json!({"gatewayEndpoint": "https://gateway.example:443", "workspace": "nc-1234567890abcdef"});
        let result = json!({"outcome": "succeeded", "changes": [], "connection": connection, "interfaces": interfaces()});
        let text = render(&["nemoclaw", "apply", "deployment.yaml"], result);
        assert!(
            text.contains("unset OPENSHELL_GATEWAY_ENDPOINT\n"),
            "{text}"
        );
        assert!(
            text.contains("export OPENSHELL_GATEWAY=REPLACE_WITH_PROFILE_NAME"),
            "{text}"
        );
        assert!(text.contains("https://gateway.example:443"), "{text}");
        assert!(
            !text.contains("export OPENSHELL_GATEWAY_ENDPOINT"),
            "{text}"
        );
    }

    /// A terminal interface gets the command that opens it with the current
    /// runtime's launcher, and its `sh` form for a `noexec` mount, under the
    /// same gateway selection; it has no forward and no token.
    #[test]
    fn apply_output_tells_how_to_open_a_terminal_interface() {
        let launcher =
            "/sandbox/artifacts/.fabric/deepagents-code/runtimes/rt-3/interfaces/terminal";
        let interfaces = json!([{"sandbox": "assistant", "interface": "terminal",
            "launcher": launcher, "signIn": "sandbox_exec"}]);
        let connection = json!({"gatewayEndpoint": "http://127.0.0.1:17671", "workspace": "nc-1234567890abcdef"});
        let result = json!({"outcome": "succeeded", "changes": [], "connection": connection, "interfaces": interfaces});
        let text = render(&["nemoclaw", "apply", "deployment.yaml"], result.clone());
        let lines: Vec<String> = text
            .lines()
            .map(|line| line.split_whitespace().collect::<Vec<_>>().join(" "))
            .collect();
        for expected in [
            "unset OPENSHELL_GATEWAY".to_owned(),
            "export OPENSHELL_GATEWAY_ENDPOINT=http://127.0.0.1:17671".to_owned(),
            "export OPENSHELL_WORKSPACE=nc-1234567890abcdef".to_owned(),
            "assistant/terminal".to_owned(),
            format!("Open: openshell sandbox exec -n assistant --tty -- {launcher}"),
            format!("(on a noexec mount: openshell sandbox exec -n assistant --tty -- sh {launcher})"),
            "Sign in: none; anyone who can run openshell sandbox exec in this workspace can open it"
                .to_owned(),
        ] {
            assert!(lines.contains(&expected), "missing {expected:?}:\n{text}");
        }
        for absent in ["openshell forward", "Token:", "--no-tty", "these tokens"] {
            assert!(!text.contains(absent), "unexpected {absent:?}:\n{text}");
        }
        assert!(text.contains("change a terminal launcher"), "{text}");
        let machine: Value = serde_json::from_str(&render(
            &["nemoclaw", "apply", "deployment.yaml", "-o", "json"],
            result,
        ))
        .unwrap();
        assert_eq!(machine["interfaces"], interfaces);

        // Without the runtime's ID, there is no launcher path to run.
        let result = json!({"outcome": "succeeded", "changes": [], "connection": connection,
            "interfaces": [{"sandbox": "assistant", "interface": "terminal", "signIn": "sandbox_exec"}]});
        let text = render(&["nemoclaw", "apply", "deployment.yaml"], result);
        assert!(
            text.contains("Open:     unavailable; the deployment state records no runtime ID"),
            "{text}"
        );
        assert!(!text.contains("--tty"), "{text}");
    }

    #[test]
    fn results_without_interfaces_show_no_interface_access() {
        let connection = json!({"gatewayEndpoint": "http://127.0.0.1:17671", "workspace": "nc-1234567890abcdef"});
        let result = json!({"outcome": "succeeded", "changes": [], "connection": connection});
        let text = render(&["nemoclaw", "apply", "deployment.yaml"], result);
        assert!(!text.contains("openshell forward"), "{text}");
        assert!(!text.contains("OPENSHELL_WORKSPACE"), "{text}");
    }

    #[test]
    fn connection_output_identifies_the_gateway_and_workspace_without_claiming_access() {
        for (command, outcome) in [("plan", "planned"), ("apply", "succeeded")] {
            let connection = json!({
                "gatewayEndpoint": "https://gateway.example:443",
                "workspace": "nc-1234567890abcdef"
            });
            let result = json!({"outcome": outcome, "changes": [], "connection": connection});
            let text = render(&["nemoclaw", command, "deployment.yaml"], result.clone());
            assert!(
                text.contains("OpenShell gateway: https://gateway.example:443\n"),
                "{text}"
            );
            assert!(
                text.contains("OpenShell workspace: nc-1234567890abcdef\n"),
                "{text}"
            );
            assert!(!text.contains("access verified"));
            let machine: Value = serde_json::from_str(&render(
                &["nemoclaw", command, "deployment.yaml", "-o", "json"],
                result,
            ))
            .unwrap();
            assert_eq!(machine["connection"], connection);
        }
    }

    #[test]
    fn apply_lists_service_urls_after_the_connection_and_names_the_unnamed_endpoint() {
        let urls = json!({
            "assistant": {
                "": "http://ws--assistant.services.example/",
                "dashboard": "http://ws--assistant--dashboard.services.example/\u{1b}[2J"
            },
            "reviewer": {"api": "http://ws--reviewer--api.services.example/"}
        });
        let result = json!({"outcome": "succeeded", "changes": [], "connection": {
            "gatewayEndpoint": "https://gateway.example:443", "workspace": "ws"
        }, "serviceUrls": urls});
        let text = render(&["nemoclaw", "apply", "deployment.yaml"], result.clone());
        assert!(
            text.contains(
                "OpenShell workspace: ws\n\nService URLs:\n  \
                 assistant: http://ws--assistant.services.example/\n  \
                 assistant/dashboard: http://ws--assistant--dashboard.services.example/\\u{1b}[2J\n  \
                 reviewer/api: http://ws--reviewer--api.services.example/\n"
            ),
            "{text}"
        );
        assert!(!text.contains('\u{1b}'));
        let machine: Value = serde_json::from_str(&render(
            &["nemoclaw", "apply", "deployment.yaml", "-o", "json"],
            result,
        ))
        .unwrap();
        assert_eq!(machine["serviceUrls"], urls);
        let none = render(
            &["nemoclaw", "apply", "deployment.yaml"],
            json!({"outcome": "succeeded", "changes": []}),
        );
        assert!(!none.contains("Service URLs"), "{none}");
    }

    #[test]
    fn colored_results_keep_destructive_actions_explicit_and_json_unstyled() {
        let cli = Cli::try_parse_from(["nemoclaw", "destroy"]).unwrap();
        let mut context = RenderContext::new(&cli);
        context.output_palette = Palette { enabled: true };
        let value = json!({
            "outcome": "destroyed",
            "changes": [{"resource": "openshell_sandbox.assistant", "actions": ["delete"]}],
            "retained": ["docker_volume.inference_storage_inference_qwen"]
        });
        let colored = super::render(
            CommandResult::Operation(serde_json::from_value(value.clone()).unwrap()),
            OutputFormat::Text,
            &context,
        )
        .unwrap();
        assert!(colored.contains("\x1b[38;2;118;185;0mDestroy complete"));
        assert!(colored.contains("\x1b[33mdelete\x1b[0m  sandbox/assistant"));
        assert!(colored.contains("\x1b[33mSandbox files and conversation history deleted.\x1b[0m"));
        let machine = super::render(
            CommandResult::Operation(serde_json::from_value(value).unwrap()),
            OutputFormat::Json,
            &context,
        )
        .unwrap();
        assert!(!machine.contains('\x1b'));
        assert_eq!(
            serde_json::from_str::<Value>(&machine).unwrap()["outcome"],
            "destroyed"
        );
    }

    #[test]
    fn resource_results_name_authored_sources_and_separate_deferred_work() {
        let result = json!({"outcome":"planned", "changes":[
            {"resource":"fabric_agent.host", "actions":["update"]},
            {"resource":"terraform_data.agent_host", "actions":["update"]},
            {"resource":"openshell_inference.inference_local-1234", "actions":["update"]},
            {"resource":"openshell_web_search.tavily_1234_search_key", "actions":["create"]},
            {"resource":"vllm_credential_storage.inference_tiny_auth", "actions":["create"]},
            {"resource":"docker_container.ollama_proxy_local", "actions":["create"]},
            {"resource":"ollama_proxy_credential_storage.local", "actions":["create"]}
        ], "resourceSources": {
            "openshell_inference.inference_local-1234":{"name":"responses", "path":"spec.sandboxes[host].inferenceProviders[responses]"}
        }, "deferred":["Gateway is required"], "discovery":{"resources":[
            {"address":"fabric_agent.host", "scope":"deployment", "existed":true, "plannedActions":["update"], "drifted":true, "retained":false, "reusePlanned":false},
            {"address":"openshell_inference.inference_local-1234", "scope":"deployment", "existed":true, "plannedActions":["update"], "drifted":false, "retained":false, "reusePlanned":false},
            {"address":"docker_container.managed_gateway_runtime", "scope":"runtime", "existed":true, "plannedActions":["no-op"], "drifted":true, "retained":false, "reusePlanned":false}
        ]}});
        let text = render(&["nemoclaw", "plan", "spark.yaml"], result.clone());
        for expected in [
            "agent runtime/host",
            "agent configuration/host",
            "provider/responses at spec.sandboxes[host].inferenceProviders[responses]",
            "web search/tavily",
            "inference credentials/tiny",
            "ollama proxy/local",
            "proxy credentials/local",
            "Resources: 3 established (1 unchanged, 2 with planned changes); 0 new.",
            "Refresh differences: 2 resources; may include computed metadata.",
        ] {
            assert!(text.contains(expected), "missing {expected}: {text}");
        }
        assert!(!text.contains("1234"), "{text}");
        assert!(!text.contains("terraform_data"), "{text}");
        assert!(!text.contains("3 unchanged"));
        let verbose = render(
            &["nemoclaw", "plan", "spark.yaml", "--verbose"],
            result.clone(),
        );
        assert!(verbose.contains("openshell_inference.inference_local-1234"));
        let json: Value = serde_json::from_str(&render(
            &["nemoclaw", "plan", "spark.yaml", "-o", "json"],
            result.clone(),
        ))
        .unwrap();
        assert_eq!(json["resourceSources"], result["resourceSources"]);
    }

    #[test]
    fn creation_labels_do_not_imply_sandbox_deletion_or_retention() {
        let result = json!({"outcome":"planned","changes":[
            {"resource":"openshell_workspace.deployment","actions":["create"]},
            {"resource":"openshell_gateway_storage.runtime","actions":["create"]}
        ]});
        let text = render(&["nemoclaw", "plan", "spark.yaml"], result);
        assert!(text.contains("create  OpenShell workspace\n"), "{text}");
        assert!(text.contains("create  gateway storage\n"), "{text}");
        assert!(!text.contains("sandbox files"), "{text}");
        assert!(!text.contains("retained"), "{text}");
    }

    #[test]
    fn plan_discovery_shows_reuse_and_metadata_without_claiming_inference_readiness() {
        let result = json!({"outcome":"planned","changes":[],"discovery":{
            "observations":{"endpoint_0":{"kind":"inference","observation":{"status":"available","reason":null,"source":"control_host_http_models","reachable":true,"authentication":"not_required","models":["advertised-model"],"api_verified":false}}},
            "credentials":[{"reference":"MODEL_KEY","status":"available","reason":null}],
            "resources":[{"address":"docker_volume.example","scope":"runtime","existed":true,"plannedActions":["no-op"],"drifted":false,"retained":true,"reusePlanned":true}]
        }});
        let text = render(&["nemoclaw", "plan", "spark.yaml"], result.clone());
        assert!(
            text.contains("Resources: 1 established (1 unchanged, 0 with planned changes); 0 new."),
            "{text}"
        );
        assert!(
            text.contains("1 advertised model; inference unverified"),
            "{text}"
        );
        assert!(!text.contains("inference ready"));
        let json: Value = serde_json::from_str(&render(
            &["nemoclaw", "plan", "spark.yaml", "-o", "json"],
            result,
        ))
        .unwrap();
        assert_eq!(json["discovery"]["resources"][0]["reusePlanned"], true);
        assert_eq!(
            json["discovery"]["observations"]["endpoint_0"]["observation"]["api_verified"],
            false
        );
    }

    #[test]
    fn unverified_checks_remain_visible_without_making_a_resource_plan_incomplete() {
        let result = json!({"outcome":"planned","changes":[],"unverified":["Service readiness is checked during apply.","Catalog unavailable\u{1b}[2J"]});
        let text = render(&["nemoclaw", "plan", "model.yaml"], result.clone());
        assert!(text.contains("No resource changes planned."), "{text}");
        assert!(text.contains("Unverified checks:"), "{text}");
        assert!(text.contains("Service readiness is checked during apply."));
        assert!(!text.contains("Plan incomplete"));
        assert!(!text.contains('\u{1b}'));
        let output: Value = serde_json::from_str(&render(
            &["nemoclaw", "plan", "model.yaml", "-o", "json"],
            result.clone(),
        ))
        .unwrap();
        assert_eq!(output["complete"], true);
        assert_eq!(output["unverified"], result["unverified"]);
        let mut blocked = result;
        blocked["deferred"] = json!(["Gateway inventory unavailable"]);
        let text = render(&["nemoclaw", "plan", "model.yaml"], blocked.clone());
        assert!(text.contains("Plan incomplete"));
        assert!(text.contains("Unverified checks:"));
        let output: Value = serde_json::from_str(&render(
            &["nemoclaw", "plan", "model.yaml", "-o", "json"],
            blocked,
        ))
        .unwrap();
        assert_eq!(output["complete"], false);
    }

    #[test]
    fn incomplete_plan_never_claims_no_changes() {
        let result =
            json!({"outcome":"planned","changes":[],"deferred":["Gateway inventory unavailable"]});
        let text = render(&["nemoclaw", "plan", "spark.yaml"], result.clone());
        assert!(text.contains("Plan incomplete"));
        assert!(!text.contains("No resource changes planned"));
        assert!(text.contains("Gateway inventory unavailable"));
        let json: Value = serde_json::from_str(&render(
            &["nemoclaw", "plan", "spark.yaml", "-o", "json"],
            result,
        ))
        .unwrap();
        assert_eq!(json["complete"], false);
    }

    #[test]
    fn actions_and_unknown_addresses_are_never_lost() {
        let result = json!({"outcome":"planned","changes":[
            {"resource":"openshell_sandbox.assistant","actions":["delete","create"]},
            {"resource":"future_provider.unknown","actions":["new-action"]}]});
        let text = render(&["nemoclaw", "plan", "spark.yaml"], result.clone());
        for expected in [
            "2 OpenTofu resources",
            "sandbox/assistant",
            "delete → create",
            "Deletes sandbox files and conversation history",
            "future_provider.unknown",
            "new-action",
        ] {
            assert!(text.contains(expected), "missing {expected}: {text}");
        }
        let verbose = render(&["nemoclaw", "plan", "spark.yaml", "--verbose"], result);
        assert!(verbose.contains("openshell_sandbox.assistant"));
    }

    #[test]
    fn a_planned_replacement_shows_its_reason() {
        let reason = "sandbox exited: SANDBOX_PHASE_ERROR, reason ContainerExited, exit code 1";
        let text = render(
            &["nemoclaw", "plan", "spark.yaml"],
            json!({"outcome":"planned","changes":[
                {"resource":"openshell_sandbox.assistant","actions":["delete","create"],"reason":reason}]}),
        );
        assert!(text.contains(reason), "{text}");
    }

    #[test]
    fn image_bindings_group_by_ordered_actions_and_explain_retention() {
        let result = json!({"outcome":"planned", "changes":[
            {"resource":"docker_image.image_opaque_first", "actions":["delete"]},
            {"resource":"docker_image.image_opaque_second", "actions":["delete"]},
            {"resource":"docker_image.image_opaque_replacement", "actions":["delete", "create"]},
            {"resource":"future_provider.unknown", "actions":["delete"]}
        ]});
        let text = render(&["nemoclaw", "plan", "--destroy"], result.clone());
        assert!(text.contains("4 OpenTofu resources"));
        assert!(text.contains("delete  2 image bindings"));
        assert!(text.contains("delete → create  1 image binding"));
        assert!(text.contains("future_provider.unknown"));
        assert!(!text.contains("opaque_"));
        assert!(text.contains("Downloaded images and local deployment state will be retained."));
        let verbose = render(&["nemoclaw", "plan", "--destroy", "--verbose"], result);
        for name in ["first", "second", "replacement"] {
            assert!(verbose.contains(&format!("docker_image.image_opaque_{name}")));
        }
    }

    #[test]
    fn destroy_separates_sandbox_loss_from_retained_data() {
        let text = render(
            &["nemoclaw", "plan", "--destroy"],
            json!({"outcome":"planned","changes":[{"resource":"openshell_sandbox.assistant","actions":["delete"]}],"retained":["docker_volume.inference_storage_inference_qwen"]}),
        );
        let (remove, keep) = text.split_once("Retained resources:").unwrap();
        assert!(remove.contains("Deletes sandbox files"));
        assert!(keep.contains("model cache/qwen"));
    }

    #[test]
    fn a_completed_apply_does_not_claim_responses_and_json_keeps_sdk_facts() {
        let result = json!({"outcome":"succeeded","changes":[]});
        let text = render(&["nemoclaw", "apply", "spark.yaml"], result.clone());
        assert!(text.contains("Apply complete"));
        assert!(text.contains("responses were not tested"));
        let json: Value = serde_json::from_str(&render(
            &["nemoclaw", "apply", "spark.yaml", "-o", "json"],
            result.clone(),
        ))
        .unwrap();
        assert_eq!(json, result);
    }

    #[test]
    fn repeated_destroy_has_a_readable_completion() {
        let text = render(
            &["nemoclaw", "destroy"],
            json!({"outcome":"destroyed","changes":[],"retained":["openshell_workspace.deployment"]}),
        );
        assert!(text.contains("Destroy complete"));
        assert!(text.contains("Nothing to remove. Retained data unchanged."));
    }

    #[test]
    fn failures_share_honest_state_and_interruption_does_not_suggest_apply() {
        let cli = Cli::try_parse_from(["nemoclaw", "destroy"]).unwrap();
        let context = RenderContext::new(&cli);
        context.progress(Arc::new(|_| {}))(nemoclaw_sdk::Progress::MutationStarted);
        let text = render_error(&Error::Cancelled, OutputFormat::Text, &context);
        assert!(text.contains("Destroy interrupted"));
        assert!(text.contains("Changes may already have been made"));
        assert!(!text.contains("reapply"));
        assert_eq!(error_exit_code(&Error::Cancelled), 130);
        let json: Value = serde_json::from_str(&render_error(
            &Error::Cancelled,
            OutputFormat::Json,
            &context,
        ))
        .unwrap();
        assert_eq!(json["outcome"], "interrupted");
        assert_eq!(
            json["remainingState"],
            "Resource state is not confirmed. Changes may already have been made; preserve the deployment state directory."
        );
    }

    #[test]
    fn rejected_health_uses_ordinary_failure_output_and_preserves_state_warning() {
        let cli = Cli::try_parse_from(["nemoclaw", "apply", "spark.yaml"]).unwrap();
        let context = RenderContext::new(&cli);
        context.progress(Arc::new(|_| {}))(nemoclaw_sdk::Progress::MutationStarted);
        let error = Error::Conflict("invalid Fabric health response; resources retained");
        let text = render_error(&error, OutputFormat::Text, &context);
        for expected in [
            "Apply failed",
            "Input: spark.yaml",
            "invalid Fabric health response",
            "preserve the deployment state directory",
        ] {
            assert!(text.contains(expected), "missing {expected}: {text}");
        }
        let json: Value =
            serde_json::from_str(&render_error(&error, OutputFormat::Json, &context)).unwrap();
        assert_eq!(json["outcome"], "failed");
        assert_eq!(json["error"], json!({"message": error.to_string()}));
        assert!(json.get("help").is_none());
        assert_eq!(
            json["remainingState"],
            "Resource state is not confirmed. Changes may already have been made; preserve the deployment state directory."
        );
    }

    #[test]
    fn docker_model_refusal_names_the_service_update_policy_field() {
        for command in ["plan", "apply"] {
            let cli = Cli::try_parse_from(["nemoclaw", command, "spark.yaml"]).unwrap();
            let context = RenderContext::new(&cli);
            let error = Error::DockerModelUpdateRefused {
                service: "qwen".into(),
            };
            let json: Value =
                serde_json::from_str(&render_error(&error, OutputFormat::Json, &context)).unwrap();
            let help = json["help"].as_str().unwrap();
            for expected in [
                "spec.services.qwen.updatePolicy: Recreate",
                "docs/inference.md#set-container-limits-and-update-policy",
            ] {
                assert!(help.contains(expected), "missing {expected}: {help}");
            }
            let text = render_error(&error, OutputFormat::Text, &context);
            assert!(text.contains(help), "{text}");
        }
    }

    /// Safe native diagnostics must survive either presentation independently
    /// of the progress display. Native failure tests establish their producer.
    #[test]
    fn native_execution_failure_context_and_mutation_facts_survive_both_formats() {
        let error = Error::Execution {
            operation: "apply".into(),
            diagnostic: "sandbox/coder start failed (pi_model_unknown); agent runtime is unavailable; resources retained".into(),
            postcondition_failures: None,
        };
        for mutated in [false, true] {
            let cli =
                Cli::try_parse_from(["nemoclaw", "apply", "pi.yaml", "--progress", "off"]).unwrap();
            let context = RenderContext::new(&cli);
            if mutated {
                context.progress(Arc::new(|_| {}))(nemoclaw_sdk::Progress::MutationStarted);
            }
            assert_eq!(error_exit_code(&error), 1);
            for format in [OutputFormat::Text, OutputFormat::Json] {
                let rendered = render_error(&error, format, &context);
                let (message, remaining) = match format {
                    OutputFormat::Json => {
                        let report: Value = serde_json::from_str(&rendered).unwrap();
                        assert_eq!(report["outcome"], "failed");
                        assert_eq!(report["operation"], "Apply");
                        assert_eq!(report["input"], "pi.yaml");
                        (
                            report["error"]["message"].as_str().unwrap().to_owned(),
                            report["remainingState"].as_str().unwrap().to_owned(),
                        )
                    }
                    OutputFormat::Text => {
                        assert!(rendered.contains("Apply failed"), "{rendered}");
                        assert!(rendered.contains("Input: pi.yaml"), "{rendered}");
                        (rendered.clone(), rendered)
                    }
                };
                for expected in [
                    "sandbox/coder",
                    "start",
                    "pi_model_unknown",
                    "agent runtime is unavailable",
                    "resources retained",
                ] {
                    assert!(message.contains(expected), "missing {expected}: {message}");
                }
                if mutated {
                    assert!(
                        remaining.contains("Changes may already have been made"),
                        "{remaining}"
                    );
                    assert!(
                        !remaining.contains("No runtime resources changed"),
                        "{remaining}"
                    );
                } else {
                    assert!(
                        remaining.contains("No runtime resources changed"),
                        "{remaining}"
                    );
                    assert!(
                        !remaining.contains("Changes may already have been made"),
                        "{remaining}"
                    );
                }
            }
        }
    }

    #[test]
    fn later_preflight_failure_does_not_erase_prior_mutations() {
        let cli =
            Cli::try_parse_from(["nemoclaw", "apply", "spark.yaml", "--progress", "off"]).unwrap();
        let context = RenderContext::new(&cli);
        let error = nemoclaw_sdk::config::ConfigError::new("later-stage validation failed");
        let observe = context.progress(Arc::new(|_| {}));
        observe(nemoclaw_sdk::Progress::MutationStarted);
        observe(nemoclaw_sdk::Progress::Planning);
        for format in [OutputFormat::Text, OutputFormat::Json] {
            let report = render_error(&error, format, &context);
            assert!(report.contains("Changes may already have been made"));
            assert!(!report.contains("No runtime resources changed"));
        }
    }

    #[test]
    fn configuration_failure_does_not_imply_partial_apply() {
        let cli = Cli::try_parse_from(["nemoclaw", "apply", "spark.yaml"]).unwrap();
        let error = nemoclaw_sdk::config::ConfigError::new("missing apiVersion");
        let text = render_error(&error, OutputFormat::Text, &RenderContext::new(&cli));
        assert!(text.contains("No runtime resources changed."));
        assert!(!text.contains("Changes may already have been made"));
    }

    #[test]
    fn complete_plan_is_explicit_in_json_and_empty_plan_is_not_health() {
        let result = json!({"outcome":"planned", "changes":[]});
        let text = render(&["nemoclaw", "plan", "spark.yaml"], result.clone());
        assert!(text.contains("No resource changes planned."));
        assert!(!text.contains("healthy"));
        let value: Value = serde_json::from_str(&render(
            &["nemoclaw", "plan", "spark.yaml", "-o", "json"],
            result,
        ))
        .unwrap();
        assert_eq!(value["complete"], true);
    }

    #[test]
    fn output_failure_does_not_relabel_successful_operation() {
        let cli = Cli::try_parse_from(["nemoclaw", "apply", "spark.yaml"]).unwrap();
        let error = std::io::Error::new(std::io::ErrorKind::BrokenPipe, "closed output stream");
        let text = render_output_error(&error, &RenderContext::new(&cli));
        assert!(text.contains("Apply completed, but its result could not be reported"));
        assert!(!text.contains("Apply failed"));
        assert!(!text.contains("Resource state is not confirmed"));
    }

    #[test]
    fn multiline_diagnostics_keep_lines_without_terminal_control_sequences() {
        let cli = Cli::try_parse_from(["nemoclaw", "apply", "spark.yaml"]).unwrap();
        let error = Error::Execution {
            operation: "apply".into(),
            diagnostic: "first line\nnext line\u{1b}[2J".into(),
            postcondition_failures: None,
        };
        let text = render_error(&error, OutputFormat::Text, &RenderContext::new(&cli));
        assert!(text.contains("first line\nnext line"));
        assert!(!text.contains('\u{1b}'));
    }

    #[test]
    fn terminal_controls_cannot_overwrite_output() {
        let result = json!({"outcome":"planned","changes":[{"resource":"evil\u{1b}[2J\nresource","actions":["create\rspoof"]}]});
        let text = render(&["nemoclaw", "plan", "spark.yaml"], result);
        assert!(!text.contains('\u{1b}'));
        assert!(!text.contains('\r'));
        assert!(text.contains("\\nresource"));
        assert!(!terminal_text("x\u{202e}y").contains('\u{202e}'));
        assert_eq!(duration(Duration::from_secs(667)), "11m 7s");
    }
}
