// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Shared terminal onboarding frontend for the native CLI and standalone example.
#[cfg(test)]
mod scenarios;
mod tui;

use nemoclaw_authoring::{Answers, Capabilities, Draft, Session};
use nemoclaw_sdk::{CancellationToken, Error, config::MAX_DOCUMENT_BYTES};
use std::{
    io::{IsTerminal, Read, Write},
    path::Path,
};

/// A template starts a new deployment; editing retains the existing identity.
pub enum Source<'a> {
    Defaults,
    Template(&'a Path),
    Edit(&'a Path),
}

/// Run the questionnaire and save to a new file. Cancellation writes nothing.
/// Engine checks are read-only; this never creates deployment state or applies resources.
pub async fn author(
    source: Source<'_>,
    output: &Path,
    cancel: &CancellationToken,
) -> Result<bool, Box<dyn std::error::Error>> {
    author_with_bundle(source, output, None, cancel).await
}

/// Author using read-only provider discovery when a verified bundle is available.
/// Without a bundle, target capabilities remain explicitly unverified.
pub async fn author_with_bundle(
    source: Source<'_>,
    output: &Path,
    bundle: Option<&Path>,
    cancel: &CancellationToken,
) -> Result<bool, Box<dyn std::error::Error>> {
    if cancel.is_cancelled() {
        return Err(Error::Cancelled.into());
    }
    let capabilities = Capabilities::available();
    let draft = load(source, &capabilities)?;
    if output.try_exists()? {
        return Err("output already exists; choose a new path with --output".into());
    }
    if !std::io::stdin().is_terminal() || !std::io::stderr().is_terminal() {
        return Err("onboarding requires a terminal on stdin and stderr".into());
    }
    let Some(draft) = tui::run(capabilities, draft, cancel, bundle).await? else {
        return Ok(false);
    };
    if cancel.is_cancelled() {
        return Err(Error::Cancelled.into());
    }
    let review = draft.review()?;
    write_path(output, review.yaml().as_bytes())?;
    Ok(true)
}

fn load(
    source: Source<'_>,
    capabilities: &Capabilities,
) -> Result<Draft, Box<dyn std::error::Error>> {
    let draft = match source {
        Source::Defaults => {
            let authored =
                Session::new()?.project(capabilities, &Answers::onboarding_defaults())?;
            Draft::from_document(authored.document().clone())?
        }
        Source::Edit(path) => read_draft(path)?,
        Source::Template(path) => {
            let original = read_draft(path)?;
            let capabilities = capabilities.preserving_draft(&original)?;
            let answers = original.guided_answers(&capabilities)?;
            let authored = Session::new()?.project(&capabilities, &answers)?;
            Draft::from_document(authored.document().clone())?
        }
    };
    capabilities.preserving_draft(&draft)?;
    Ok(draft)
}

fn read_draft(path: &Path) -> Result<Draft, Box<dyn std::error::Error>> {
    let mut bytes = Vec::new();
    std::fs::File::open(path)?
        .take(MAX_DOCUMENT_BYTES + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_DOCUMENT_BYTES {
        return Err("configuration exceeds 1 MiB".into());
    }
    Ok(Draft::from_yaml(&bytes)?)
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
    fn saved_unknown_harness_reopens_as_edit_and_template_without_losing_settings() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("unknown.yaml");
        let defaults = load(Source::Defaults, &Capabilities::available()).unwrap();
        let mut document = defaults.document().clone();
        let harness = document.spec.sandboxes[0].harness.as_mut().unwrap();
        harness.kind = "fixture-reopen-adapter".parse().unwrap();
        harness.settings = Some(
            [("custom_option".into(), "retained".into())]
                .into_iter()
                .collect(),
        );
        let yaml = serde_saphyr::to_string(&document).unwrap();
        std::fs::write(&path, &yaml).unwrap();
        let original = Draft::from_yaml(yaml.as_bytes()).unwrap();
        let capabilities = Capabilities::available();
        let edited = load(Source::Edit(&path), &capabilities).unwrap();
        assert_eq!(edited.document(), original.document());
        let retained = capabilities.preserving_draft(&edited).unwrap();
        assert_eq!(
            edited.guided_answers(&retained).unwrap().harness.as_str(),
            "fixture-reopen-adapter"
        );
        assert!(
            !retained
                .harnesses()
                .iter()
                .any(|harness| harness.as_str() == "fixture-reopen-adapter"),
            "retained intent is not advertised capability"
        );
        let template = load(Source::Template(&path), &capabilities).unwrap();
        assert_ne!(
            template.document().metadata.uid,
            original.document().metadata.uid
        );
        assert_eq!(
            template.document().spec.sandboxes,
            original.document().spec.sandboxes
        );
        assert_eq!(
            template.guided_answers(&retained).unwrap(),
            original.guided_answers(&retained).unwrap()
        );
    }

    #[test]
    fn generated_output_is_atomically_parseable() {
        let directory = tempfile::tempdir().unwrap();
        let output = directory.path().join("deployment.yaml");
        let capabilities = Capabilities::available();
        let authored = Session::new()
            .unwrap()
            .project(&capabilities, &Answers::onboarding_defaults())
            .unwrap();
        write_path(&output, authored.yaml().as_bytes()).unwrap();
        let document =
            nemoclaw_sdk::config::Document::parse(std::fs::File::open(&output).unwrap()).unwrap();
        assert_eq!(&document, authored.document());
    }

    #[test]
    fn oversized_edit_input_is_rejected() {
        let directory = tempfile::tempdir().unwrap();
        let input = directory.path().join("large.yaml");
        std::fs::write(&input, vec![b' '; (MAX_DOCUMENT_BYTES + 1) as usize]).unwrap();
        assert_eq!(
            read_draft(&input).unwrap_err().to_string(),
            "configuration exceeds 1 MiB"
        );
    }
    #[test]
    fn templates_get_a_new_identity_while_edits_keep_the_original() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("template.yaml");
        let capabilities = Capabilities::available();
        let original = load(Source::Defaults, &capabilities).unwrap();
        let yaml = original.review().unwrap().yaml().to_owned();
        std::fs::write(&path, &yaml).unwrap();
        let template = load(Source::Template(&path), &capabilities).unwrap();
        assert_ne!(
            template.document().metadata.uid,
            original.document().metadata.uid
        );
        assert_eq!(
            template.guided_answers(&capabilities).unwrap(),
            original.guided_answers(&capabilities).unwrap()
        );
        assert_eq!(
            load(Source::Edit(&path), &capabilities).unwrap().document(),
            original.document()
        );
        assert_eq!(std::fs::read_to_string(&path).unwrap(), yaml);
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
    fn template_with_additional_settings_is_rejected_without_discarding_them() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("template.yaml");
        let capabilities = Capabilities::available();
        let original = load(Source::Defaults, &capabilities).unwrap();
        let mut document = original.document().clone();
        document
            .spec
            .sandboxes
            .push(document.spec.sandboxes[0].clone());
        document.spec.sandboxes[1].name = "second".into();
        document.spec.sandboxes[1].agent.name = "second".into();
        let yaml = document.yaml().unwrap();
        std::fs::write(&path, &yaml).unwrap();
        assert!(load(Source::Template(&path), &capabilities).is_err());
        assert_eq!(std::fs::read_to_string(path).unwrap(), yaml);
    }

    #[test]
    fn bundled_template_is_supported_by_the_questionnaire() {
        let capabilities = Capabilities::available();
        let template = Path::new(env!("CARGO_MANIFEST_DIR")).join("../onboarding/openclaw.yaml");
        let draft = load(Source::Template(&template), &capabilities).unwrap();
        assert_eq!(
            draft.guided_answers(&capabilities).unwrap().model,
            "nvidia/nemotron-3-super-120b-a12b"
        );
    }
}

#[cfg(test)]
mod unsupported_templates {
    use super::*;

    #[test]
    fn managed_inference_templates_explain_the_questionnaires_limit() {
        for template in [
            "nemotron-amd64.yaml",
            "spark/vllm.yaml",
            "station/vllm.yaml",
            "spark/remote-vllm.yaml",
        ] {
            let path = Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("..")
                .join(template);
            let original = std::fs::read(&path).unwrap();
            let error = load(Source::Template(&path), &Capabilities::available())
                .unwrap_err()
                .to_string();
            assert!(
                error.contains("guided onboarding does not support managed inference services yet"),
                "{template}: {error}"
            );
            assert!(
                !error.contains("credential reference"),
                "{template}: {error}"
            );
            assert_eq!(std::fs::read(&path).unwrap(), original);
        }
    }
}
