// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! The optional, host-installed cache boundary for prioritized Nemotron cases.
use serde_json::{Value, json};
use std::{
    fs,
    io::Write as _,
    path::{Path, PathBuf},
    process::Command,
};

const HELPER: &str = "/usr/local/libexec/colorunner-model-cache";

fn local_vllm(document: &Value) -> Option<(&str, &Value)> {
    if document.pointer("/spec/gateway/management")?.as_str()? != "managed"
        || document
            .pointer("/spec/gateway/target/docker/engine")?
            .as_str()?
            != "unix:///var/run/docker.sock"
    {
        return None;
    }
    let mut services = document
        .pointer("/spec/services")?
        .as_object()?
        .iter()
        .filter(|(_, service)| service["kind"] == "vllm");
    let (name, service) = services.next()?;
    if services.next().is_some() {
        return None;
    }
    Some((name, service))
}

/// Cache prioritized Nemotron weights using the shared Spark/Station service.
pub fn supports(document: &Value) -> bool {
    local_vllm(document).is_some_and(|(name, service)| {
        name == "super"
            && service
                .pointer("/model/repository")
                .and_then(Value::as_str)
                .is_some_and(|repository| repository.starts_with("nvidia/NVIDIA-Nemotron-"))
    })
}

/// Recovery must still inspect retained claims after model priorities change.
pub fn supports_cleanup(document: &Value) -> bool {
    local_vllm(document).is_some()
}

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
        .ok_or_else(|| format!("Model cache input lacks {pointer}"))
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
    /// The caller supplies an eligible, already-bound document before apply.
    pub fn start(backend: B, document: &Value, reports: &Path) -> Result<Self, String> {
        let uid = field(document, "/metadata/uid")?;
        if !supports(document) {
            return Err(
                "The host cache requires one prioritized Nemotron vLLM service on local Docker"
                    .into(),
            );
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
            "spec":{"gateway":{"management":"managed","target":{"docker":{
                "engine":"unix:///var/run/docker.sock"}}},"services":{"super":{"kind":"vllm", "model":{
                "repository":"nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-NVFP4", "revision":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}}}}})
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
    fn only_prioritized_nemotron_weights_are_eligible_for_the_hardware_cache() {
        for repository in [
            "nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-NVFP4",
            "nvidia/NVIDIA-Nemotron-3.5-Super-VL-120B-A12B-NVFP4",
            "nvidia/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-NVFP4",
        ] {
            let mut config = document();
            config["spec"]["services"]["super"]["model"]["repository"] = json!(repository);
            assert!(supports(&config), "{repository}");
        }
        for repository in [
            "Qwen/Qwen3-4B",
            "example/other-model",
            "example/NVIDIA-Nemotron-model",
        ] {
            let mut config = document();
            config["spec"]["services"]["super"]["model"]["repository"] = json!(repository);
            assert!(
                !supports(&config),
                "{repository} must keep normal acquisition"
            );
            assert!(
                supports_cleanup(&config),
                "retained claims still need recovery"
            );
            let host = Host::new("hit");
            let reports = tempfile::tempdir().unwrap();
            assert!(Session::start(host.clone(), &config, reports.path()).is_err());
            assert!(!host.mounted.get());
            assert!(!host.published.get());
        }
    }

    #[test]
    fn station_dgx_spark_and_rtx_spark_documents_use_the_same_cache_protocol() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        for example in [
            "dgx-station/openclaw-dgx-station.yaml",
            "dgx-spark/openclaw-dgx-spark.yaml",
            "rtx-spark-wsl2/openclaw-windows-wsl2-rtx-spark.yaml",
        ] {
            let config: Value = serde_saphyr::from_str(
                &fs::read_to_string(root.join("examples/platforms/docker/vllm").join(example))
                    .unwrap(),
            )
            .unwrap();
            let host = Host::new("hit");
            let reports = tempfile::tempdir().unwrap();
            let mut session = Session::start(host.clone(), &config, reports.path()).unwrap();
            assert!(host.mounted.get(), "{example}");
            session.finish(true).unwrap();
            assert!(!host.mounted.get(), "{example}");
        }
    }

    #[test]
    fn unsupported_engines_remote_docker_and_multiple_models_keep_normal_acquisition() {
        for kind in ["ollama", "llamaCpp", "nim"] {
            let mut config = document();
            config["spec"]["services"]["super"]["kind"] = json!(kind);
            assert!(!supports(&config));
        }
        let mut remote = document();
        remote["spec"]["gateway"]["target"]["docker"]["engine"] = json!("ssh://other-host");
        assert!(!supports(&remote));
        assert!(!supports_cleanup(&remote));
        let mut multiple = document();
        multiple["spec"]["services"]["other"] = multiple["spec"]["services"]["super"].clone();
        assert!(!supports(&multiple));
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
