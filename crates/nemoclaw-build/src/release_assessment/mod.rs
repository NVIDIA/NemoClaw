// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Read-only vulnerability assessment of saved release inventories.
use serde::Serialize;
use serde_json::Value;
use std::{path::PathBuf, time::Duration};

pub mod input;
pub mod monitor;
pub mod policy;
pub mod release;
pub mod report;
pub mod sarif;
pub mod scanner;

#[derive(Debug, Clone)]
pub struct Subject {
    name: String,
    reference: String,
    platform: String,
    sha256: String,
    asset: String,
    /// Verified bytes, so later path replacement cannot change scanner input.
    sbom: Vec<u8>,
}

impl Subject {
    pub(crate) fn name(&self) -> &str {
        &self.name
    }
    pub(crate) fn reference(&self) -> &str {
        &self.reference
    }
    pub(crate) fn platform(&self) -> &str {
        &self.platform
    }
    pub(crate) fn sha256(&self) -> &str {
        &self.sha256
    }
    pub(crate) fn asset(&self) -> &str {
        &self.asset
    }
    pub(crate) fn sbom(&self) -> &[u8] {
        &self.sbom
    }
}

#[derive(Debug, Clone, Serialize, thiserror::Error)]
#[serde(tag = "category", rename_all = "snake_case")]
pub enum AssessmentError {
    #[error("assessment input: {reason}")]
    Input { reason: String },
    #[error("vulnerability database: {reason}")]
    Database { reason: String },
    #[error("Grype {operation}: {reason}{status}", status = exit_status(*exit_code))]
    Scanner {
        operation: ScanOperation,
        reason: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        exit_code: Option<i32>,
    },
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ScanOperation {
    Version,
    DatabaseStatus,
    Scan,
}

impl std::fmt::Display for ScanOperation {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::Version => "version check",
            Self::DatabaseStatus => "database check",
            Self::Scan => "SBOM scan",
        })
    }
}

fn exit_status(code: Option<i32>) -> String {
    code.map(|code| format!(" (exit status {code})"))
        .unwrap_or_default()
}

#[derive(Debug, Clone, Serialize)]
pub struct ScannerEvidence {
    pub name: String,
    pub version: String,
    pub sha256: String,
    pub configuration_sha256: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct DatabaseEvidence {
    pub schema_version: String,
    pub built: String,
    pub sha256: String,
    pub age_seconds: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    Passed,
    Blocked,
    Incomplete,
}

#[derive(Debug, Clone, Serialize)]
pub struct Finding {
    pub advisory: String,
    pub package: String,
    pub version: String,
    pub purl: Option<String>,
    pub severity: String,
    pub severity_source: Option<String>,
    pub ratings: Vec<Value>,
    pub fixed_versions: Vec<String>,
    pub aliases: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SubjectReport {
    pub name: String,
    pub reference: String,
    pub platform: String,
    pub sbom_sha256: String,
    pub sbom_asset: String,
    pub findings: Vec<Finding>,
    pub problems: Vec<AssessmentError>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Assessment {
    pub status: Status,
    pub publication_authorized: bool,
    pub scanner: Option<ScannerEvidence>,
    pub database: Option<DatabaseEvidence>,
    pub subjects: Vec<SubjectReport>,
    pub problems: Vec<AssessmentError>,
}

pub struct ScanOptions {
    pub grype: PathBuf,
    pub database: PathBuf,
    pub max_database_age: Duration,
    pub timeout: Duration,
}

impl Assessment {
    pub fn incomplete(problem: AssessmentError) -> Self {
        Self {
            status: Status::Incomplete,
            publication_authorized: false,
            scanner: None,
            database: None,
            subjects: Vec::new(),
            problems: vec![problem],
        }
    }
}
