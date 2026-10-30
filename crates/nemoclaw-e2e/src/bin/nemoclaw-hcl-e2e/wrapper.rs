// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::process;
use nemoclaw_sdk::{
    CancellationToken, OperationResult, Outcome,
    bundle::{Bundle, executable},
    config::{Document, parse_yaml_value},
};
use serde_json::json;
use std::{
    collections::BTreeMap,
    ffi::OsString,
    fs,
    path::{Path, PathBuf},
    time::Duration,
};
use tokio::time::Instant;

/// Plan, apply, and verification share one bound, so a slow model start can use
/// time the other steps leave. Destroy has its own bound afterwards.
const RUN_DEADLINE: Duration = Duration::from_secs(45 * 60);
const DESTROY_DEADLINE: Duration = Duration::from_secs(10 * 60);

pub(super) struct Tools {
    pub candidate_revision: String,
    pub cli: PathBuf,
    pub tofu: PathBuf,
    pub probe: PathBuf,
    pub environment: BTreeMap<OsString, OsString>,
}

fn deployment(path: &Path) -> Result<Document, String> {
    let mut value =
        parse_yaml_value(fs::File::open(path).map_err(|_| "cannot read deployment YAML")?)
            .map_err(|_| "invalid deployment YAML")?;
    let uid =
        nemoclaw_backend::generate_owner().map_err(|_| "cannot allocate deployment identity")?;
    value
        .get_mut("metadata")
        .and_then(serde_json::Value::as_object_mut)
        .ok_or("deployment metadata must be an object")?
        .insert("uid".into(), uid.into());
    let bytes = serde_json::to_vec(&value).map_err(|_| "cannot encode deployment")?;
    Document::parse(bytes.as_slice()).map_err(|_| "invalid deployment configuration".into())
}

#[derive(clap::Args)]
pub(super) struct Inputs {
    #[arg(long)]
    deployment: PathBuf,
    #[arg(long)]
    suite: PathBuf,
    /// HCL test file relative to the suite, such as tests/docker-openclaw-nvidia.tftest.hcl.
    #[arg(long)]
    filter: PathBuf,
    #[arg(long)]
    bundle: PathBuf,
    /// Candidate source commit under test, recorded with the results.
    #[arg(long)]
    candidate_revision: String,
    /// New private directory; an existing directory is refused.
    #[arg(long)]
    run_dir: PathBuf,
}

pub(super) async fn execute(inputs: &Inputs, cancel: &CancellationToken) -> Result<(), String> {
    let bundle =
        Bundle::open(&inputs.bundle).map_err(|_| "a verified candidate bundle is required")?;
    let tools = Tools {
        candidate_revision: inputs.candidate_revision.clone(),
        cli: bundle.directory.join("bin").join(executable("nemoclaw")),
        tofu: bundle.tofu(),
        probe: std::env::current_exe().map_err(|_| "cannot locate probe executable")?,
        environment: BTreeMap::new(),
    };
    let Inputs {
        deployment,
        suite,
        filter,
        run_dir,
        ..
    } = inputs;
    execute_with_tools(
        deployment,
        suite,
        filter,
        &bundle.directory,
        run_dir,
        &tools,
        cancel,
    )
    .await
}

pub(super) async fn execute_with_tools(
    deployment_path: &Path,
    suite: &Path,
    filter: &Path,
    bundle: &Path,
    directory: &Path,
    tools: &Tools,
    cancel: &CancellationToken,
) -> Result<(), String> {
    let document = deployment(deployment_path)?;
    let suite = suite
        .canonicalize()
        .map_err(|_| "HCL suite directory is unavailable")?;
    if filter.parent() != Some(Path::new("tests"))
        || !filter
            .to_str()
            .is_some_and(|name| name.ends_with(".tftest.hcl"))
        || !suite.join(filter).is_file()
    {
        return Err("filter must name an existing tests/*.tftest.hcl file in the suite".into());
    }
    let revision = &tools.candidate_revision;
    if revision.len() != 40
        || !revision
            .bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
    {
        return Err("candidate revision must be a full lowercase 40-hex commit".into());
    }
    let mut builder = fs::DirBuilder::new();
    builder.recursive(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder
        .create(directory)
        .map_err(|_| "run directory must be new and its parent must exist")?;
    let directory = directory
        .canonicalize()
        .map_err(|_| "cannot resolve run directory")?;
    let state = directory.join("deployment");
    let verification = directory.join("verifier");
    let reports = verification.join("reports");
    for path in [&state, &reports] {
        fs::create_dir_all(path).map_err(|_| "cannot create run subdirectories")?;
    }
    // Ignore user CLI configuration; the verifier needs only OpenTofu's built-in provider.
    fs::write(verification.join("cli.tfrc"), "disable_checkpoint = true\n")
        .map_err(|_| "cannot write verifier CLI configuration")?;
    let config = directory.join("deployment.yaml");
    fs::write(
        &config,
        document
            .yaml()
            .map_err(|_| "cannot encode resolved deployment")?,
    )
    .map_err(|_| "cannot save resolved deployment")?;
    let mut environment = tools.environment.clone();
    // Only gateway access is needed by the probe; inference credentials stay with apply.
    let connection = document.spec.gateway.connection();
    for name in connection
        .credential_env
        .into_iter()
        .chain(connection.tls.into_iter().flat_map(|tls| {
            std::iter::once(tls.ca_env).chain(
                tls.identity
                    .into_iter()
                    .flat_map(|identity| [identity.certificate_env, identity.key_env]),
            )
        }))
        .filter(|name| !name.starts_with("TF_") && !name.starts_with("TOFU_"))
    {
        if let Some(value) = std::env::var_os(&name) {
            environment.insert(name.into(), value);
        }
    }
    environment.insert(
        nemoclaw_backend::DIAGNOSTICS_ENV.into(),
        directory.join("diagnostics").into_os_string(),
    );
    let cli =
        async |operation: &str, label: &str, cancel: &CancellationToken, deadline: Instant| {
            let mut args: Vec<OsString> = [operation, "--output", "json", "--progress", "off"]
                .map(Into::into)
                .into();
            args.extend([
                "--bundle".into(),
                bundle.into(),
                "--state-dir".into(),
                state.clone().into(),
            ]);
            if operation != "destroy" {
                args.extend(["--non-interactive".into(), config.clone().into()]);
            }
            process::execute(
                &tools.cli,
                &args,
                &directory,
                label,
                &environment,
                cancel,
                deadline,
            )
            .await
        };
    let mut verifier_environment = environment.clone();
    verifier_environment.extend([
        (
            "TF_CLI_CONFIG_FILE".into(),
            verification.join("cli.tfrc").into(),
        ),
        ("TF_DATA_DIR".into(), verification.join("data").into()),
        (
            "TF_VAR_context".into(),
            json!({
                "config": config, "state_dir": state,
                "probe_executable": tools.probe, "evidence_dir": reports,
            })
            .to_string()
            .into(),
        ),
    ]);
    let deadline = Instant::now() + RUN_DEADLINE;
    let tofu = async |phase: &str, command: &[&str]| {
        let mut args = vec![OsString::from(format!("-chdir={}", suite.display()))];
        args.extend(command.iter().map(OsString::from));
        let (environment, directory) = (&verifier_environment, &verification);
        process::execute(
            &tools.tofu,
            &args,
            directory,
            phase,
            environment,
            cancel,
            deadline,
        )
        .await
    };
    let filter_argument = format!("-filter={}", filter.display());
    let mut apply_started = false;
    let mut phase = "plan";
    let primary = async {
        cli("plan", "plan", cancel, deadline).await?;
        phase = "apply";
        apply_started = true;
        cli("apply", "apply", cancel, deadline).await?;
        // Local modules need installation; the verifier uses only built-in resources.
        phase = "tofu-get";
        tofu(phase, &["get", "-no-color"]).await?;
        phase = "tofu-test";
        tofu(phase, &["test", &filter_argument, "-json", "-no-color"]).await?;
        // Applying the same document to the running deployment changes nothing.
        phase = "reapply";
        cli("apply", phase, cancel, deadline).await?;
        let reapplied: OperationResult = serde_json::from_slice(
            &fs::read(directory.join("reapply.stdout")).map_err(|_| "reapply: missing result")?,
        )
        .map_err(|_| "reapply: invalid result")?;
        match reapplied.changes.as_slice() {
            [] => Ok(()),
            changes => Err(format!(
                "reapply: changed {}",
                changes
                    .iter()
                    .map(|change| change.resource.as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            )),
        }
    }
    .await;
    let failed_phase = primary.as_ref().err().map(|_| phase);
    // Cleanup is independent of the cancelled operation and runs after partial apply.
    let cleanup = CancellationToken::new();
    let cleanup_result = if apply_started {
        match cli(
            "destroy",
            "destroy",
            &cleanup,
            Instant::now() + DESTROY_DEADLINE,
        )
        .await
        {
            Ok(()) => destroy_result(&directory),
            Err(error) => Err(error),
        }
    } else {
        Ok(Vec::new())
    };
    let succeeded = primary.is_ok() && cleanup_result.is_ok();
    let result = json!({
        "deployment": document.metadata.name, "suite": suite, "filter": filter, "succeeded": succeeded,
        "candidate_revision": tools.candidate_revision,
        "deployment_uid": document.metadata.uid,
        "failed_phase": failed_phase,
        "failure": primary.err(),
        "cleanup": {"required": apply_started, "succeeded": cleanup_result.is_ok(), "failure": cleanup_result.as_ref().err(), "retained": cleanup_result.as_ref().ok()},
    });
    nemoclaw_runtime::files::save_json(&directory.join("result.json"), &result)
        .map_err(|_| "cannot save run result")?;
    if succeeded {
        Ok(())
    } else {
        Err("E2E failed; inspect result.json and private command/probe evidence in the run directory".into())
    }
}

fn destroy_result(directory: &Path) -> Result<Vec<String>, String> {
    let result: OperationResult = serde_json::from_slice(
        &fs::read(directory.join("destroy.stdout")).map_err(|_| "missing destroy result")?,
    )
    .map_err(|_| "invalid destroy result")?;
    if result.outcome != Outcome::Destroyed {
        return Err("destroy did not confirm expected teardown/retention".into());
    }
    Ok(result.retained)
}

#[cfg(all(test, unix))]
#[path = "wrapper_tests.rs"]
mod tests;
