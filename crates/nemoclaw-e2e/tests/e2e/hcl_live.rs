// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Live HCL scenarios. `case` runs `tests/e2e/hcl/tests/<case>.tftest.hcl`
//! against `cases/<case>.yaml`, or the bound copy that `NEMOCLAW_HCL_DOCUMENT`
//! names. Its run blocks drive the bundled CLI through `tests/e2e/hcl/cli` and
//! run `probe` from this binary once per target through `tests/e2e/hcl/verifier`.
//! OpenTofu installs providers that a case's own modules use, such as Helm for
//! a kind case's fixtures, from the bundle. A kind case's `tests/e2e/hcl/kind`
//! module runs `issuer` once for its existing OIDC issuer. The caller
//! destroys the deployment, so cleanup also runs after a failed, cancelled, or
//! timed-out job: `nemoclaw destroy --state-dir "$NEMOCLAW_HCL_RUN/deployment"`.
//! After `tofu test`, `case` reports how long each run block took, on stderr
//! and in the GitHub job summary, because nextest shows nothing of a passing
//! test.

use fabric_provider::AgentBridge as _;
use nemoclaw_e2e::state::{runtime_id, sandbox_binding, successful_invocation};
use nemoclaw_sdk::{EnvironmentSecrets, config::Document};
use nemoclaw_test_fixtures::Bundle;
use openshell_provider::OpenShell;
use serde_json::{Value, json};
use std::{
    env::var, fs, io::Write as _, path::PathBuf, process::Command, sync::Arc, time::Duration,
};

#[test]
#[ignore = "live: needs NEMOCLAW_TEST_BUNDLE, NEMOCLAW_HCL_CASE, NEMOCLAW_HCL_RUN, Docker, and the case's images and credentials"]
fn case() {
    let bundle = Bundle::from_env();
    let case = var("NEMOCLAW_HCL_CASE").unwrap();
    let run = PathBuf::from(var("NEMOCLAW_HCL_RUN").unwrap());
    // Reports are published; command output and replies stay in `work`.
    let (reports, work) = (run.join("reports"), run.join("work"));
    for directory in [&reports, &work] {
        fs::create_dir_all(directory).unwrap();
    }
    let config = var("NEMOCLAW_HCL_DOCUMENT").unwrap_or_else(|_| format!("cases/{case}.yaml"));
    let context = json!({
        "config": fs::canonicalize(config).unwrap(),
        "state_dir": run.join("deployment"),
        "cli": bundle.root().join("bin").join(nemoclaw_sdk::bundle::executable("nemoclaw")),
        "probe_executable": std::env::current_exe().unwrap(),
        "work_dir": work,
        "evidence_dir": reports,
    });
    let providers = run.join("providers.tfrc");
    fs::write(
        &providers,
        format!(
            "provider_installation {{ filesystem_mirror {{ path = {} }} }}\n",
            json!(bundle.root().join("providers"))
        ),
    )
    .unwrap();
    let tofu = || {
        let mut tofu = Command::new(bundle.tofu());
        tofu.current_dir("tests/e2e/hcl")
            .env("TF_DATA_DIR", run.join("tofu"))
            .env("TF_CLI_CONFIG_FILE", &providers)
            .env("TF_VAR_context", context.to_string());
        tofu
    };
    let initialized = tofu().args(["init", "-input=false", "-no-color"]).status();
    assert!(initialized.unwrap().success(), "tofu init failed");
    // The test's core log times its runs.
    let log = CoreLog::create(work.join("tofu-test.log"));
    let filter = format!("-filter=tests/{case}.tftest.hcl");
    let tested = tofu()
        .args(["test", "-no-color", &filter])
        .env("TF_LOG_CORE", "debug")
        .env("TF_LOG_PATH", &log.0)
        .status();
    report_timings(&case, &log.run_durations());
    assert!(tested.unwrap().success(), "tofu test failed");
}

/// Invoke one target's agent. The published report records the outcome; the
/// reply text stays in the private work directory for `hcl/verifier`.
#[tokio::test]
#[ignore = "run by tests/e2e/hcl/verifier for one target"]
async fn probe() {
    let input = |name: &str| var(format!("NEMOCLAW_HCL_{name}")).unwrap();
    let (state, agent) = (PathBuf::from(input("STATE")), input("AGENT"));
    let document = Document::parse(fs::File::open(input("CONFIG")).unwrap()).unwrap();
    let sandbox = document
        .sandboxes()
        .find(|s| s.agent.name == agent)
        .unwrap();
    let recorded = sandbox_binding(&state, sandbox.name);
    let runtime = runtime_id(&state, sandbox.name);
    let request: Value = serde_json::from_str(&input("REQUEST")).unwrap();
    // A managed Kubernetes gateway is reached through a port-forward that the
    // connection holds, as the SDK's providers reach it.
    let (_forward, client) = match document
        .spec
        .gateway
        .as_managed()
        .and_then(|gateway| gateway.kubernetes.as_deref())
    {
        Some(kubernetes) => {
            let target = nemoclaw_sdk::kubernetes::ClusterTarget {
                kubeconfig: var(&kubernetes.kubeconfig.as_ref().unwrap().env)
                    .unwrap()
                    .into(),
                context: kubernetes.context.clone().unwrap(),
            };
            let operations = nemoclaw_sdk::kubernetes::operations::Operations {
                client: nemoclaw_sdk::kubernetes::connect(&target).await.unwrap(),
                state: state.join("kubernetes"),
                openshift_wait: nemoclaw_sdk::kubernetes::operations::OPENSHIFT_WAIT,
            };
            let (forward, client) = kubernetes_gateway(&operations, &recorded).await;
            (Some(forward), client)
        }
        None => {
            let connection = document.spec.gateway.connection();
            (
                None,
                OpenShell::connect(&connection, Arc::new(EnvironmentSecrets)).unwrap(),
            )
        }
    };
    let binding = fabric_provider::fabric_binding(recorded).unwrap();
    let response = client.invoke_agent(&binding, &runtime, &request).await.ok();
    let field = |name: &str| response.as_ref().and_then(|r| r.pointer(name)?.as_str());
    let reply = field(&input("RESPONSE_POINTER")).unwrap_or_default();
    let report = json!({
        "agent": {"expected": agent, "observed": field("/agent_name")},
        "runtime": {"expected": runtime, "observed": field("/runtime_id")},
        "succeeded": response.as_ref().is_some_and(|r| successful_invocation(r.to_string().as_bytes())),
        "reply": !reply.trim().is_empty(),
    });
    fs::write(input("REPLY"), reply).unwrap();
    fs::write(input("REPORT"), report.to_string()).unwrap();
}

/// The managed Kubernetes gateway that `binding` records, reached as the
/// SDK's providers reach it: through the port-forward the returned connection
/// holds, with the token and TLS files in its environment.
async fn kubernetes_gateway(
    operations: &nemoclaw_sdk::kubernetes::operations::Operations,
    binding: &nemoclaw_sdk::backend::Row,
) -> (nemoclaw_sdk::kubernetes::Connection, OpenShell) {
    use nemoclaw_sdk::{
        ObservationError,
        config::{ExternalGateway, FileRef, Gateway, SecretRef, TLS},
        kubernetes::{CA_ENV, CERT_ENV, KEY_ENV, Spec, TOKEN_ENV},
    };
    struct Values(std::collections::BTreeMap<String, String>);
    impl openshell_provider::Secrets for Values {
        fn resolve(&self, key: &str) -> Result<String, ObservationError> {
            self.0
                .get(key)
                .cloned()
                .ok_or(ObservationError::Authentication)
        }
    }
    let spec: Spec = binding
        .get("gateway_kubernetes")
        .and_then(|spec| serde_json::from_str(spec).ok())
        .expect("the binding names a managed Kubernetes gateway");
    let connection = operations.connect(&spec).await.unwrap();
    let file = |env: &str| FileRef { env: env.into() };
    let gateway = Gateway::External(ExternalGateway {
        endpoint: connection.endpoint().to_owned(),
        credential: Some(SecretRef {
            env: TOKEN_ENV.into(),
        }),
        tls: Some(TLS {
            ca: file(CA_ENV),
            certificate: Some(file(CERT_ENV)),
            key: Some(file(KEY_ENV)),
        }),
        ..Default::default()
    });
    let client = OpenShell::connect(
        &gateway.connection(),
        Arc::new(Values(connection.environment())),
    )
    .unwrap();
    (connection, client)
}

/// Create the existing OIDC issuer a kind case names: the SDK's development
/// issuer material for its service and namespace, the objects that serve its
/// discovery document and key set, and one token for the case's audience.
/// OpenTofu cannot sign the token, which must come from the issuer's key. The
/// token goes only to a private credentials file, which the cli and verifier
/// modules export as the case's `token.env`; it is valid for an hour.
#[test]
#[ignore = "run by tests/e2e/hcl/kind for a case with an existing OIDC issuer"]
fn issuer() {
    use nemoclaw_sdk::kubernetes::{auth::Development, issuer};
    let input = |name: &str| var(format!("NEMOCLAW_HCL_{name}")).unwrap();
    let (name, namespace) = (input("ISSUER_NAME"), input("ISSUER_NAMESPACE"));
    let material = Development::new(input("KEYS").into(), &name, &namespace, &input("AUDIENCE"))
        .ensure()
        .unwrap();
    assert_eq!(
        material.issuer(),
        input("ISSUER"),
        "the case names this issuer"
    );
    fs::write(
        input("OBJECTS"),
        serde_json::to_vec(&issuer::objects(&material, &name, &namespace)).unwrap(),
    )
    .unwrap();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    let token = PathBuf::from(input("TOKEN"));
    fs::create_dir_all(token.parent().unwrap()).unwrap();
    let mut file = fs::OpenOptions::new();
    file.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut file, 0o600);
    file.open(token)
        .unwrap()
        .write_all(material.token(i64::try_from(now).unwrap()).as_bytes())
        .unwrap();
}

/// The row for the time `tofu test` spends destroying the runs' state after
/// the last run. Parentheses can't occur in a run block's name.
const CLEANUP: &str = "(cleanup)";

/// How long each run block took, in order, then the cleanup, from the debug
/// lines OpenTofu's test runner writes to its core log. `tofu test -json`
/// can't time them: OpenTofu 1.12 reports a file's runs only after the file
/// ends, all with one timestamp. A run lasts until the next run or the
/// cleanup starts, and the last until the test runner's last line. Only these
/// lines are read, so no value from the deployment reaches the table.
fn run_durations(log: &str) -> Vec<(String, Duration)> {
    let format = time::format_description::parse_borrowed::<2>(
        "[year]-[month]-[day]T[hour]:[minute]:[second].[subsecond]\
         [offset_hour sign:mandatory][offset_minute]",
    )
    .unwrap();
    let mut starts: Vec<(String, time::OffsetDateTime)> = Vec::new();
    let mut end = None;
    for line in log.lines() {
        let Some((stamp, message)) = line.split_once(" [DEBUG] ") else {
            continue;
        };
        // A UTC host logs `Z` in place of the numeric offset.
        let stamp = match stamp.strip_suffix('Z') {
            Some(utc) => std::borrow::Cow::Owned(format!("{utc}+0000")),
            None => std::borrow::Cow::Borrowed(stamp),
        };
        let Ok(at) = time::OffsetDateTime::parse(&stamp, &format) else {
            continue;
        };
        if let Some(run) = message.strip_prefix("TestFileRunner: starting validate for ") {
            let name = run.rsplit_once('/').map_or(run, |(_, name)| name);
            starts.push((name.to_owned(), at));
        } else if message.starts_with("TestStateManager: cleaning up state for ") {
            if starts.last().is_some_and(|(name, _)| name != CLEANUP) {
                starts.push((CLEANUP.to_owned(), at));
            }
        } else if !message.starts_with("TestFileRunner: ") {
            continue;
        }
        end = Some(at);
    }
    let ends = starts.iter().skip(1).map(|(_, at)| *at).chain(end);
    starts
        .iter()
        .zip(ends)
        .map(|((name, start), end)| {
            let took = (end - *start).try_into().unwrap_or_default();
            (name.clone(), took)
        })
        .collect()
}

/// A Markdown table of each run's seconds, headed by their total.
fn timing_table(case: &str, runs: &[(String, Duration)]) -> String {
    let total: Duration = runs.iter().map(|(_, took)| *took).sum();
    let mut table = format!(
        "#### Runs of the {case} case: {:.1} s\n\n| Run | Time |\n|---|---|\n",
        total.as_secs_f64()
    );
    for (run, took) in runs {
        table.push_str(&format!("| {run} | {:.1} s |\n", took.as_secs_f64()));
    }
    table
}

/// OpenTofu's core log of one `tofu test`, which OpenTofu appends to. It can
/// hold provider configuration and plan values, so it is created empty and
/// owner-only, never printed, and removed once read or when the test panics.
struct CoreLog(PathBuf);

impl CoreLog {
    fn create(path: PathBuf) -> Self {
        // A log left by a killed run may have another mode; start a new one.
        let _ = fs::remove_file(&path);
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
        options.open(&path).unwrap();
        Self(path)
    }

    /// The runs' durations; the log is removed when `self` drops.
    fn run_durations(self) -> Vec<(String, Duration)> {
        fs::read(&self.0)
            .map(|log| run_durations(&String::from_utf8_lossy(&log)))
            .unwrap_or_default()
    }
}

impl Drop for CoreLog {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

/// Print how long each run took, and add it to the GitHub job summary, where
/// nextest shows nothing of a passing test.
fn report_timings(case: &str, runs: &[(String, Duration)]) {
    if runs.is_empty() {
        eprintln!("OpenTofu's log times no run of the {case} case");
        return;
    }
    let table = timing_table(case, runs);
    eprintln!("{table}");
    if let Some(summary) = std::env::var_os("GITHUB_STEP_SUMMARY") {
        // One write, so concurrent tests' tables don't interleave.
        let appended = fs::OpenOptions::new()
            .append(true)
            .create(true)
            .open(summary)
            .and_then(|mut file| file.write_all(format!("{table}\n").as_bytes()));
        if let Err(error) = appended {
            eprintln!("cannot write the job summary: {error}");
        }
    }
}

#[test]
fn the_core_log_is_owner_only_and_removed_once_read_or_dropped() {
    let work = tempfile::tempdir().unwrap();
    let path = work.path().join("tofu-test.log");
    fs::write(&path, "left by a killed run").unwrap();
    let log = CoreLog::create(path.clone());
    assert_eq!(fs::read(&path).unwrap(), b"");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        let mode = fs::metadata(&path).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
    }
    let line = "2026-11-02T21:15:23.632-0700 [DEBUG] TestFileRunner: starting validate for tests/case.tftest.hcl/apply\n";
    fs::write(&path, line).unwrap();
    assert_eq!(log.run_durations(), [("apply".to_owned(), Duration::ZERO)]);
    assert!(!path.exists());
    drop(CoreLog::create(path.clone()));
    assert!(!path.exists());
}

#[test]
fn run_durations_span_each_run_block_and_the_state_cleanup() {
    let log = "\
2026-11-02T21:15:23.631-0700 [DEBUG] TestCommand: found 1 files with 2 run blocks
2026-11-02T21:15:23.632-0700 [DEBUG] TestFileRunner: starting validate for tests/case.tftest.hcl/apply
2026-11-02T21:15:23.633-0700 [DEBUG] adding implicit provider configuration
continued line without a timestamp
2026-11-02T21:15:24.641-0700 [DEBUG] TestFileRunner: completed apply for tests/case.tftest.hcl/apply
2026-11-02T21:15:24.842-0700 [DEBUG] TestFileRunner: starting validate for tests/case.tftest.hcl/unchanged_plan
2026-11-02T21:15:30.100-0700 [DEBUG] TestFileRunner: completed plan for tests/case.tftest.hcl/unchanged_plan
2026-11-02T21:15:30.200-0700 [DEBUG] TestStateManager: cleaning up state for tests/case.tftest.hcl/unchanged_plan
2026-11-02T21:15:31.000-0700 [DEBUG] TestStateManager: cleaning up state for tests/case.tftest.hcl/apply
2026-11-02T21:15:32.500-0700 [DEBUG] TestFileRunner: completed apply for tests/case.tftest.hcl/apply
2026-11-02T21:15:33.000-0700 [DEBUG] some later line
";
    assert_eq!(
        run_durations(log),
        [
            ("apply".to_owned(), Duration::from_millis(1210)),
            ("unchanged_plan".to_owned(), Duration::from_millis(5358)),
            ("(cleanup)".to_owned(), Duration::from_millis(2300)),
        ]
    );
}

/// OpenTofu writes Go's `Z0700` layout, so a UTC host such as a GitHub
/// runner logs `Z` rather than `+0000`.
#[test]
fn run_durations_read_utc_timestamps() {
    let log = "\
2026-11-03T08:47:40.561Z [DEBUG] TestFileRunner: starting validate for tests/case.tftest.hcl/apply
2026-11-03T08:47:42.061Z [DEBUG] TestStateManager: cleaning up state for tests/case.tftest.hcl/apply
2026-11-03T08:47:43.000Z [DEBUG] TestFileRunner: completed apply for tests/case.tftest.hcl/apply
";
    assert_eq!(
        run_durations(log),
        [
            ("apply".to_owned(), Duration::from_millis(1500)),
            ("(cleanup)".to_owned(), Duration::from_millis(939)),
        ]
    );
}

#[test]
fn run_durations_follow_the_logged_offset_across_midnight() {
    let log = "\
2026-11-02T23:59:59.500-0700 [DEBUG] TestFileRunner: starting validate for tests/case.tftest.hcl/apply
2026-11-03T08:00:01.000+0100 [DEBUG] TestFileRunner: completed apply for tests/case.tftest.hcl/apply
";
    assert_eq!(
        run_durations(log),
        [("apply".to_owned(), Duration::from_millis(1500))]
    );
}

#[test]
fn timing_tables_list_each_run_in_order_with_their_total() {
    let runs = [
        ("apply".to_owned(), Duration::from_millis(40_240)),
        ("destroy".to_owned(), Duration::from_millis(33_800)),
    ];
    assert_eq!(
        timing_table("kind-openshift-oidc", &runs),
        "#### Runs of the kind-openshift-oidc case: 74.0 s\n\n\
         | Run | Time |\n|---|---|\n\
         | apply | 40.2 s |\n\
         | destroy | 33.8 s |\n"
    );
}
