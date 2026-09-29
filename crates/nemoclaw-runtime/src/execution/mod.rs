// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Package-neutral runtime entry point. Package dispatch remains inside the
//! service component alongside each installer's implementation.

pub(super) mod supervisor;

use crate::{CancellationToken, Error};
use std::path::Path;

pub async fn run(cancel: &CancellationToken, trip: &CancellationToken) -> Result<(), Error> {
    let text = match std::env::var("NEMOCLAW_RUNTIME_SPEC") {
        Ok(value) => value,
        Err(std::env::VarError::NotPresent) => {
            return Err(Error::State("missing runtime specification"));
        }
        Err(std::env::VarError::NotUnicode(_)) => {
            return Err(Error::State("runtime specification is not UTF-8"));
        }
    };
    match crate::RuntimeSpec::decode(&text)? {
        crate::RuntimeSpec::Ollama(service) => {
            crate::ollama::runtime::run(&service, cancel, trip).await
        }
        crate::RuntimeSpec::Vllm(service) => {
            crate::vllm::runtime::run(&service, cancel, trip).await
        }
    }
}

pub(super) fn report(phase: &str, detail: &str, pid: u32) -> Result<(), Error> {
    report_at(Path::new("/data"), phase, detail, pid)
}

fn report_at(root: &Path, phase: &str, detail: &str, pid: u32) -> Result<(), Error> {
    let updated = time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .map_err(|_| Error::State("cannot timestamp runtime status"))?;
    let value = serde_json::json!({"phase":phase,"detail":detail,"updated":updated,"pid":pid});
    crate::files::save_json(&root.join("status.json"), &value)?;
    eprintln!("{phase}: {detail}");
    Ok(())
}

#[cfg(test)]
mod status_tests {
    #[test]
    fn status_replaces_the_previous_phase_and_preserves_it_when_directory_is_missing() {
        let root = tempfile::tempdir().unwrap();
        super::report_at(root.path(), "preparing", "verified model", 0).unwrap();
        super::report_at(root.path(), "ready", "serving", 123).unwrap();
        let status: serde_json::Value =
            serde_json::from_slice(&std::fs::read(root.path().join("status.json")).unwrap())
                .unwrap();
        assert_eq!(status["phase"], "ready");
        assert_eq!(status["detail"], "serving");
        assert_eq!(status["pid"], 123);
        assert!(
            time::OffsetDateTime::parse(
                status["updated"].as_str().unwrap(),
                &time::format_description::well_known::Rfc3339
            )
            .is_ok()
        );
        assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 1);
        assert!(super::report_at(&root.path().join("missing"), "stopped", "failed", 0).is_err());
        let preserved: serde_json::Value =
            serde_json::from_slice(&std::fs::read(root.path().join("status.json")).unwrap())
                .unwrap();
        assert_eq!(preserved, status);
    }
}
