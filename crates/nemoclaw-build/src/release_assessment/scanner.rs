// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use super::{
    Assessment, AssessmentError, DatabaseEvidence, Finding, ScanOperation, ScanOptions,
    ScannerEvidence, Status, Subject, SubjectReport,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File},
    io::Read,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    thread,
    time::{Duration, Instant},
};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

const VERSION: &str = "0.121.0";
const OUTPUT_LIMIT: u64 = 128 << 20;
const DATABASE_LIMIT: u64 = 8 << 30;

/// Evaluate saved inventories without registry access, database updates, or publication.
pub fn assess(subjects: &[Subject], options: &ScanOptions) -> Result<Assessment, AssessmentError> {
    if subjects.is_empty() || options.timeout.is_zero() || options.max_database_age.is_zero() {
        return Err(AssessmentError::Input {
            reason: "assessment requires subjects and positive timeout and database age limits"
                .into(),
        });
    }
    if !options.grype.is_absolute() || !options.database.is_absolute() {
        return Err(AssessmentError::Input {
            reason: "Grype executable and prepared database paths must be absolute".into(),
        });
    }
    let binary = fs::canonicalize(&options.grype).map_err(|_| {
        scanner_error(
            ScanOperation::Version,
            "Grype executable is unavailable",
            None,
        )
    })?;
    let binary_hash = hash_file(&binary, 512 << 20)
        .map_err(|reason| scanner_error(ScanOperation::Version, &reason, None))?;
    let temporary = tempfile::tempdir().map_err(|_| {
        scanner_error(
            ScanOperation::Scan,
            "could not create assessment workspace",
            None,
        )
    })?;
    let database = copy_database(&options.database, temporary.path())
        .map_err(|reason| AssessmentError::Database { reason })?;
    let config = json!({
        "check-for-app-update":false, "only-fixed":false, "only-notfixed":false,
        "ignore-wontfix":"", "ignore":[], "exclude":[], "vex-documents":[], "vex-add":[],
        "external-sources":{"enable":false}, "log":{"quiet":true},
        "db":{"cache-dir":database, "auto-update":false, "validate-age":true,
            "validate-by-hash-on-start":true,
            "max-allowed-built-age":format!("{}s", options.max_database_age.as_secs())}
    });
    let config_bytes = serde_json::to_vec(&config).map_err(|_| {
        scanner_error(
            ScanOperation::Scan,
            "could not encode scanner settings",
            None,
        )
    })?;
    let config_path = temporary.path().join("grype.json");
    fs::write(&config_path, &config_bytes).map_err(|_| {
        scanner_error(
            ScanOperation::Scan,
            "could not write scanner settings",
            None,
        )
    })?;
    let runner = Runner {
        binary: &binary,
        config: &config_path,
        workspace: temporary.path(),
        timeout: options.timeout,
    };
    let version = runner.json(ScanOperation::Version, &["version", "-o", "json"])?;
    if version["application"] != "grype" || version["version"] != VERSION {
        return Err(scanner_error(
            ScanOperation::Version,
            &format!("assessment requires Grype {VERSION}"),
            None,
        ));
    }
    let status = runner.json(
        ScanOperation::DatabaseStatus,
        &["db", "status", "-o", "json"],
    )?;
    let db_path = database.join("6/vulnerability.db");
    let (built, age) = validate_database_status(&status, &db_path, options.max_database_age)
        .map_err(|reason| AssessmentError::Database { reason })?;
    let db_hash = hash_file(&db_path, DATABASE_LIMIT)
        .map_err(|reason| AssessmentError::Database { reason })?;
    let mut assessment = Assessment {
        status: Status::Passed,
        publication_authorized: false,
        scanner: Some(ScannerEvidence {
            name: "grype".into(),
            version: VERSION.into(),
            sha256: binary_hash.clone(),
            configuration_sha256: crate::hex(&Sha256::digest(&config_bytes)),
        }),
        database: Some(DatabaseEvidence {
            schema_version: status["schemaVersion"].as_str().unwrap_or_default().into(),
            built,
            sha256: db_hash.clone(),
            age_seconds: age,
        }),
        subjects: Vec::new(),
        problems: Vec::new(),
    };
    for (index, subject) in subjects.iter().enumerate() {
        let path = temporary.path().join(format!("subject-{index}.spdx.json"));
        let mut report = SubjectReport {
            name: subject.name.clone(),
            reference: subject.reference.clone(),
            platform: subject.platform.clone(),
            sbom_sha256: subject.sha256.clone(),
            sbom_asset: subject.asset.clone(),
            findings: Vec::new(),
            problems: Vec::new(),
        };
        let result = fs::write(&path, &subject.sbom)
            .map_err(|_| {
                scanner_error(
                    ScanOperation::Scan,
                    "could not save verified scanner input",
                    None,
                )
            })
            .and_then(|()| {
                runner.json(
                    ScanOperation::Scan,
                    &[&format!("sbom:{}", path.display()), "-o", "json"],
                )
            });
        let status = match result {
            Ok(document) => {
                if document["descriptor"]["name"] != "grype"
                    || document["descriptor"]["version"] != VERSION
                {
                    report.problems.push(scanner_error(
                        ScanOperation::Scan,
                        "scan output has an unexpected scanner identity",
                        None,
                    ));
                }
                evaluate_document(&mut report, &document)
            }
            Err(problem) => {
                report.problems.push(problem);
                Status::Incomplete
            }
        };
        assessment.status = combine(assessment.status, status);
        assessment.subjects.push(report);
    }
    if hash_file(&db_path, DATABASE_LIMIT).as_deref() != Ok(db_hash.as_str()) {
        assessment.status = Status::Incomplete;
        assessment.problems.push(AssessmentError::Database {
            reason: "database changed or became unavailable during assessment".into(),
        });
    }
    if hash_file(&binary, 512 << 20).as_deref() != Ok(binary_hash.as_str()) {
        assessment.status = Status::Incomplete;
        assessment.problems.push(scanner_error(
            ScanOperation::Version,
            "scanner changed or became unavailable during assessment",
            None,
        ));
    }
    match validate_database_status(&status, &db_path, options.max_database_age) {
        Ok((_, age)) => {
            if let Some(database) = &mut assessment.database {
                database.age_seconds = age;
            }
        }
        Err(reason) => {
            assessment.status = Status::Incomplete;
            assessment
                .problems
                .push(AssessmentError::Database { reason });
        }
    }
    Ok(assessment)
}

fn combine(left: Status, right: Status) -> Status {
    match (left, right) {
        (Status::Incomplete, _) | (_, Status::Incomplete) => Status::Incomplete,
        (Status::Blocked, _) | (_, Status::Blocked) => Status::Blocked,
        _ => Status::Passed,
    }
}

fn copy_database(source: &Path, workspace: &Path) -> Result<PathBuf, String> {
    let source =
        fs::canonicalize(source).map_err(|_| "prepared database directory is unavailable")?;
    let schema = source.join("6");
    let metadata =
        fs::symlink_metadata(&schema).map_err(|_| "prepared schema 6 database is unavailable")?;
    if !metadata.is_dir() || metadata.is_symlink() {
        return Err("prepared database schema must be an ordinary directory".into());
    }
    let destination = workspace.join("db/6");
    fs::create_dir_all(&destination).map_err(|_| "could not create private database snapshot")?;
    for (name, limit) in [
        ("vulnerability.db", DATABASE_LIMIT),
        ("import.json", 1 << 20),
    ] {
        let from = schema.join(name);
        let metadata =
            fs::symlink_metadata(&from).map_err(|_| "prepared database is incomplete")?;
        if !metadata.is_file()
            || metadata.is_symlink()
            || metadata.len() == 0
            || metadata.len() > limit
        {
            return Err("prepared database has an invalid or oversized file".into());
        }
        let copied = fs::copy(from, destination.join(name))
            .map_err(|_| "could not snapshot prepared database")?;
        if copied != metadata.len() || copied > limit {
            return Err("prepared database changed while it was copied".into());
        }
    }
    Ok(workspace.join("db"))
}

fn validate_database_status(
    status: &Value,
    expected_path: &Path,
    max_age: Duration,
) -> Result<(String, u64), String> {
    if status["valid"] != true
        || status
            .get("error")
            .is_some_and(|v| v.as_str().is_none_or(|s| !s.is_empty()))
    {
        return Err("prepared vulnerability database failed Grype validation".into());
    }
    if !status["schemaVersion"]
        .as_str()
        .is_some_and(|s| s.starts_with("v6.") || s.starts_with("6."))
        || status["path"].as_str().map(Path::new) != Some(expected_path)
    {
        return Err("Grype selected an unexpected database".into());
    }
    let built = text(status, "built").ok_or("database build time is missing")?;
    let built_time =
        OffsetDateTime::parse(built, &Rfc3339).map_err(|_| "database build time is invalid")?;
    let age = OffsetDateTime::now_utc() - built_time;
    if age.is_negative() || age.whole_seconds() as u64 > max_age.as_secs() {
        return Err("vulnerability database is stale or has a future build time".into());
    }
    Ok((built.into(), age.whole_seconds() as u64))
}

fn hash_file(path: &Path, limit: u64) -> Result<String, String> {
    let mut file = File::open(path).map_err(|_| "assessment evidence file is unavailable")?;
    let metadata = file
        .metadata()
        .map_err(|_| "could not inspect assessment evidence")?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > limit {
        return Err("assessment evidence file is empty or oversized".into());
    }
    let mut hash = Sha256::new();
    let mut size = 0_u64;
    let mut buffer = [0; 64 << 10];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|_| "could not read assessment evidence")?;
        if read == 0 {
            break;
        }
        size += read as u64;
        if size > limit {
            return Err("assessment evidence exceeds its size limit".into());
        }
        hash.update(&buffer[..read]);
    }
    Ok(crate::hex(&hash.finalize()))
}

struct Runner<'a> {
    binary: &'a Path,
    config: &'a Path,
    workspace: &'a Path,
    timeout: Duration,
}

struct OwnedChild(Child);
impl Drop for OwnedChild {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn scanner_error(
    operation: ScanOperation,
    reason: &str,
    exit_code: Option<i32>,
) -> AssessmentError {
    AssessmentError::Scanner {
        operation,
        reason: reason.into(),
        exit_code,
    }
}

impl Runner<'_> {
    fn json(&self, operation: ScanOperation, arguments: &[&str]) -> Result<Value, AssessmentError> {
        let error = |reason: &str| scanner_error(operation, reason, None);
        let output = tempfile::NamedTempFile::new_in(self.workspace)
            .map_err(|_| error("could not capture output"))?;
        let writer = output
            .reopen()
            .map_err(|_| error("could not capture output"))?;
        let child = Command::new(self.binary)
            .env_clear()
            .current_dir(self.workspace)
            .arg("--config")
            .arg(self.config)
            .args(arguments)
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .stdout(writer)
            .spawn()
            .map_err(|_| error("could not start process"))?;
        let mut child = OwnedChild(child);
        let started = Instant::now();
        loop {
            if output
                .as_file()
                .metadata()
                .map_err(|_| error("could not inspect output"))?
                .len()
                > OUTPUT_LIMIT
            {
                return Err(error("output exceeds its size limit"));
            }
            if let Some(status) = child
                .0
                .try_wait()
                .map_err(|_| error("could not observe process"))?
            {
                if !status.success() {
                    return Err(scanner_error(
                        operation,
                        "process exited unsuccessfully",
                        status.code(),
                    ));
                }
                break;
            }
            if started.elapsed() >= self.timeout {
                return Err(error("process timed out"));
            }
            thread::sleep(Duration::from_millis(10));
        }
        let mut bytes = Vec::new();
        output
            .reopen()
            .map_err(|_| error("could not read output"))?
            .take(OUTPUT_LIMIT + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| error("could not read output"))?;
        if bytes.len() as u64 > OUTPUT_LIMIT {
            return Err(error("output exceeds its size limit"));
        }
        serde_json::from_slice(&bytes).map_err(|_| error("returned invalid JSON"))
    }
}

fn text<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value[key]
        .as_str()
        .filter(|s| !s.trim().is_empty() && s.len() <= 4096 && !s.chars().any(char::is_control))
}

fn evaluate_document(report: &mut SubjectReport, document: &Value) -> Status {
    let Some(matches) = document["matches"].as_array() else {
        report.problems.push(scanner_error(
            ScanOperation::Scan,
            "Grype output has no valid match list",
            None,
        ));
        return Status::Incomplete;
    };
    let mut blocked = false;
    let ignored = document.get("ignoredMatches");
    if ignored.is_some_and(|v| !v.is_array()) {
        report.problems.push(scanner_error(
            ScanOperation::Scan,
            "Grype output has an invalid suppressed-match list",
            None,
        ));
    }
    if ignored
        .and_then(Value::as_array)
        .is_some_and(|v| !v.is_empty())
    {
        report.problems.push(scanner_error(
            ScanOperation::Scan,
            "Grype unexpectedly suppressed matches; review is required",
            None,
        ));
    }
    for entry in matches
        .iter()
        .chain(ignored.and_then(Value::as_array).into_iter().flatten())
    {
        let vulnerability = &entry["vulnerability"];
        let artifact = &entry["artifact"];
        let (Some(advisory), Some(package), Some(version)) = (
            text(vulnerability, "id"),
            text(artifact, "name"),
            text(artifact, "version"),
        ) else {
            report.problems.push(scanner_error(
                ScanOperation::Scan,
                "Grype match is missing a valid advisory or package identity",
                None,
            ));
            continue;
        };
        let severity = text(vulnerability, "severity").unwrap_or("Unknown");
        match severity {
            "Critical" | "High" => blocked = true,
            "Medium" | "Low" | "Negligible" => {}
            _ => report.problems.push(scanner_error(
                ScanOperation::Scan,
                "A finding has unknown or unsupported severity; review is required",
                None,
            )),
        }
        let aliases = entry["relatedVulnerabilities"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|v| text(v, "id"))
            .map(str::to_owned)
            .collect();
        let fixed_versions = vulnerability["fix"]["versions"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect();
        let ratings = std::iter::once(vulnerability)
            .chain(
                entry["relatedVulnerabilities"]
                    .as_array()
                    .into_iter()
                    .flatten(),
            )
            .filter(|v| v["cvss"].as_array().is_some_and(|a| !a.is_empty()))
            .map(|v| json!({"advisory":v["id"], "source":v["dataSource"], "cvss":v["cvss"]}))
            .collect();
        report.findings.push(Finding {
            advisory: advisory.into(),
            package: package.into(),
            version: version.into(),
            purl: text(artifact, "purl").map(str::to_owned),
            severity: severity.into(),
            severity_source: text(vulnerability, "dataSource").map(str::to_owned),
            fixed_versions,
            aliases,
            ratings,
        });
    }
    if !report.problems.is_empty() {
        Status::Incomplete
    } else if blocked {
        Status::Blocked
    } else {
        Status::Passed
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn report() -> SubjectReport {
        SubjectReport {
            name: "hermes".into(),
            reference: format!("registry.example/hermes@sha256:{}", "a".repeat(64)),
            platform: "linux/amd64".into(),
            sbom_sha256: "b".repeat(64),
            sbom_asset: "hermes-amd64.spdx.json".into(),
            findings: Vec::new(),
            problems: Vec::new(),
        }
    }

    fn document(severity: &str) -> Value {
        json!({"matches":[{
            "vulnerability": {
                "id":"GHSA-test", "severity":severity,
                "dataSource":"https://advisories.example/GHSA-test",
                "fix":{"versions":["2.0.0"]}
            },
            "artifact":{"name":"example","version":"1.0.0","purl":"pkg:npm/example@1.0.0"},
            "relatedVulnerabilities":[{"id":"CVE-test"}]
        }]})
    }

    #[test]
    fn high_findings_block_and_retain_the_package_and_advisory() {
        let mut report = report();
        assert_eq!(
            evaluate_document(&mut report, &document("High")),
            Status::Blocked
        );
        assert_eq!(report.findings.len(), 1);
        assert_eq!(report.findings[0].advisory, "GHSA-test");
        assert_eq!(report.findings[0].aliases, ["CVE-test"]);
        assert_eq!(report.findings[0].fixed_versions, ["2.0.0"]);
    }

    #[test]
    fn unexpected_suppression_is_incomplete_and_keeps_the_hidden_finding() {
        let mut report = report();
        let mut output = document("Critical");
        output["ignoredMatches"] = output["matches"].take();
        output["matches"] = json!([]);
        assert_eq!(evaluate_document(&mut report, &output), Status::Incomplete);
        assert_eq!(report.findings.len(), 1);
        assert_eq!(report.findings[0].severity, "Critical");
    }

    #[test]
    fn unknown_or_malformed_matches_prevent_a_pass_without_hiding_known_findings() {
        for extra in [
            document("Unknown")["matches"][0].clone(),
            json!({"artifact":{}}),
        ] {
            let mut report = report();
            let mut output = document("High");
            output["matches"].as_array_mut().unwrap().push(extra);
            assert_eq!(evaluate_document(&mut report, &output), Status::Incomplete);
            assert_eq!(report.findings[0].severity, "High");
            assert!(!report.problems.is_empty());
        }
        for output in [json!({}), json!({"matches":null})] {
            assert_eq!(
                evaluate_document(&mut report(), &output),
                Status::Incomplete
            );
        }
    }

    #[test]
    fn lower_selected_severity_keeps_original_ratings_without_recalculating_them() {
        let mut report = report();
        let mut output = document("Low");
        output["matches"][0]["vulnerability"]["cvss"] = json!([
            {"source":"vendor", "version":"3.1", "metrics":{"baseScore":2.0}}
        ]);
        output["matches"][0]["relatedVulnerabilities"][0]["cvss"] = json!([
            {"source":"other", "version":"3.1", "metrics":{"baseScore":9.0}}
        ]);
        assert_eq!(evaluate_document(&mut report, &output), Status::Passed);
        assert_eq!(report.findings[0].ratings.len(), 2);
        assert_eq!(
            report.findings[0].severity_source.as_deref(),
            Some("https://advisories.example/GHSA-test")
        );
        assert_eq!(
            evaluate_document(&mut self::report(), &json!({"matches":[]})),
            Status::Passed
        );
    }

    #[test]
    fn invalid_stale_future_or_wrong_database_never_supplies_assessment_evidence() {
        let path = Path::new("/owned/db/6/vulnerability.db");
        let now = OffsetDateTime::now_utc();
        let status = |built: OffsetDateTime| {
            json!({
                "valid":true,"schemaVersion":"v6.1.10","path":path,
                "built":built.format(&Rfc3339).unwrap()
            })
        };
        assert!(
            validate_database_status(
                &status(now - time::Duration::minutes(1)),
                path,
                Duration::from_secs(3600)
            )
            .is_ok()
        );
        for value in [
            status(now - time::Duration::hours(2)),
            status(now + time::Duration::hours(1)),
            json!({"valid":false}),
            json!({"valid":true,"path":"/other/database","schemaVersion":"v6.1.10","built":"2026-10-21T00:00:00Z"}),
        ] {
            assert!(validate_database_status(&value, path, Duration::from_secs(3600)).is_err());
        }
    }

    #[cfg(unix)]
    #[test]
    fn subprocess_failures_hide_stderr_and_timeouts_reap_the_owned_process() {
        use std::os::unix::fs::PermissionsExt;
        let temporary = tempfile::tempdir().unwrap();
        let binary = temporary.path().join("fake-grype");
        let config = temporary.path().join("config.json");
        fs::write(&config, "{}").unwrap();
        fs::write(&binary, "#!/bin/sh\nprintf 'secret-canary' >&2\nexit 1\n").unwrap();
        fs::set_permissions(&binary, fs::Permissions::from_mode(0o700)).unwrap();
        let runner = Runner {
            binary: &binary,
            config: &config,
            workspace: temporary.path(),
            timeout: Duration::from_secs(2),
        };
        let error = runner.json(ScanOperation::Scan, &[]).unwrap_err();
        assert!(!error.to_string().contains("secret-canary"));
        assert!(matches!(
            error,
            AssessmentError::Scanner {
                operation: ScanOperation::Scan,
                exit_code: Some(1),
                ..
            }
        ));
        fs::write(&binary, "#!/bin/sh\nexec /bin/sleep 10\n").unwrap();
        let timed = Runner {
            timeout: Duration::from_millis(30),
            ..runner
        };
        assert!(
            matches!(timed.json(ScanOperation::DatabaseStatus, &[]).unwrap_err(), AssessmentError::Scanner {operation:ScanOperation::DatabaseStatus, exit_code:None, reason} if reason.contains("timed out"))
        );
        fs::write(&binary, "#!/bin/sh\nprintf 'not-json'\n").unwrap();
        assert!(
            matches!(runner.json(ScanOperation::Version, &[]).unwrap_err(), AssessmentError::Scanner {operation:ScanOperation::Version, exit_code:None, reason} if reason.contains("invalid JSON"))
        );
    }
}
