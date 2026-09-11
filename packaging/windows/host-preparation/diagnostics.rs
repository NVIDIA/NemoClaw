// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use std::ffi::OsString;
use std::io::Write;
use std::path::{Path, PathBuf};

pub struct Destination {
    pub path: PathBuf,
    pub attempt: String,
}

pub fn arguments(args: &[OsString]) -> Result<Option<Destination>, &'static str> {
    if args == ["prepare-system-drive"] {
        return Ok(None);
    }
    if args.len() != 5
        || args[0] != "prepare-system-drive"
        || args[1] != "--diagnostic-log"
        || args[3] != "--diagnostic-id"
    {
        return Err("Only fixed system-drive metadata preparation is supported.");
    }
    let attempt = args[4].to_str().ok_or("Invalid diagnostic attempt.")?;
    if attempt.len() != 32
        || !attempt
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
    {
        return Err("Invalid diagnostic attempt.");
    }
    let path = PathBuf::from(&args[2]);
    #[cfg(windows)]
    if !matches!(path.components().next(), Some(std::path::Component::Prefix(prefix))
        if matches!(prefix.kind(), std::path::Prefix::Disk(_) | std::path::Prefix::VerbatimDisk(_)))
    {
        return Err("The setup diagnostic must use a local drive path.");
    }
    let suffix = format!(".host-preparation-{attempt}.json");
    if !path.is_absolute()
        || path
            .components()
            .any(|component| component == std::path::Component::ParentDir)
        || !path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.ends_with(&suffix))
    {
        return Err("The diagnostic log must be a distinct setup-log sidecar.");
    }
    Ok(Some(Destination {
        path,
        attempt: attempt.to_owned(),
    }))
}

pub struct Outcome {
    pub stage: String,
    pub win32_error: Option<u32>,
    pub stderr: String,
    pub failed: bool,
}

impl Outcome {
    pub fn from_result(result: &Result<(), String>) -> Self {
        let Err(message) = result else {
            return Self {
                stage: "complete".into(),
                win32_error: None,
                stderr: String::new(),
                failed: false,
            };
        };
        let native = message
            .split_once(": Win32 error ")
            .and_then(|(stage, code)| {
                (valid_stage(stage) && !code.is_empty() && code.bytes().all(|c| c.is_ascii_digit()))
                    .then(|| code.parse::<u32>().ok().map(|value| (stage, value)))
                    .flatten()
            });
        let (stage, win32_error) = native.map_or(("metadata-validation", None), |(stage, code)| {
            (stage, Some(code))
        });
        Self {
            stage: stage.into(),
            win32_error,
            stderr: format!(
                "NemoClaw system-drive metadata preparation failed: {}",
                sanitized(message)
            ),
            failed: true,
        }
    }

    pub fn exit_code(&self) -> i32 {
        if !self.failed {
            return 0;
        }
        match self.win32_error {
            Some(code @ 1..=65535) => code as i32,
            _ => 1,
        }
    }

    pub fn json(&self, attempt: Option<&str>, elapsed_ms: u128) -> String {
        format!(
            "{{\"schemaVersion\":1,\"classification\":\"nemoclaw-host-preparation-diagnostic\",\"operation\":\"prepare-system-drive\",\"attemptId\":{},\"status\":\"{}\",\"stage\":{},\"win32Error\":{},\"elapsedMilliseconds\":{},\"stderr\":{}}}\n",
            attempt.map_or("null".into(), quoted),
            if self.failed { "failed" } else { "succeeded" },
            quoted(&self.stage),
            self.win32_error
                .map_or("null".into(), |code| code.to_string()),
            elapsed_ms,
            quoted(&self.stderr),
        )
    }
}

fn valid_stage(stage: &str) -> bool {
    !stage.is_empty()
        && stage.len() <= 64
        && stage
            .bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
}

fn sanitized(message: &str) -> String {
    let lower = message.to_ascii_lowercase();
    if message.len() > 512
        || !message.is_ascii()
        || message
            .chars()
            .any(|c| c.is_control() || matches!(c, '\\' | '/' | '=' | '@'))
        || [
            "password",
            "secret",
            "credential",
            "authorization",
            "bearer",
        ]
        .iter()
        .any(|word| lower.contains(word))
    {
        return "Preparation details were redacted; the failed stage and Windows code are retained.".into();
    }
    message.to_owned()
}

fn quoted(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
}

pub fn persist(path: &Path, content: &str) -> std::io::Result<()> {
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(0x0020_0000).share_mode(1);
    }
    let mut file = options.open(path)?;
    file.write_all(content.as_bytes())?;
    file.sync_all()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn early_native_failure_retains_stage_code_and_sanitized_stderr() {
        let failure = Outcome::from_result(&Err(
            "open-metadata-inspection-target: Win32 error 32".into()
        ));
        assert_eq!(failure.stage, "open-metadata-inspection-target");
        assert_eq!(failure.exit_code(), 32);
        let record = failure.json(Some("0123456789abcdef0123456789abcdef"), 7);
        assert!(record.contains("\"win32Error\":32"));
        assert!(record.contains("\"status\":\"failed\""));
        assert!(record.contains("Win32 error 32"));
    }

    #[test]
    fn paths_secrets_and_unbounded_details_never_enter_the_record() {
        for message in [
            "C:\\Users\\private\\file",
            "credential=hidden",
            "Authorization: Bearer hidden",
            "line\nsecond",
        ] {
            let record = Outcome::from_result(&Err(message.into())).json(None, 0);
            assert!(!record.contains(message));
            assert!(record.contains("redacted"));
        }
        assert!(
            Outcome::from_result(&Err("x".repeat(513)))
                .stderr
                .contains("redacted")
        );
    }

    #[test]
    fn success_and_non_native_failure_keep_their_real_exit_contract() {
        assert_eq!(Outcome::from_result(&Ok(())).exit_code(), 0);
        let failure = Outcome::from_result(&Err("The metadata descriptor is invalid.".into()));
        assert_eq!(failure.exit_code(), 1);
        assert_eq!(failure.win32_error, None);
        assert!(failure.json(None, 0).contains("\"win32Error\":null"));
    }

    #[test]
    fn only_matching_attempt_sidecars_are_accepted() {
        let id = "0123456789abcdef0123456789abcdef";
        let path = std::env::temp_dir().join(format!("setup.log.host-preparation-{id}.json"));
        let args = vec![
            "prepare-system-drive".into(),
            "--diagnostic-log".into(),
            path.into_os_string(),
            "--diagnostic-id".into(),
            id.into(),
        ];
        assert!(arguments(&args).unwrap().is_some());
        let mut wrong = args.clone();
        wrong[4] = "another-attempt".into();
        assert!(arguments(&wrong).is_err());
        assert!(
            arguments(&["prepare-system-drive".into()])
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn retained_diagnostic_never_overwrites_an_existing_file() {
        let path = std::env::temp_dir().join(format!(
            "nemoclaw-preparation-log-test-{}.json",
            std::process::id()
        ));
        persist(&path, "first").unwrap();
        assert_eq!(
            persist(&path, "second").unwrap_err().kind(),
            std::io::ErrorKind::AlreadyExists
        );
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "first");
        std::fs::remove_file(path).unwrap();
    }
}
