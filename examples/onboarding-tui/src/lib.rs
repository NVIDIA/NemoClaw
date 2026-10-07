// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Shared terminal onboarding frontend for the native CLI and standalone example.
mod tui;
use nemoclaw_authoring::{Capabilities, new_deployment_uid};
use nemoclaw_authoring::{JourneyDefinition, JourneyScope, JourneyState, PartialDocument};
use nemoclaw_sdk::{CancellationToken, Error, config::MAX_DOCUMENT_BYTES};
use std::{
    io::{IsTerminal, Read, Write},
    path::Path,
};

/// Read-only defaults for a new deployment with a fresh identity.
pub enum Source<'a> {
    Defaults,
    Template(&'a Path),
}

/// Run the questionnaire and save to a new file. Cancellation writes nothing.
/// With `discover`, the target's engines, image, gateway, model catalog, and
/// credential references are read; without it, they remain explicitly
/// unverified. Reads never create deployment state or apply resources.
pub async fn author(
    source: Source<'_>,
    output: &Path,
    discover: bool,
    cancel: &CancellationToken,
) -> Result<bool, Box<dyn std::error::Error>> {
    if cancel.is_cancelled() {
        return Err(Error::Cancelled.into());
    }
    let capabilities = Capabilities::available();
    let state = load_journey(source, &capabilities)?;
    if output.try_exists()? {
        return Err("output already exists; choose a new path with --output".into());
    }
    if !std::io::stdin().is_terminal() || !std::io::stderr().is_terminal() {
        return Err("onboarding requires a terminal on stdin and stderr".into());
    }
    let Some(document) = tui::run(capabilities, state, cancel, discover).await? else {
        return Ok(false);
    };
    if cancel.is_cancelled() {
        return Err(Error::Cancelled.into());
    }
    write_path(output, document.yaml()?.as_bytes())?;
    Ok(true)
}

fn load_journey(
    source: Source<'_>,
    capabilities: &Capabilities,
) -> Result<JourneyState, Box<dyn std::error::Error>> {
    let bytes = match source {
        Source::Defaults => include_bytes!("../../../examples/onboarding/openclaw.yaml").to_vec(),
        Source::Template(path) => read_template(path)?,
    };
    let partial = PartialDocument::from_yaml(&bytes)?;
    let mut supplied = partial.supplied().clone();
    let metadata = supplied
        .as_object_mut()
        .ok_or("template root must be an object")?
        .entry("metadata")
        .or_insert_with(|| serde_json::json!({}));
    metadata
        .as_object_mut()
        .ok_or("template metadata must be an object")?
        .insert("uid".into(), serde_json::json!(new_deployment_uid()?));
    let partial = PartialDocument::from_yaml(&serde_json::to_vec(&supplied)?)?;
    JourneyDefinition::new("onboarding", partial)
        .ask([
            "/metadata/name",
            "/spec/sandboxes/0/harness/kind",
            "/spec/gateway/runtime/provider",
            "inference:preset",
        ])
        .ask([JourneyScope::InferenceApi])
        .ask([JourneyScope::RouteModels])
        .ask([JourneyScope::ActiveAdapterSettings])
        .ask([JourneyScope::NativeSettings])
        .ask([JourneyScope::DeploymentFields])
        .start(capabilities)
        .map_err(Into::into)
}

fn read_template(path: &Path) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    let mut bytes = Vec::new();
    std::fs::File::open(path)?
        .take(MAX_DOCUMENT_BYTES + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_DOCUMENT_BYTES {
        return Err("configuration exceeds 1 MiB".into());
    }
    Ok(bytes)
}

fn write_path(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let mut temporary = tempfile::NamedTempFile::new_in(parent)?;
    temporary.write_all(bytes)?;
    temporary.as_file().sync_all()?;
    temporary
        .persist_noclobber(path)
        .map_err(|error| error.error)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_source_starts_a_sparse_journey_with_existing_questions() {
        let capabilities = Capabilities::available();
        let journey = load_journey(Source::Defaults, &capabilities).unwrap();
        let resolution = journey.resolve(&capabilities).unwrap();
        assert!(resolution.question("/metadata/name").is_some());
        assert!(resolution.question("inference:preset").is_some());
        assert!(
            resolution
                .question("/spec/gateway/runtime/provider")
                .is_some()
        );
    }

    #[test]
    fn tui_accepts_a_resolved_question_through_journey_state() {
        let capabilities = Capabilities::available();
        let state = load_journey(Source::Defaults, &capabilities).unwrap();
        let mut wizard = tui::JourneyWizard::new(capabilities, state);
        assert_eq!(wizard.question().unwrap().unwrap().id(), "/metadata/name");
        wizard
            .submit(Some(serde_json::json!("guided-deployment")))
            .unwrap();
        assert_eq!(
            wizard.state().values().pointer("/metadata/name"),
            Some(&serde_json::json!("guided-deployment"))
        );
    }

    #[test]
    fn template_runs_replace_only_the_identity_and_preserve_the_source() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("template.yaml");
        let original = include_bytes!("../../../examples/onboarding/openclaw.yaml");
        std::fs::write(&path, original).unwrap();
        let capabilities = Capabilities::available();
        let first = load_journey(Source::Template(&path), &capabilities).unwrap();
        let second = load_journey(Source::Template(&path), &capabilities).unwrap();
        let mut first_values = first.values().clone();
        let first_uid = first_values.pointer("/metadata/uid").cloned().unwrap();
        let second_uid = second.values().pointer("/metadata/uid").cloned().unwrap();
        assert_ne!(first_uid, second_uid);
        first_values["metadata"]["uid"] = second_uid;
        assert_eq!(&first_values, second.values());
        assert_eq!(std::fs::read(&path).unwrap(), original);
    }

    #[test]
    fn sparse_template_input_enforces_size_and_single_sandbox_bounds() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("template.yaml");
        std::fs::write(&path, vec![b' '; (MAX_DOCUMENT_BYTES + 1) as usize]).unwrap();
        assert_eq!(
            read_template(&path).unwrap_err().to_string(),
            "configuration exceeds 1 MiB"
        );

        let mut values: serde_json::Value =
            serde_saphyr::from_slice(include_bytes!("../../../examples/onboarding/openclaw.yaml"))
                .unwrap();
        let second = values["spec"]["sandboxes"][0].clone();
        values["spec"]["sandboxes"]
            .as_array_mut()
            .unwrap()
            .push(second);
        let yaml = serde_json::to_vec(&values).unwrap();
        std::fs::write(&path, &yaml).unwrap();
        assert!(load_journey(Source::Template(&path), &Capabilities::available()).is_err());
        assert_eq!(std::fs::read(path).unwrap(), yaml);
    }

    #[test]
    fn unknown_adapter_template_keeps_authored_settings_and_reports_unverified_schema() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("unknown.yaml");
        let mut values: serde_json::Value =
            serde_saphyr::from_slice(include_bytes!("../../../examples/onboarding/openclaw.yaml"))
                .unwrap();
        values["spec"]["sandboxes"][0]["harness"] = serde_json::json!({
            "kind": "fixture-reopen-adapter",
            "settings": {"custom_option": "retained"}
        });
        std::fs::write(&path, serde_json::to_vec(&values).unwrap()).unwrap();
        let capabilities = Capabilities::available();
        let journey = load_journey(Source::Template(&path), &capabilities).unwrap();
        assert_eq!(
            journey
                .values()
                .pointer("/spec/sandboxes/0/harness/settings/custom_option"),
            Some(&serde_json::json!("retained"))
        );
        let resolution = journey.resolve(&capabilities).unwrap();
        assert!(
            resolution
                .unverified()
                .iter()
                .any(|reason| reason.contains("adapter schema"))
        );
        assert!(resolution.materialized_document().is_none());
    }

    #[test]
    fn saving_never_overwrites_the_template_or_an_existing_output() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("template.yaml");
        std::fs::write(&path, "original").unwrap();
        assert_eq!(
            write_path(&path, b"replacement").unwrap_err().kind(),
            std::io::ErrorKind::AlreadyExists
        );
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "original");
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 1);
    }

    #[test]
    fn bundled_template_is_supported_by_the_questionnaire() {
        let capabilities = Capabilities::available();
        let template = Path::new(env!("CARGO_MANIFEST_DIR")).join("../onboarding/openclaw.yaml");
        let state = load_journey(Source::Template(&template), &capabilities).unwrap();
        assert_eq!(
            state
                .values()
                .pointer("/spec/sandboxes/0/agent/inference/routes/0/overrides/model"),
            Some(&serde_json::json!("nvidia/nemotron-3-super-120b-a12b"))
        );
    }
}
