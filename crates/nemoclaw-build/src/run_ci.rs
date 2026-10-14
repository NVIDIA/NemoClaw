// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Run `CI / Bundle` steps with the same commands, environment, and tools as CI.

use super::*;
use nemoclaw_build::ci::{self, Step};
use std::{ffi::OsString, time::Instant};

#[path = "run_ci/live_docker.rs"]
mod live_docker;
#[path = "run_ci/live_images.rs"]
mod live_images;
#[path = "run_ci/live_kind.rs"]
mod live_kind;

const TOOLS: &str = ".tools";

mod archive;

/// The host's bundle platform, matching the SDK's detection without needing it.
fn host_platform() -> Result<String> {
    let os = match std::env::consts::OS {
        "linux" => "linux",
        "macos" => "darwin",
        "windows" => "windows",
        _ => return Err("unsupported CI host operating system".into()),
    };
    let arch = match std::env::consts::ARCH {
        "aarch64" => "arm64",
        "x86_64" => "amd64",
        _ => return Err("unsupported CI host architecture".into()),
    };
    Ok(format!("{os}_{arch}"))
}

fn protoc_directory(version: &str) -> PathBuf {
    Path::new(TOOLS).join(format!("protoc-{version}"))
}

fn nextest_directory(version: &str) -> PathBuf {
    Path::new(TOOLS).join(format!("nextest-{version}"))
}

/// `PROTOC` when set, otherwise the installed pinned compiler, otherwise `PATH`.
pub(super) fn protoc_command(version: &str) -> PathBuf {
    if let Some(explicit) = std::env::var_os("PROTOC") {
        return explicit.into();
    }
    let installed = protoc_directory(version)
        .join("bin")
        .join(nemoclaw_build_executable("protoc"));
    if installed.is_file() {
        return std::path::absolute(installed).unwrap_or_else(|_| "protoc".into());
    }
    "protoc".into()
}

fn nemoclaw_build_executable(name: &str) -> String {
    format!("{name}{}", std::env::consts::EXE_SUFFIX)
}

pub(super) fn protoc_matches(command: &Path, version: &str) -> bool {
    Command::new(command)
        .arg("--version")
        .stdin(Stdio::null())
        .output()
        .is_ok_and(|output| {
            output.status.success()
                && String::from_utf8_lossy(&output.stdout).trim() == format!("libprotoc {version}")
        })
}

fn nextest_matches(path: &OsString, version: &str) -> bool {
    cargo()
        .args(["nextest", "--version"])
        .env("PATH", path)
        .stdin(Stdio::null())
        .output()
        .is_ok_and(|output| {
            output.status.success()
                && String::from_utf8_lossy(&output.stdout)
                    .starts_with(&format!("cargo-nextest {version}"))
        })
}

/// Pinned tool versions that every step uses.
struct Tools<'a> {
    pins: &'a Pins,
    protobuf: &'a str,
    nextest: &'a str,
}

fn artifact<'a>(pins: &'a Pins, platform: &str, tool: &str) -> Result<&'a Artifact> {
    pins.platforms
        .get(platform)
        .and_then(|artifacts| artifacts.get(tool))
        .ok_or_else(|| format!("versions.json has no {tool} pin for {platform}").into())
}

/// Install pinned tools that are missing or have the wrong version.
async fn install_tools(tools: &Tools<'_>, platform: &str) -> Result<()> {
    let Tools { pins, .. } = tools;
    let windows = platform.starts_with("windows");
    if !protoc_matches(&protoc_command(tools.protobuf), tools.protobuf) {
        let bytes = download(artifact(pins, platform, "protoc")?).await?;
        ci::install_protoc(&bytes, &protoc_directory(tools.protobuf), windows)?;
        eprintln!("Installed protoc {} in {TOOLS}", tools.protobuf);
    }
    if !nextest_matches(&tool_path(tools)?, tools.nextest) {
        let bytes = download(artifact(pins, platform, "nextest")?).await?;
        ci::install_nextest(&bytes, &nextest_directory(tools.nextest), windows)?;
        eprintln!("Installed cargo-nextest {} in {TOOLS}", tools.nextest);
    }
    if !protoc_matches(&protoc_command(tools.protobuf), tools.protobuf) {
        return Err(format!(
            "PROTOC does not run Protocol Buffers compiler {}; unset it or point it at that version",
            tools.protobuf
        )
        .into());
    }
    if !nextest_matches(&tool_path(tools)?, tools.nextest) {
        return Err(format!(
            "cargo-nextest {} is not runnable after installation",
            tools.nextest
        )
        .into());
    }
    export_to_github(tools)
}

/// `PATH` with the pinned nextest first, so Cargo finds its subcommand.
fn tool_path(tools: &Tools<'_>) -> Result<OsString> {
    let mut paths = vec![std::path::absolute(nextest_directory(tools.nextest))?];
    paths.extend(std::env::split_paths(
        &std::env::var_os("PATH").unwrap_or_default(),
    ));
    Ok(std::env::join_paths(paths)?)
}

/// Make installed tools visible to later workflow steps that build the SDK directly.
fn export_to_github(tools: &Tools<'_>) -> Result<()> {
    let append = |variable: &str, line: String| -> Result<()> {
        if let Some(file) = std::env::var_os(variable) {
            let mut file = fs::OpenOptions::new().append(true).open(file)?;
            writeln!(file, "{line}")?;
        }
        Ok(())
    };
    let protoc = protoc_command(tools.protobuf);
    append("GITHUB_ENV", format!("PROTOC={}", protoc.display()))?;
    append(
        "GITHUB_PATH",
        std::path::absolute(nextest_directory(tools.nextest))?
            .display()
            .to_string(),
    )
}

/// Run one step with the pinned tools, without inheriting stdin.
fn run_step(
    tools: &Tools<'_>,
    platform: &str,
    step: Step,
    partition: Option<&str>,
    archive_file: Option<&Path>,
    images: Option<&Path>,
) -> Result<()> {
    let protoc = protoc_command(tools.protobuf);
    let path = tool_path(tools)?;
    let configure = |command: &mut Command| {
        command.env("PROTOC", &protoc).env("PATH", &path);
    };
    let tool = |name: &str| {
        Path::new("target")
            .join("debug")
            .join(nemoclaw_build_executable(name))
    };
    match step {
        Step::Tools => unreachable!("tools install in-process"),
        Step::LiveDocker => {
            return live_docker::run_live_docker(
                tools.pins,
                platform,
                &configure,
                archive_file,
                images,
            );
        }
        Step::LiveImages => return live_images::build(platform),
        Step::LiveKind => unreachable!("live-kind runs asynchronously"),
        Step::Schema | Step::Bundle => {
            if step == Step::Bundle {
                // CI builds the bundle in its own job, without the build step.
                let mut build = cargo();
                configure(&mut build);
                run(build.args(["build", "--locked", "--package", "nemoclaw-build"]))?;
            }
            let mut command = Command::new(tool("nemoclaw-build"));
            configure(&mut command);
            if step == Step::Schema {
                command.args(["schema", "--check"]);
            } else {
                command.args(["bundle", "--platform", platform]);
            }
            return run(&mut command);
        }
        _ => {}
    }
    if step == Step::Archive {
        fs::create_dir_all(".build/ci")?;
    }
    let archive_filter = if step == Step::Archive {
        Some(archive::selected_binaries(&configure, platform)?)
    } else {
        None
    };
    let bundle = std::path::absolute(Path::new("dist").join(platform))?;
    for args in step.cargo_args() {
        let mut command = match archive_file {
            Some(archive) => archived(step, archive, &configure)?,
            None => {
                let mut command = cargo();
                configure(&mut command);
                command.args(*args);
                command
            }
        };
        if let Some(filter) = &archive_filter {
            command.args(["--filterset", filter]);
        }
        if step == Step::Lifecycle {
            if std::env::var_os("CI").is_none()
                && std::env::var_os("GITHUB_ACTIONS").is_none()
                && std::env::var_os("NEXTEST_TEST_THREADS").is_none()
            {
                let workers = std::thread::available_parallelism()
                    .map_or(4, usize::from)
                    .clamp(4, 8);
                command.args(["--test-threads", &workers.to_string()]);
                eprintln!("lifecycle: using {workers} local test workers");
            }
            if let Some(partition) = partition {
                command.args(["--partition", partition]);
            }
            // Where Unix sockets are missing, fake engines are reached over SSH:
            // providers and the SDK then run the fake ssh relay.
            if cfg!(not(unix)) {
                let directory = std::path::absolute(".build/ci/fake-ssh")?;
                fs::create_dir_all(&directory)?;
                fs::copy(
                    tool("nemoclaw-fixture-ssh"),
                    directory.join(nemoclaw_build_executable("ssh")),
                )?;
                let path = std::env::join_paths(
                    std::iter::once(directory).chain(std::env::split_paths(&path)),
                )?;
                command.env("PATH", path);
            }
            // The bundle supplies pinned OpenTofu and the providers; each
            // provider's contract tests use the one Cargo built with them.
            command.env("NEMOCLAW_TEST_BUNDLE", &bundle);
        }
        run(&mut command)?;
    }
    if step == Step::Archive {
        archive::package_inputs(tools)?;
    }
    Ok(())
}

/// Run a test step's executables from a nextest `archive` against this
/// checkout, without compiling them.
fn archived(step: Step, archive: &Path, configure: &dyn Fn(&mut Command)) -> Result<Command> {
    let (profile, _) = step
        .junit()
        .ok_or_else(|| format!("{} runs no tests", step.name()))?;
    fs::create_dir_all(".build/ci/extracted")?;
    let mut command = cargo();
    configure(&mut command);
    command
        .args([
            "nextest",
            "run",
            "--profile",
            profile,
            "--run-ignored",
            "only",
        ])
        .arg("--archive-file")
        .arg(archive)
        .arg("--workspace-remap")
        .arg(std::env::current_dir()?)
        .args(["--extract-to", ".build/ci/extracted", "--extract-overwrite"]);
    Ok(command)
}

/// Budgets fail CI only on the Linux runners they were measured on.
fn enforces_budgets() -> bool {
    std::env::consts::OS == "linux" && std::env::var_os("GITHUB_ACTIONS").is_some()
}

/// How a timing report names the budgets in its table of budgeted binaries.
const BINARY_BUDGETS: &str = "Binary budgets: summed time and per-test limit as in the table";

fn read_budgets() -> std::result::Result<ci::timing::Budgets, String> {
    std::fs::read_to_string(".config/test-budgets.yaml")
        .map_err(|error| error.to_string())
        .and_then(|yaml| ci::timing::Budgets::parse(&yaml))
}

/// Append to `report` the budgets that `applied` names, whether this run
/// enforces them, and each line of `over`.
fn append_verdict(report: &mut String, applied: &str, over: &[String]) {
    use std::fmt::Write as _;
    let enforced = if enforces_budgets() {
        ""
    } else {
        " (reported only; budgets apply on Linux CI runners)"
    };
    let _ = writeln!(report, "\n{applied}{enforced}.");
    if over.is_empty() {
        report.push_str("Within budget.\n");
    }
    for line in over {
        let _ = writeln!(report, "- Over budget: {line}");
    }
}

/// Report a platform's whole lifecycle suite from its partitions' JUnit
/// artifacts under `directory`, and add the report to the GitHub job summary.
/// On the Linux CI runners, fails when a budgeted test binary, or one of its
/// tests, exceeds its budget.
pub(super) fn report_lifecycle_suite(
    directory: &Path,
    platform: &str,
    shards: &[u32],
) -> Result<()> {
    let budgets = read_budgets();
    let unbudgeted = ci::timing::Budgets::default();
    let timing = ci::timing::partitioned_report(
        directory,
        platform,
        shards,
        15,
        budgets.as_ref().unwrap_or(&unbudgeted),
    )?;
    let mut report = timing.report;
    match &budgets {
        Err(error) => report.push_str(&format!("\nCannot read the test budgets: {error}\n")),
        Ok(budgets) if budgets.has_binaries() => {
            append_verdict(&mut report, BINARY_BUDGETS, &timing.over);
        }
        Ok(_) => {}
    }
    publish(&report);
    if enforces_budgets() && !timing.over.is_empty() {
        return Err(format!(
            "lifecycle on {platform} exceeded a binary budget in .config/test-budgets.yaml"
        )
        .into());
    }
    Ok(())
}

/// Report where a test step, or its lifecycle `partition`, spent its time,
/// from the JUnit report it wrote after `begun`, and add the report to the
/// GitHub job summary. Returns what exceeds the step's budget, if any.
fn report_timing(step: Step, partition: Option<&str>, begun: Instant) -> Vec<String> {
    let Some((profile, file)) = step.junit() else {
        return Vec::new();
    };
    let path = Path::new("target").join("nextest").join(profile).join(file);
    let started = std::time::SystemTime::now() - begun.elapsed();
    // A report from an earlier run would misstate this one.
    let fresh = std::fs::metadata(&path)
        .and_then(|metadata| metadata.modified())
        .is_ok_and(|modified| modified >= started);
    if !fresh {
        return Vec::new();
    }
    let budgets = read_budgets();
    let run = match std::fs::read_to_string(&path)
        .map_err(|error| error.to_string())
        .and_then(|xml| ci::timing::Run::parse(&xml))
    {
        Ok(run) => run,
        Err(error) => {
            eprintln!("cannot read test timings from {}: {error}", path.display());
            return Vec::new();
        }
    };
    let label = match partition {
        Some(partition) => format!("{} partition {partition}", step.name()),
        None => step.name().to_owned(),
    };
    let mut report = run.report(&label, 15);
    let mut over = Vec::new();
    match &budgets {
        Err(error) => report.push_str(&format!("\nCannot read the test budgets: {error}\n")),
        Ok(budgets) => {
            if let Some(budget) = budgets.get(step.name()) {
                over = run.over(budget);
                append_verdict(
                    &mut report,
                    &format!(
                        "Budget: {} s wall, {} s per test",
                        budget.wall_seconds, budget.test_seconds
                    ),
                    &over,
                );
            }
            // A whole lifecycle suite in one run, as plain `cargo ci` runs it,
            // holds each binary's tests. A partition holds only some, so in CI
            // the platform's Lifecycle timing job checks the binary budgets.
            if step == Step::Lifecycle && partition.is_none() && budgets.has_binaries() {
                let binaries = run.binary_budgets(budgets);
                report.push_str("\nBudgeted binaries:\n\n");
                report.push_str(&binaries.report);
                append_verdict(&mut report, BINARY_BUDGETS, &binaries.over);
                over.extend(binaries.over);
            }
        }
    }
    publish(&report);
    if enforces_budgets() { over } else { Vec::new() }
}

/// Print a timing report, and add it to the GitHub job summary when there is one.
pub(super) fn publish(report: &str) {
    eprintln!("{report}");
    if let Some(summary) = std::env::var_os("GITHUB_STEP_SUMMARY") {
        use std::io::Write;
        let appended = std::fs::OpenOptions::new()
            .append(true)
            .create(true)
            .open(summary)
            .and_then(|mut file| writeln!(file, "{report}"));
        if let Err(error) = appended {
            eprintln!("cannot write the job summary: {error}");
        }
    }
}

pub(super) async fn run_steps(
    pins: &Pins,
    selected: Option<&str>,
    partition: Option<&str>,
    archive_file: Option<&Path>,
    images: Option<&Path>,
    plan: Option<&nemoclaw_build::changes::Plan>,
) -> Result<()> {
    let tools = Tools {
        pins,
        protobuf: &pins.protobuf,
        nextest: &pins.nextest,
    };
    let steps = match selected {
        None => ci::planned_steps(plan),
        Some(name) => vec![Step::parse(name).ok_or_else(|| {
            format!(
                "unknown CI step {name:?}; choose one of: {}",
                Step::ALL.map(Step::name).join(", ")
            )
        })?],
    };
    // CI names its platform; locally, the host decides.
    let platform = match std::env::var("TEST_PLATFORM") {
        Ok(platform) if !platform.is_empty() => platform,
        _ => host_platform()?,
    };
    ci::nextest_target(&platform)?;
    let start = Instant::now();
    // Every step uses the pinned tools; install them once, up front, if a
    // step other than `tools` is selected alone.
    let mut steps = steps;
    if steps.first() != Some(&Step::Tools) {
        steps.insert(0, Step::Tools);
    }
    for step in steps {
        let begun = Instant::now();
        eprintln!("==> {} ({platform})", step.name());
        let result = if step == Step::Tools {
            install_tools(&tools, &platform).await
        } else if step == Step::LiveKind {
            let protoc = protoc_command(tools.protobuf);
            let path = tool_path(&tools)?;
            let configure = |command: &mut Command| {
                command.env("PROTOC", &protoc).env("PATH", &path);
            };
            live_kind::run_live_kind(tools.pins, &platform, &configure, archive_file, images).await
        } else {
            run_step(&tools, &platform, step, partition, archive_file, images)
        };
        let elapsed = begun.elapsed().as_secs();
        if matches!(step, Step::Build | Step::Bundle) {
            let outcome = if result.is_ok() { "passed" } else { "failed" };
            publish(&format!(
                "### Build step: {} ({platform})\n\n{elapsed} s wall; {outcome}.\n",
                step.name()
            ));
        }
        let over = report_timing(step, partition, begun);
        let result = result.and_then(|()| {
            if over.is_empty() {
                Ok(())
            } else {
                Err(format!(
                    "{} exceeded its time budget in .config/test-budgets.yaml",
                    step.name()
                )
                .into())
            }
        });
        if let Err(error) = result {
            eprintln!("FAILED {} after {elapsed}s: {error}", step.name());
            eprintln!("Rerun it with: cargo ci {}", step.name());
            return Err(format!("CI step {} failed", step.name()).into());
        }
        eprintln!("ok {} in {elapsed}s", step.name());
    }
    eprintln!(
        "All selected CI steps passed in {}s",
        start.elapsed().as_secs()
    );
    Ok(())
}
