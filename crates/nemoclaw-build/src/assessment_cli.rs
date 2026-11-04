// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Local scanner/controller wiring; publication authority belongs to the protected host workflow.
use nemoclaw_build::release_assessment::{
    self, Assessment, AssessmentError, ScanOptions, Status, Subject,
};
use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
    time::Duration,
};

#[derive(clap::Args)]
pub struct Inputs {
    #[arg(long)]
    pub inventory: PathBuf,
    #[arg(long)]
    pub sboms: PathBuf,
    #[arg(long)]
    pub sbom_directory: PathBuf,
    #[arg(long)]
    pub grype: PathBuf,
    #[arg(long)]
    pub database: PathBuf,
    /// Explicit controller policy for the maximum advisory database age.
    #[arg(long)]
    pub max_db_age_hours: std::num::NonZeroU64,
    #[arg(long, default_value = "120")]
    pub timeout_seconds: std::num::NonZeroU64,
}

#[derive(clap::Args)]
pub struct GateArgs {
    #[command(flatten)]
    pub inputs: Inputs,
    #[arg(long)]
    pub release_tag: String,
    #[arg(long)]
    pub controller_revision: String,
    #[arg(long)]
    pub exceptions: PathBuf,
    #[arg(long)]
    pub reviewed_policy_sha256: String,
    #[arg(long)]
    pub output_directory: PathBuf,
}

fn problem(reason: &str) -> AssessmentError {
    AssessmentError::Input {
        reason: reason.into(),
    }
}

impl Inputs {
    pub fn assess(&self) -> Result<(Vec<Subject>, Assessment), AssessmentError> {
        let seconds = self
            .max_db_age_hours
            .get()
            .checked_mul(3600)
            .ok_or_else(|| problem("database age exceeds the supported duration"))?;
        let subjects =
            release_assessment::input::load(&self.inventory, &self.sboms, &self.sbom_directory)?;
        let assessment = release_assessment::scanner::assess(
            &subjects,
            &ScanOptions {
                grype: self.grype.clone(),
                database: self.database.clone(),
                max_database_age: Duration::from_secs(seconds),
                timeout: Duration::from_secs(self.timeout_seconds.get()),
            },
        )?;
        Ok((subjects, assessment))
    }
}

pub fn exit_code(status: Status) -> i32 {
    match status {
        Status::Passed => 0,
        Status::Blocked => 2,
        Status::Incomplete => 3,
    }
}

fn read(path: &Path, limit: u64) -> Result<Vec<u8>, AssessmentError> {
    let file =
        fs::File::open(path).map_err(|_| problem("saved release evidence is unavailable"))?;
    if !file
        .metadata()
        .map_err(|_| problem("saved release evidence cannot be inspected"))?
        .is_file()
    {
        return Err(problem("saved release evidence must be a regular file"));
    }
    let mut bytes = Vec::new();
    file.take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| problem("saved release evidence cannot be read"))?;
    if bytes.is_empty() || bytes.len() as u64 > limit {
        return Err(problem(
            "saved release evidence is empty or exceeds its size limit",
        ));
    }
    Ok(bytes)
}

fn write_json(
    directory: &Path,
    name: &str,
    value: &impl serde::Serialize,
) -> Result<(), AssessmentError> {
    let bytes = serde_json::to_vec(value).map_err(|_| problem("could not encode gate evidence"))?;
    fs::write(directory.join(name), bytes)
        .map_err(|_| problem("could not save private gate evidence"))
}

/// Always scan saved SBOMs anew. A stored report or a self-declared policy hash
/// is never treated as authorization to publish.
pub fn gate(args: &GateArgs) -> Result<Status, AssessmentError> {
    if !args.output_directory.is_absolute() || args.output_directory.try_exists().unwrap_or(true) {
        return Err(problem("gate output must be a fresh absolute directory"));
    }
    let parent = args
        .output_directory
        .parent()
        .ok_or_else(|| problem("gate output needs a parent directory"))?;
    let temporary = tempfile::tempdir_in(parent)
        .map_err(|_| problem("could not create private gate output"))?;
    let (subjects, mut assessment) = match args.inputs.assess() {
        Ok(value) => value,
        Err(error) => (Vec::new(), Assessment::incomplete(error)),
    };
    let evidence = if subjects.is_empty() {
        None
    } else {
        let result = (|| {
            let inventory = read(&args.inputs.inventory, 16_000_000)?;
            let mapping = read(&args.inputs.sboms, 16_000_000)?;
            let policy = read(&args.exceptions, 1 << 20)?;
            release_assessment::release::bind(
                &args.release_tag,
                &args.controller_revision,
                &inventory,
                &mapping,
                &subjects,
                &assessment,
                &policy,
                &args.reviewed_policy_sha256,
            )
        })();
        match result {
            Ok(evidence) => Some(evidence),
            Err(error) => {
                assessment.status = Status::Incomplete;
                assessment.problems.push(error);
                None
            }
        }
    };
    write_json(temporary.path(), "assessment.json", &assessment)?;
    let mut sarif = release_assessment::sarif::document(&assessment);
    sarif["runs"][0]["automationDetails"] =
        serde_json::json!({"id":format!("nemoclaw-v1-images/{}/", args.release_tag)});
    write_json(temporary.path(), "assessment.sarif", &sarif)?;
    let status = evidence.as_ref().map_or(Status::Incomplete, |e| e.status);
    if let Some(evidence) = evidence {
        write_json(temporary.path(), "gate.json", &evidence)?;
    }
    fs::rename(temporary.path(), &args.output_directory)
        .map_err(|_| problem("could not expose private gate evidence"))?;
    Ok(status)
}

pub fn verify_promotion(expected: &Path, actual: &Path) -> Result<(), AssessmentError> {
    release_assessment::release::verify_promoted(
        &read(expected, 16_000_000)?,
        &read(actual, 16_000_000)?,
    )
}

pub fn monitor_plan(
    supported: &Path,
) -> Result<Vec<release_assessment::monitor::SupportedRelease>, AssessmentError> {
    release_assessment::monitor::plan(&read(supported, 1 << 20)?, time::OffsetDateTime::now_utc())
        .map_err(|error| problem(&error.to_string()))
}

pub fn catalog(
    path: &Path,
    candidate: &str,
    source: &str,
) -> Result<release_assessment::release::ReleaseCatalog, AssessmentError> {
    release_assessment::release::catalog(&read(path, 1 << 20)?, candidate, source)
}

pub fn monitor_verify(
    supported: &Path,
    tag: &str,
    metadata: &Path,
    inventory: &Path,
    mapping: &Path,
) -> Result<(), AssessmentError> {
    let release = monitor_plan(supported)?
        .into_iter()
        .find(|release| release.tag == tag)
        .ok_or_else(|| problem("release is not in the active supported-release list"))?;
    release_assessment::monitor::verify_public_release(
        &release,
        &read(metadata, 16_000_000)?,
        &read(inventory, 16_000_000)?,
        &read(mapping, 16_000_000)?,
    )
    .map_err(|error| problem(&error.to_string()))
}
