// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! The optional, host-installed cache boundary for the Station HCL case.
use serde_json::{Value, json};
use std::{
    fs,
    io::Write as _,
    path::{Path, PathBuf},
    process::Command,
};

const HELPER: &str = "/usr/local/libexec/colorunner-model-cache";

/// Only the privileged external host boundary is substituted in tests.
pub trait Backend {
    fn available(&self) -> Result<bool, String>;
    fn call(&self, operation: &str, arguments: &[String]) -> Result<Value, String>;
}

pub struct Installed;

impl Backend for Installed {
    fn available(&self) -> Result<bool, String> {
        let metadata = match fs::symlink_metadata(HELPER) {
            Ok(value) => value,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(false),
            Err(_) => return Err("Cannot inspect the host model cache helper".into()),
        };
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt as _;
            if !metadata.is_file() || metadata.uid() != 0 || metadata.mode() & 0o022 != 0 {
                return Err("Host model cache helper ownership changed".into());
            }
            Ok(metadata.mode() & 0o111 != 0)
        }
        #[cfg(not(unix))]
        {
            let _ = metadata;
            Ok(false)
        }
    }

    fn call(&self, operation: &str, arguments: &[String]) -> Result<Value, String> {
        let failed = || {
            format!("Host model cache {operation} is unconfirmed; preserve the run for recovery")
        };
        let result = Command::new("/usr/bin/sudo")
            .args(["-n", HELPER, operation])
            .args(arguments)
            .output()
            .map_err(|_| failed())?;
        if !result.status.success() || result.stdout.len() > 4 * 1024 * 1024 {
            return Err(failed());
        }
        serde_json::from_slice(&result.stdout).map_err(|_| failed())
    }
}

pub struct Session<B: Backend> {
    backend: B,
    reports: PathBuf,
    uid: String,
    model_arguments: Vec<String>,
    state: String,
    closed: bool,
    report: Value,
}

fn field(value: &Value, pointer: &str) -> Result<String, String> {
    value
        .pointer(pointer)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| format!("Station model cache input lacks {pointer}"))
}

fn write_report(reports: &Path, value: &Value) -> Result<(), String> {
    let mut temporary = tempfile::NamedTempFile::new_in(reports).map_err(|e| e.to_string())?;
    serde_json::to_writer(&mut temporary, value).map_err(|e| e.to_string())?;
    temporary.flush().map_err(|e| e.to_string())?;
    temporary
        .persist(reports.join("model-cache.json"))
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn ready(backend: &impl Backend) -> Result<bool, String> {
    if !backend.available()? {
        return Ok(false);
    }
    if backend.call("info", &[])?["version"].as_u64() != Some(1) {
        return Err("Unsupported host model cache protocol".into());
    }
    Ok(true)
}

impl<B: Backend> Session<B> {
    /// The caller supplies the already-bound Station document, before apply.
    pub fn start(backend: B, document: &Value, reports: &Path) -> Result<Self, String> {
        let uid = field(document, "/metadata/uid")?;
        if field(document, "/spec/services/super/kind")? != "vllm" {
            return Err("The Station cache requires its qualified vLLM service".into());
        }
        let model_arguments = vec![
            "--uid".into(),
            uid.clone(),
            "--service".into(),
            "super".into(),
            "--repository".into(),
            field(document, "/spec/services/super/model/repository")?,
            "--revision".into(),
            field(document, "/spec/services/super/model/revision")?,
        ];
        let mut session = Self {
            backend,
            reports: reports.into(),
            uid,
            model_arguments,
            state: "unavailable".into(),
            closed: false,
            report: json!({"version":1, "state":"unavailable"}),
        };
        if ready(&session.backend)? {
            let recovered = session.backend.call("recover", &[])?;
            if recovered["status"] != "recovered" {
                return Err("Host cache recovery is unconfirmed".into());
            }
            let mut arguments = session.model_arguments.clone();
            arguments.extend(["--pid".into(), std::process::id().to_string()]);
            let attached = session.backend.call("attach", &arguments)?;
            session.state = field(&attached, "/status")?;
            if !matches!(session.state.as_str(), "hit" | "miss" | "unavailable") {
                return Err("Host cache did not establish a usable outcome".into());
            }
            session.report["state"] = json!(session.state);
        }
        write_report(&session.reports, &session.report)?;
        Ok(session)
    }

    /// Publish a successful cold run, or release a hit after scenario destroy.
    /// Failed publication affects cache availability, never the inference result.
    pub fn finish(&mut self, succeeded: bool) -> Result<(), String> {
        if self.closed {
            return Ok(());
        }
        if self.state == "hit" {
            match self
                .backend
                .call("release", &["--uid".into(), self.uid.clone()])
            {
                Ok(result) if result["status"] == "released" => {
                    self.report["cleanup"] = json!("released");
                    self.closed = true;
                }
                _ => {
                    self.report["cleanup"] = json!("unconfirmed");
                    write_report(&self.reports, &self.report)?;
                    return Err("Cached model mount remains unconfirmed; run the existing destroy and cache recovery steps".into());
                }
            }
        } else {
            if self.state == "miss" && succeeded {
                let published = self.backend.call("publish", &self.model_arguments);
                self.report["publication"] = json!(match published {
                    Ok(value) if value["status"] == "published" => "published",
                    _ => "unavailable",
                });
            }
            self.closed = true;
        }
        write_report(&self.reports, &self.report)
    }
}

impl<B: Backend> Drop for Session<B> {
    fn drop(&mut self) {
        // Panic/unwind can reach here before the workflow's always-run destroy.
        // The host refuses release while any container still uses the volume;
        // its journal then retains the claim for the later recovery step.
        if !self.closed && self.state == "hit" && self.finish(false).is_err() {
            eprintln!("Host model cache release unconfirmed; keep the run for recovery");
        }
    }
}

/// Called only after SDK destroy, including when the case process was killed.
pub fn cleanup(backend: impl Backend, uid: &str) -> Result<(), String> {
    if !ready(&backend)? {
        return Ok(());
    }
    let value = backend.call("recover", &["--uid".into(), uid.into()])?;
    if value["status"] != "recovered"
        || !value["runs"]
            .as_array()
            .is_some_and(|runs| runs.iter().all(|run| run["status"] == "released"))
    {
        return Err("Cached model mount recovery is unconfirmed; preserve the run".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{cell::Cell, rc::Rc};

    #[derive(Clone)]
    struct Host {
        available: bool,
        state: &'static str,
        mounted: Rc<Cell<bool>>,
        published: Rc<Cell<bool>>,
        release_fails: bool,
        publication_fails: bool,
        recovery_active: bool,
    }

    impl Host {
        fn new(state: &'static str) -> Self {
            Self {
                available: true,
                state,
                mounted: Rc::new(Cell::new(false)),
                published: Rc::new(Cell::new(false)),
                release_fails: false,
                publication_fails: false,
                recovery_active: false,
            }
        }
    }

    impl Backend for Host {
        fn available(&self) -> Result<bool, String> {
            Ok(self.available)
        }
        fn call(&self, operation: &str, _arguments: &[String]) -> Result<Value, String> {
            match operation {
                "info" => Ok(json!({"version":1})),
                "recover" => Ok(json!({"status":"recovered", "runs":
                    if self.recovery_active { vec![json!({"status":"active"})] } else { vec![] }})),
                "attach" => {
                    self.mounted.set(self.state == "hit");
                    Ok(json!({"status":self.state}))
                }
                "release" if !self.release_fails => {
                    self.mounted.set(false);
                    Ok(json!({"status":"released"}))
                }
                "publish" if !self.publication_fails => {
                    self.published.set(true);
                    Ok(json!({"status":"published"}))
                }
                _ => Err("fixture host operation unconfirmed".into()),
            }
        }
    }

    fn document() -> Value {
        json!({"metadata":{"uid":"12345678-1234-4234-8234-123456789abc"},
            "spec":{"services":{"super":{"kind":"vllm", "model":{
                "repository":"example/model", "revision":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}}}}})
    }

    fn report(path: &Path) -> Value {
        serde_json::from_slice(&fs::read(path.join("model-cache.json")).unwrap()).unwrap()
    }

    #[test]
    fn a_hit_is_released_after_the_scenario() {
        let reports = tempfile::tempdir().unwrap();
        let host = Host::new("hit");
        let mut session = Session::start(host.clone(), &document(), reports.path()).unwrap();
        assert_eq!(report(reports.path())["state"], "hit");
        assert!(host.mounted.get());
        session.finish(true).unwrap();
        assert!(!host.mounted.get());
        assert_eq!(report(reports.path())["cleanup"], "released");
    }

    #[test]
    fn a_successful_miss_publishes_but_a_failed_scenario_does_not() {
        for succeeded in [false, true] {
            let reports = tempfile::tempdir().unwrap();
            let host = Host::new("miss");
            let mut session = Session::start(host.clone(), &document(), reports.path()).unwrap();
            assert!(!host.mounted.get());
            session.finish(succeeded).unwrap();
            assert_eq!(host.published.get(), succeeded);
        }
    }

    #[test]
    fn an_unconfigured_host_can_run_the_original_scenario() {
        let reports = tempfile::tempdir().unwrap();
        let mut host = Host::new("hit");
        host.available = false;
        let mut session = Session::start(host.clone(), &document(), reports.path()).unwrap();
        session.finish(true).unwrap();
        assert_eq!(report(reports.path())["state"], "unavailable");
        assert!(!host.mounted.get());
        assert!(!host.published.get());
    }

    #[test]
    fn an_unconfirmed_release_cannot_be_reported_as_success() {
        let reports = tempfile::tempdir().unwrap();
        let mut host = Host::new("hit");
        host.release_fails = true;
        let mut session = Session::start(host.clone(), &document(), reports.path()).unwrap();
        assert!(session.finish(true).is_err());
        assert!(host.mounted.get());
        assert_eq!(report(reports.path())["cleanup"], "unconfirmed");
    }

    #[test]
    fn unwind_guard_releases_an_unused_mount() {
        let reports = tempfile::tempdir().unwrap();
        let host = Host::new("hit");
        let session = Session::start(host.clone(), &document(), reports.path()).unwrap();
        drop(session);
        assert!(!host.mounted.get());
    }

    #[test]
    fn failed_publication_preserves_the_successful_inference_outcome() {
        let reports = tempfile::tempdir().unwrap();
        let mut host = Host::new("miss");
        host.publication_fails = true;
        let mut session = Session::start(host, &document(), reports.path()).unwrap();
        session.finish(true).unwrap();
        assert_eq!(report(reports.path())["publication"], "unavailable");
    }

    #[test]
    fn cleanup_cannot_confirm_release_while_a_holder_is_active() {
        let mut host = Host::new("hit");
        host.recovery_active = true;
        assert!(cleanup(host.clone(), "12345678-1234-4234-8234-123456789abc").is_err());
        host.recovery_active = false;
        cleanup(host, "12345678-1234-4234-8234-123456789abc").unwrap();
    }
}
