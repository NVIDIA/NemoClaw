// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Opt-in Windows bundle profile investigation; production profiles are unchanged.

use serde_json::Value;
use std::{
    collections::BTreeMap,
    env,
    ffi::OsString,
    fs,
    io::Write,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::Instant,
};

// Variants: workspace-only overrides; baseline preservation; clean release-only
// workspace artifacts; release Cargo forwarding; CI-only execution; ABBA order;
// reject dependency recompilation in measured samples; retain complete samples.
fn profile_override(packages: &[String], level: u8) -> Result<String, String> {
    if !matches!(level, 2 | 3) || packages.is_empty() {
        return Err("expected workspace packages and optimization level 2 or 3".into());
    }
    let mut config =
        String::from("# Experiment-only Cargo overrides; repository profiles are unchanged.\n");
    let mut seen = std::collections::BTreeSet::new();
    for name in packages {
        if name.is_empty()
            || !name
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
            || !seen.insert(name)
        {
            return Err("invalid or duplicate workspace package".into());
        }
        if level == 2 {
            config.push_str(&format!(
                "\n[profile.release.package.{}]\nopt-level = 2\n",
                serde_json::to_string(name).unwrap()
            ));
        }
    }
    Ok(config)
}

fn codegen_override(packages: &[String], units: u8) -> Result<String, String> {
    let mut config = profile_override(packages, 3)?;
    if !matches!(units, 16 | 64) {
        return Err("codegen comparison requires the default 16 or candidate 64 units".into());
    }
    if units == 64 {
        for name in packages {
            config.push_str(&format!(
                "\n[profile.release.package.{}]\ncodegen-units = 64\n",
                serde_json::to_string(name).unwrap()
            ));
        }
    }
    Ok(config)
}

fn execution_allowed(ci: bool, os: &str) -> Result<(), String> {
    if !ci || os != "windows" {
        return Err("destructive workspace rebuilding is restricted to an explicit Windows GitHub Actions run".into());
    }
    Ok(())
}

fn sample_order() -> [(u8, bool); 6] {
    [
        (3, false),
        (2, false),
        (3, true),
        (2, true),
        (2, true),
        (3, true),
    ]
}

fn experiment_order(link_times: bool) -> Vec<(u8, bool)> {
    if link_times {
        vec![(3, false), (3, true)]
    } else {
        sample_order().to_vec()
    }
}

fn codegen_order() -> Vec<(u8, bool)> {
    sample_order()
        .into_iter()
        .map(|(level, measured)| (if level == 3 { 16 } else { 64 }, measured))
        .collect()
}

fn cargo_arguments(args: &[OsString], config: &Path) -> Vec<OsString> {
    if args.first().is_some_and(|a| a == "build") && args.iter().any(|a| a == "--release") {
        [
            OsString::from("--config"),
            config.as_os_str().to_owned(),
            OsString::from("--verbose"),
        ]
        .into_iter()
        .chain(args.iter().cloned())
        .collect()
    } else {
        args.to_vec()
    }
}

fn traced_cargo_arguments(args: &[OsString], config: &Path, link_times: bool) -> Vec<OsString> {
    let mut forwarded = cargo_arguments(args, config);
    if link_times
        && args.first().is_some_and(|a| a == "build")
        && args.iter().any(|a| a == "--release")
    {
        forwarded.push("--message-format=json".into());
    }
    forwarded
}

fn validate_codegen(log: &str, units: u8) -> Result<(), String> {
    if !matches!(units, 16 | 64) {
        return Err("unsupported codegen-unit configuration".into());
    }
    for name in [
        "nemoclaw_sdk",
        "nemoclaw_provider",
        "openshell_provider",
        "fabric_provider",
        "nemoclaw",
    ] {
        let marker = format!("--crate-name {name} ");
        let line = log
            .lines()
            .find(|line| line.contains(&marker))
            .ok_or_else(|| format!("no compiler invocation for {name}"))?;
        if !line.contains("-C opt-level=3") || line.contains("-C incremental=") {
            return Err(format!(
                "{name} must retain non-incremental optimization level 3"
            ));
        }
        if units == 64 && !line.contains("-C codegen-units=64")
            || units == 16 && line.contains("codegen-units")
        {
            return Err(format!(
                "{name} did not attest the requested codegen-unit configuration {units}"
            ));
        }
    }
    Ok(())
}

fn validate_compilation(units: &serde_json::Value, packages: &[String]) -> Result<(), String> {
    let units = units.as_array().ok_or("Cargo units must be an array")?;
    let rebuilt: Vec<_> = units
        .iter()
        .filter(|u| u["duration"].as_f64().is_some_and(|d| d > 0.0))
        .collect();
    for unit in &rebuilt {
        let name = unit["name"].as_str().ok_or("Cargo unit has no name")?;
        if !packages.iter().any(|p| p == name) {
            return Err(format!("dependency {name} rebuilt in a measured sample"));
        }
    }
    for name in [
        "nemoclaw-sdk",
        "nemoclaw-provider",
        "openshell-provider",
        "fabric-provider",
        "nemoclaw-cli",
    ] {
        if !rebuilt.iter().any(|u| {
            u["name"] == name
                && u["target"].as_str().is_some_and(|t| {
                    if name == "nemoclaw-cli" {
                        t.contains("bin")
                    } else {
                        t.is_empty()
                    }
                })
        }) {
            return Err(format!("expected a fresh workspace compilation for {name}"));
        }
    }
    Ok(())
}

fn compatible_inventory(
    baseline: &serde_json::Value,
    candidate: &serde_json::Value,
) -> Result<(), String> {
    for key in ["Version", "Rust", "OpenTofu"] {
        if baseline.get(key).is_none() || baseline[key] != candidate[key] {
            return Err(format!("bundle {key} changed between configurations"));
        }
    }
    let old = baseline["Files"]
        .as_object()
        .ok_or("baseline has no file inventory")?;
    let new = candidate["Files"]
        .as_object()
        .ok_or("candidate has no file inventory")?;
    if old.keys().collect::<Vec<_>>() != new.keys().collect::<Vec<_>>() {
        return Err("bundle file inventory changed between configurations".into());
    }
    for (path, hash) in old {
        if !path.ends_with(".exe") && new[path] != *hash {
            return Err(format!("non-executable bundle payload changed: {path}"));
        }
    }
    Ok(())
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum ExperimentMode {
    Optimization,
    Linker,
    CodegenUnits,
}

const PLATFORM: &str = "windows_amd64";
const TARGET: &str = "x86_64-pc-windows-msvc";
const STAGE: &str = ".build/windows-bundle-profile";
type AnyResult<T> = Result<T, Box<dyn std::error::Error>>;

fn output(command: &mut Command) -> AnyResult<String> {
    let result = command.stdin(Stdio::null()).output()?;
    if !result.status.success() {
        return Err(format!(
            "command failed: {command:?}\n{}",
            String::from_utf8_lossy(&result.stderr)
        )
        .into());
    }
    Ok(String::from_utf8(result.stdout)?.trim().to_owned())
}

fn logged(command: &mut Command, log: &Path) -> AnyResult<f64> {
    let mut file = fs::File::create(log)?;
    writeln!(file, "$ {command:?}")?;
    let start = Instant::now();
    let status = command
        .stdin(Stdio::null())
        .stdout(Stdio::from(file.try_clone()?))
        .stderr(Stdio::from(file))
        .status()?;
    let elapsed = start.elapsed().as_secs_f64();
    if !status.success() {
        let text = fs::read_to_string(log).unwrap_or_default();
        eprintln!(
            "{}",
            text.lines()
                .rev()
                .take(35)
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect::<Vec<_>>()
                .join("\n")
        );
        return Err(format!("command failed ({status}); see {}", log.display()).into());
    }
    Ok(elapsed)
}

fn workspace(cargo: &OsString) -> AnyResult<(PathBuf, Vec<String>)> {
    let metadata: Value = serde_json::from_str(&output(Command::new(cargo).args([
        "metadata",
        "--locked",
        "--no-deps",
        "--format-version",
        "1",
    ]))?)?;
    let root = PathBuf::from(
        metadata["workspace_root"]
            .as_str()
            .ok_or("metadata lacks workspace_root")?,
    );
    let git_root = PathBuf::from(output(
        Command::new("git").args(["rev-parse", "--show-toplevel"]),
    )?);
    if fs::canonicalize(&root)? != fs::canonicalize(git_root)? {
        return Err("Cargo and Git must name the same workspace".into());
    }
    let target = PathBuf::from(
        metadata["target_directory"]
            .as_str()
            .ok_or("metadata lacks target_directory")?,
    );
    if target != root.join("target") {
        return Err("experiment requires this checkout's ordinary target directory".into());
    }
    let members = metadata["workspace_members"]
        .as_array()
        .ok_or("metadata lacks members")?;
    let mut packages: Vec<String> = metadata["packages"]
        .as_array()
        .ok_or("metadata lacks packages")?
        .iter()
        .filter(|p| members.contains(&p["id"]))
        .map(|p| {
            let manifest = Path::new(
                p["manifest_path"]
                    .as_str()
                    .ok_or("package lacks manifest")?,
            );
            if !manifest.starts_with(root.join("crates"))
                || manifest.starts_with(root.join("crates/vendor"))
            {
                return Err("only repository-owned workspace crates may receive overrides");
            }
            p["name"]
                .as_str()
                .map(str::to_owned)
                .ok_or("package lacks name")
        })
        .collect::<Result<_, _>>()?;
    packages.sort();
    profile_override(&packages, 3)?;
    Ok((root, packages))
}

fn source_sha(root: &Path) -> AnyResult<String> {
    let status = output(Command::new("git").current_dir(root).args([
        "status",
        "--porcelain",
        "--untracked-files=no",
    ]))?;
    if !status.is_empty() {
        return Err("tracked source inputs changed; refusing to continue the comparison".into());
    }
    output(
        Command::new("git")
            .current_dir(root)
            .args(["rev-parse", "HEAD"]),
    )
}

fn windows_only() -> AnyResult<()> {
    execution_allowed(
        env::var("GITHUB_ACTIONS").as_deref() == Ok("true"),
        env::consts::OS,
    )?;
    if env::vars_os().any(|(k, _)| {
        k.to_string_lossy()
            .to_ascii_uppercase()
            .starts_with("CARGO_PROFILE_RELEASE")
    }) {
        return Err(
            "remove inherited CARGO_PROFILE_RELEASE overrides before comparing profiles".into(),
        );
    }
    Ok(())
}

fn copy_new_tree(source: &Path, destination: &Path) -> AnyResult<()> {
    let metadata = fs::symlink_metadata(source)?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err("bundle source must be a directory, not a link".into());
    }
    fs::create_dir(destination)?;
    for item in fs::read_dir(source)? {
        let item = item?;
        let kind = item.file_type()?;
        let to = destination.join(item.file_name());
        if kind.is_dir() {
            copy_new_tree(&item.path(), &to)?;
        } else if kind.is_file() {
            fs::copy(item.path(), to)?;
        } else {
            return Err("bundle snapshots cannot contain links or special files".into());
        }
    }
    Ok(())
}

fn file_sizes(root: &Path, directory: &Path, sizes: &mut BTreeMap<String, u64>) -> AnyResult<()> {
    for item in fs::read_dir(directory)? {
        let item = item?;
        let path = item.path();
        let kind = item.file_type()?;
        if kind.is_dir() {
            file_sizes(root, &path, sizes)?;
        } else if kind.is_file() {
            sizes.insert(
                path.strip_prefix(root)?
                    .to_string_lossy()
                    .replace('\\', "/"),
                item.metadata()?.len(),
            );
        } else {
            return Err("bundle sizes cannot follow links or special files".into());
        }
    }
    Ok(())
}

fn checkpoint(stage: &Path, report: &Value) -> AnyResult<()> {
    fs::write(
        stage.join("report.json"),
        serde_json::to_vec_pretty(report)?,
    )?;
    let purpose = if report["codegen_units"] == true {
        "Codegen-unit comparison at unchanged optimization level 3: baseline retains the pinned compiler default (16, non-incremental), candidate sets 64 only for named workspace crates. Dependency settings and linker are unchanged. Two warmups precede rebuilt-workspace ABBA samples."
    } else if report["link_times"] == true {
        "Unchanged release level 3 with MSVC /TIME diagnostics. One warmup is excluded; one rebuilt-workspace bundle provides per-target link-pass data. This is a diagnostic trace, not an optimization A/B comparison."
    } else {
        "Baseline uses the existing release profile. Candidate overrides only the listed workspace packages to level 2. Third-party profile settings are unchanged."
    };
    let mut summary = format!(
        "# Windows bundle investigation\n\nSource: {}\n\n{purpose}\n\n\
         The SDK-enabled dev assembler was built once in {:.2}s, outside sample timing. \
         Samples time the complete bundle command (release compilation, schema/manifest generation and assembly), not whole-CI elapsed time.\n\n\
         | Sample | Opt level | CGUs | Measured | Bundle seconds | Fresh units | Dirty units | Bundle bytes |\n\
         |---|---:|---:|---|---:|---:|---:|---:|\n",
        report["source_sha"].as_str().unwrap_or("unknown"),
        report["assembler_seconds"].as_f64().unwrap_or_default()
    );
    for sample in report["samples"].as_array().ok_or("missing samples")? {
        use std::fmt::Write as _;
        writeln!(
            summary,
            "| {} | {} | {} | {} | {:.3} | {} | {} | {} |",
            sample["label"].as_str().unwrap_or("?"),
            sample["level"],
            sample["codegen_units"],
            sample["measured"],
            sample["seconds"].as_f64().unwrap_or_default(),
            sample["fresh"],
            sample["dirty"],
            sample["bundle_bytes"]
        )?;
        if let Some(problem) = sample["problem"].as_str() {
            writeln!(summary, "\nSample rejected: {problem}\n")?;
        }
    }
    summary.push_str("\nWarmups are excluded from measurements. Small samples and individual unit/link times are not a stable performance guarantee; concurrent intervals must not be summed. \
        Native validation XML is collected separately; its elapsed time is not a CPU-throughput benchmark. \
        A production profile change needs further runtime/size evaluation.\n");
    fs::write(stage.join("summary.md"), &summary)?;
    Ok(())
}

fn linker_diagnostics(text: &str) -> Vec<Value> {
    text.lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .filter_map(|value| {
            let diagnostic = if value["reason"] == "compiler-message" {
                &value["message"]
            } else if value["$message_type"] == "diagnostic" {
                &value
            } else {
                return None;
            };
            (diagnostic["code"]["code"] == "linker_messages").then(|| {
                serde_json::json!({
                    "target": value["target"]["name"].as_str().unwrap_or("probe"),
                    "message": diagnostic["message"],
                    "rendered": diagnostic["rendered"]
                })
            })
        })
        .collect()
}

fn time_link_options(existing: Option<OsString>) -> OsString {
    let mut options = existing.unwrap_or_default();
    if !options.is_empty() {
        options.push(" ");
    }
    options.push("/TIME");
    options
}

fn linker_probe(stage: &Path) -> AnyResult<()> {
    let source = stage.join("linker-probe.rs");
    fs::write(
        &source,
        "// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.\n// SPDX-License-Identifier: Apache-2.0\nfn main() {}\n",
    )?;
    logged(
        Command::new("rustc")
            .args([
                "--crate-name",
                "linker_probe",
                "--edition",
                "2024",
                "--target",
                TARGET,
                "--error-format=json",
                "--json=artifacts",
                "-C",
                "opt-level=3",
            ])
            .arg(&source)
            .arg("-o")
            .arg(stage.join("linker-probe.exe"))
            .env("LINK", time_link_options(env::var_os("LINK"))),
        &stage.join("linker-probe.log"),
    )?;
    let messages = linker_diagnostics(&fs::read_to_string(stage.join("linker-probe.log"))?);
    fs::write(
        stage.join("linker-probe.json"),
        serde_json::to_vec_pretty(&messages)?,
    )?;
    if !messages.iter().any(|m| {
        m["message"]
            .as_str()
            .is_some_and(|t| t.to_ascii_lowercase().contains("time"))
    }) {
        return Err("MSVC /TIME output was not observable through this pinned rustc; refusing a long diagnostic build".into());
    }
    Ok(())
}

fn cargo_units(text: &str) -> AnyResult<Value> {
    let tail = text
        .split_once("const UNIT_DATA = ")
        .ok_or("missing Cargo unit data")?
        .1;
    let json = tail
        .split_once("\n];")
        .ok_or("unterminated Cargo unit data")?
        .0;
    Ok(serde_json::from_str(&format!("{json}\n]"))?)
}

fn timing_count(text: &str, field: &str) -> AnyResult<u64> {
    let marker = format!("<td>{field}:</td><td>");
    Ok(text
        .split_once(&marker)
        .ok_or("missing Cargo count")?
        .1
        .split_once("</td>")
        .ok_or("unterminated Cargo count")?
        .0
        .parse()?)
}

fn snapshot(root: &Path, stage: &Path, level: u8) -> AnyResult<()> {
    let parent = stage.join("bundles");
    fs::create_dir_all(&parent)?;
    let temporary = tempfile::tempdir_in(&parent)?;
    let source = temporary.path().join("bundle");
    copy_new_tree(&root.join("dist").join(PLATFORM), &source)?;
    let destination = parent.join(format!("variant-{level}"));
    if destination.exists() {
        if fs::symlink_metadata(&destination)?.file_type().is_symlink() {
            return Err("snapshot destination cannot be a link".into());
        }
        fs::remove_dir_all(&destination)?;
    }
    fs::rename(source, destination)?;
    Ok(())
}

fn restore_variant_allowed(codegen: bool, setting: u8) -> bool {
    if codegen {
        matches!(setting, 16 | 64)
    } else {
        matches!(setting, 2 | 3)
    }
}

fn restore(root: &Path, level: u8) -> AnyResult<()> {
    let stage = root.join(STAGE);
    let report: Value = serde_json::from_slice(&fs::read(stage.join("report.json"))?)?;
    if !restore_variant_allowed(report["codegen_units"] == true, level) {
        return Err("restore setting must belong to this experiment".into());
    }
    if report["completed"] != true || report["source_sha"] != source_sha(root)? {
        return Err("only a completed comparison from this exact source can be restored".into());
    }
    let destination = root.join("dist").join(PLATFORM);
    if fs::symlink_metadata(&destination)?.file_type().is_symlink() {
        return Err("bundle destination cannot be a link".into());
    }
    let current: Value = serde_json::from_slice(&fs::read(destination.join("manifest.json"))?)?;
    let selected = stage.join("bundles").join(format!("variant-{level}"));
    let next: Value = serde_json::from_slice(&fs::read(selected.join("manifest.json"))?)?;
    compatible_inventory(&current, &next)?;
    let parent = root.join("dist");
    if fs::canonicalize(&parent)? != fs::canonicalize(root)?.join("dist") {
        return Err("bundle destination must remain inside the checkout".into());
    }
    let temporary = tempfile::tempdir_in(&parent)?;
    let copied = temporary.path().join("bundle");
    copy_new_tree(&selected, &copied)?;
    fs::remove_dir_all(&destination)?;
    fs::rename(copied, destination)?;
    println!("Restored configuration {level} bundle for native validation");
    Ok(())
}

fn experiment(
    root: &Path,
    packages: &[String],
    real_cargo: &OsString,
    mode: ExperimentMode,
) -> AnyResult<()> {
    let link_times = mode == ExperimentMode::Linker;
    let codegen = mode == ExperimentMode::CodegenUnits;
    let sha = source_sha(root)?;
    let target = root.join("target");
    fs::create_dir_all(&target)?;
    if fs::canonicalize(&target)? != fs::canonicalize(root)?.join("target") {
        return Err("workspace target directory cannot be redirected".into());
    }
    let stage = root.join(STAGE);
    fs::create_dir_all(stage.parent().ok_or("invalid stage path")?)?;
    fs::create_dir(&stage)?; // Never overwrite another run's evidence.
    fs::create_dir(stage.join("profiles"))?;
    fs::create_dir(stage.join("samples"))?;
    let order = if codegen {
        codegen_order()
    } else {
        experiment_order(link_times)
    };
    let levels: std::collections::BTreeSet<_> = order.iter().map(|(level, _)| *level).collect();
    for level in levels {
        fs::write(
            stage.join("profiles").join(format!("variant-{level}.toml")),
            if codegen {
                codegen_override(packages, level)?
            } else {
                profile_override(packages, level)?
            },
        )?;
    }
    if link_times {
        linker_probe(&stage)?;
    }
    let tool_seconds = logged(
        Command::new(real_cargo).current_dir(root).args([
            "build",
            "--locked",
            "--package",
            "nemoclaw-build",
        ]),
        &stage.join("assembler.log"),
    )?;
    let tool = root.join("target/debug/nemoclaw-build.exe");
    let shim = env::current_exe()?;
    let mut report = serde_json::json!({
        "source_sha":sha, "platform":PLATFORM, "link_times":link_times, "codegen_units":codegen,
        "rustc":output(Command::new("rustc").arg("-vV"))?,
        "cargo":output(Command::new(real_cargo).arg("--version"))?,
        "github_run":env::var("GITHUB_RUN_ID").ok(),
        "workspace_packages":packages, "assembler_seconds":tool_seconds,
        "completed":false, "samples":[]
    });
    checkpoint(&stage, &report)?;
    let mut baseline: Option<Value> = None;
    for (index, (level, measured)) in order.into_iter().enumerate() {
        let opt_level = if codegen { 3 } else { level };
        if source_sha(root)? != sha {
            return Err("source revision changed during experiment".into());
        }
        let label = format!(
            "{:02}-{}-{}",
            index + 1,
            if measured { "sample" } else { "warmup" },
            if codegen {
                format!("cgu{level}")
            } else {
                format!("opt{level}")
            }
        );
        let sample_dir = stage.join("samples").join(&label);
        fs::create_dir(&sample_dir)?;
        eprintln!("Starting {label}: release workspace clean, dependencies retained");
        logged(
            Command::new(real_cargo).current_dir(root).args([
                "clean",
                "--locked",
                "--workspace",
                "--release",
                "--target",
                TARGET,
            ]),
            &sample_dir.join("clean.log"),
        )?;
        let begun = std::time::SystemTime::now();
        let mut command = Command::new(&tool);
        command
            .current_dir(root)
            .args(["bundle", "--platform", PLATFORM])
            .env("CARGO", &shim)
            .env("WINDOWS_BUNDLE_REAL_CARGO", real_cargo)
            .env(
                "WINDOWS_BUNDLE_LINK_TIMES",
                if link_times { "1" } else { "0" },
            )
            .env(
                "WINDOWS_BUNDLE_PROFILE_CONFIG",
                stage.join("profiles").join(format!("variant-{level}.toml")),
            );
        if link_times {
            command.env("LINK", time_link_options(env::var_os("LINK")));
        }
        let seconds = logged(&mut command, &sample_dir.join("build.log"))?;
        let html = root.join("target/cargo-timings/cargo-timing.html");
        if fs::metadata(&html)?.modified()? < begun {
            return Err("Cargo timing report predates this sample".into());
        }
        let timing = fs::read_to_string(&html)?;
        fs::copy(&html, sample_dir.join("cargo-timing.html"))?;
        let units = cargo_units(&timing)?;
        let log = fs::read_to_string(sample_dir.join("build.log"))?;
        let expected = format!("-C opt-level={opt_level}");
        let mut problem = None;
        if !log
            .lines()
            .any(|l| l.contains("--crate-name nemoclaw_sdk ") && l.contains(&expected))
        {
            problem = Some(format!(
                "compiler invocation did not attest SDK optimization level {opt_level}"
            ));
        }
        if codegen && let Err(error) = validate_codegen(&log, level) {
            problem = Some(error);
        }
        if measured && let Err(error) = validate_compilation(&units, packages) {
            problem = Some(error);
        }
        let messages = if link_times {
            linker_diagnostics(&log)
        } else {
            Vec::new()
        };
        if link_times {
            fs::write(
                sample_dir.join("linker-messages.json"),
                serde_json::to_vec_pretty(&messages)?,
            )?;
            for target in [
                "nemoclaw",
                "terraform-provider-fabric",
                "terraform-provider-host",
                "terraform-provider-ollama",
                "terraform-provider-openshell",
                "terraform-provider-vllm",
            ] {
                if !messages.iter().any(|m| {
                    m["target"] == target
                        && m["message"]
                            .as_str()
                            .is_some_and(|t| t.to_ascii_lowercase().contains("time"))
                }) {
                    problem = Some(format!("missing MSVC /TIME diagnostics for {target}"));
                }
            }
        }
        let bundle = root.join("dist").join(PLATFORM);
        let manifest: Value = serde_json::from_slice(&fs::read(bundle.join("manifest.json"))?)?;
        fs::write(
            sample_dir.join("manifest.json"),
            serde_json::to_vec_pretty(&manifest)?,
        )?;
        if let Some(original) = &baseline {
            compatible_inventory(original, &manifest)?;
        } else {
            baseline = Some(manifest.clone());
        }
        let mut sizes = BTreeMap::new();
        file_sizes(&bundle, &bundle, &mut sizes)?;
        report["samples"].as_array_mut().unwrap().push(serde_json::json!({
            "label":label, "variant":level, "level":opt_level, "codegen_units":if codegen { Some(level) } else { None }, "measured":measured,
            "seconds":seconds, "fresh":timing_count(&timing,"Fresh units")?,
            "dirty":timing_count(&timing,"Dirty units")?,
            "bundle_bytes":sizes.values().sum::<u64>(), "file_bytes":sizes,
            "rebuilt_units":units.as_array().unwrap().iter().filter(|u| u["duration"].as_f64().is_some_and(|d| d>0.0)).collect::<Vec<_>>(),
            "problem":problem, "linker_messages":messages
        }));
        checkpoint(&stage, &report)?;
        if let Some(problem) = &problem {
            return Err(problem.clone().into());
        }
        snapshot(root, &stage, level)?;
        eprintln!("Finished {label}: {seconds:.3}s");
    }
    if source_sha(root)? != sha {
        return Err("source changed before the comparison completed".into());
    }
    report["completed"] = Value::Bool(true);
    checkpoint(&stage, &report)?;
    Ok(())
}

fn entry() -> AnyResult<()> {
    let args: Vec<OsString> = env::args_os().skip(1).collect();
    if let Some(config) = env::var_os("WINDOWS_BUNDLE_PROFILE_CONFIG") {
        let real = env::var_os("WINDOWS_BUNDLE_REAL_CARGO")
            .ok_or("Cargo shim lacks its real executable")?;
        if fs::canonicalize(&real)? == fs::canonicalize(env::current_exe()?)? {
            return Err("Cargo shim cannot invoke itself".into());
        }
        let status = Command::new(real)
            .args(traced_cargo_arguments(
                &args,
                Path::new(&config),
                env::var("WINDOWS_BUNDLE_LINK_TIMES").as_deref() == Ok("1"),
            ))
            .status()?;
        std::process::exit(status.code().unwrap_or(1));
    }
    if args.iter().any(|a| a == "--help" || a == "-h") {
        println!(
            "bundle_profile_experiment [--plan | --plan-codegen-units | --run | --link-times | --codegen-units | --restore CONFIG]\n\
            --run rebuilds only release workspace artifacts and requires Windows GitHub Actions.\n\
            Production profiles are never edited; reports go under {STAGE}."
        );
        return Ok(());
    }
    if args.first().is_some_and(|a| {
        a == "--run" || a == "--link-times" || a == "--codegen-units" || a == "--restore"
    }) {
        windows_only()?; // Refuse before metadata, writes or artifact cleanup.
    }
    let real = env::var_os("CARGO").unwrap_or_else(|| "cargo".into());
    let (root, packages) = workspace(&real)?;
    match args.first().and_then(|s| s.to_str()) {
        None | Some("--plan") | Some("--plan-codegen-units") if args.len() <= 1 => {
            let cgus = args.first().is_some_and(|a| a == "--plan-codegen-units");
            println!(
                "{}",
                serde_json::to_string_pretty(&serde_json::json!({
                    "source_sha":output(Command::new("git").current_dir(&root).args(["rev-parse","HEAD"]))?,
                    "platform":PLATFORM, "workspace_packages":packages,
                    "baseline":if cgus { codegen_override(&packages,16)? } else { profile_override(&packages,3)? }, "candidate":if cgus { codegen_override(&packages,64)? } else { profile_override(&packages,2)? },
                    "order":if cgus { codegen_order() } else { sample_order().to_vec() }.into_iter().map(|(setting,measured)| serde_json::json!({"setting":setting,"measured":measured})).collect::<Vec<_>>()
                }))?
            );
            Ok(())
        }
        Some("--run") if args.len() == 1 => experiment(&root, &packages, &real, ExperimentMode::Optimization),
        Some("--link-times") if args.len() == 1 => experiment(&root, &packages, &real, ExperimentMode::Linker),
        Some("--codegen-units") if args.len() == 1 => experiment(&root, &packages, &real, ExperimentMode::CodegenUnits),
        Some("--restore") if args.len() == 2 => {
            restore(&root, args[1].to_str().ok_or("invalid level")?.parse()?)
        }
        _ => Err("expected --plan, --plan-codegen-units, --run, --link-times, --codegen-units, or --restore CONFIG".into()),
    }
}

fn main() {
    if let Err(error) = entry() {
        eprintln!("bundle profile experiment: {error}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn restored_configurations_must_belong_to_the_recorded_experiment() {
        assert!(restore_variant_allowed(true, 16));
        assert!(restore_variant_allowed(true, 64));
        assert!(!restore_variant_allowed(true, 3));
        assert!(restore_variant_allowed(false, 3));
        assert!(!restore_variant_allowed(false, 64));
        assert!(!restore_variant_allowed(true, 0));
    }

    #[test]
    fn codegen_samples_attest_both_partitioning_and_unchanged_optimization() {
        let names = [
            "nemoclaw_sdk",
            "nemoclaw_provider",
            "openshell_provider",
            "fabric_provider",
            "nemoclaw",
        ];
        let baseline = names
            .map(|n| format!("rustc --crate-name {n} --edition=2024 -C opt-level=3"))
            .join("\n");
        assert!(
            validate_codegen(&baseline, 64).is_err(),
            "an ignored override is not a candidate sample"
        );
        assert!(validate_codegen(&baseline, 16).is_ok());
        let candidate = baseline.replace("-C opt-level=3", "-C opt-level=3 -C codegen-units=64");
        assert!(validate_codegen(&candidate, 64).is_ok());
        assert!(
            validate_codegen(&candidate, 16).is_err(),
            "baseline must retain the pinned compiler default"
        );
        assert!(validate_codegen(&candidate.replace("opt-level=3", "opt-level=2"), 64).is_err());
    }

    #[test]
    fn codegen_comparison_warms_both_then_rebuilds_in_abba_order() {
        assert_eq!(
            codegen_order(),
            [
                (16, false),
                (64, false),
                (16, true),
                (64, true),
                (64, true),
                (16, true)
            ]
        );
    }

    #[test]
    fn codegen_candidate_changes_only_workspace_partitioning_not_optimization() {
        let packages = vec!["nemoclaw-sdk".into(), "nemoclaw-provider".into()];
        let candidate: toml::Value =
            toml::from_str(&codegen_override(&packages, 64).unwrap()).unwrap();
        assert_eq!(
            candidate["profile"]["release"]["package"]["nemoclaw-sdk"]["codegen-units"]
                .as_integer(),
            Some(64)
        );
        assert!(
            candidate["profile"]["release"]["package"]["nemoclaw-sdk"]
                .get("opt-level")
                .is_none()
        );
        assert!(
            candidate["profile"]["release"]
                .get("codegen-units")
                .is_none()
        );
        assert!(
            candidate["profile"]["release"]["package"]
                .get("*")
                .is_none()
        );
        let baseline: toml::Value =
            toml::from_str(&codegen_override(&packages, 16).unwrap()).unwrap();
        assert!(baseline.get("profile").is_none());
        assert!(codegen_override(&packages, 0).is_err());
    }

    #[test]
    fn link_timing_preserves_existing_msvc_options() {
        assert_eq!(time_link_options(None), OsString::from("/TIME"));
        assert_eq!(
            time_link_options(Some("/NOLOGO".into())),
            OsString::from("/NOLOGO /TIME")
        );
    }

    #[test]
    fn linker_capture_requests_structured_diagnostics_only_for_traced_release_builds() {
        let release = ["build", "--release"].map(OsString::from);
        let config = Path::new("baseline.toml");
        assert!(
            traced_cargo_arguments(&release, config, true)
                .contains(&OsString::from("--message-format=json"))
        );
        assert_eq!(
            traced_cargo_arguments(&release, config, false),
            cargo_arguments(&release, config)
        );
        let version = [OsString::from("--version")];
        assert_eq!(traced_cargo_arguments(&version, config, true), version);
    }

    #[test]
    fn linker_messages_keep_raw_pass_data_and_cargo_target_identity() {
        let cargo = serde_json::json!({
            "reason":"compiler-message", "target":{"name":"nemoclaw","kind":["bin"]},
            "message":{"code":{"code":"linker_messages"},"message":"raw MSVC pass data","rendered":"rendered"}
        });
        let direct = serde_json::json!({
            "$message_type":"diagnostic","code":{"code":"linker_messages"},"message":"probe pass data"
        });
        let unrelated = serde_json::json!({
            "reason":"compiler-message","message":{"code":{"code":"unused_variables"},"message":"not timing"}
        });
        let input = format!("Cargo progress\n{cargo}\n{direct}\n{unrelated}\n");
        let messages = linker_diagnostics(&input);
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0]["target"], "nemoclaw");
        assert_eq!(messages[0]["message"], "raw MSVC pass data");
        assert_eq!(messages[1]["target"], "probe");
        assert_eq!(messages[1]["message"], "probe pass data");
    }

    #[test]
    fn linker_diagnostics_warm_and_measure_only_the_unchanged_release_profile() {
        assert_eq!(experiment_order(true), [(3, false), (3, true)]);
        assert_eq!(experiment_order(false), sample_order());
    }

    #[test]
    fn baseline_keeps_defaults_and_invalid_overrides_are_refused() {
        let packages = vec!["nemoclaw-sdk".into()];
        let config: toml::Value = toml::from_str(&profile_override(&packages, 3).unwrap()).unwrap();
        assert!(config.get("profile").is_none());
        assert!(profile_override(&packages, 1).is_err());
        assert!(profile_override(&["bad.name".into()], 2).is_err());
        assert!(profile_override(&["duplicate".into(), "duplicate".into()], 2).is_err());
    }

    #[test]
    fn pinned_cargo_report_format_is_read_without_evaluating_javascript() {
        let html = "<td>Fresh units:</td><td>517</td>\nconst UNIT_DATA = [\n{\"name\":\"sdk\",\"duration\":5}\n];\nignored();";
        assert_eq!(timing_count(html, "Fresh units").unwrap(), 517);
        assert_eq!(cargo_units(html).unwrap()[0]["name"], "sdk");
        assert!(cargo_units("not a report").is_err());
    }

    #[test]
    fn snapshot_copy_preserves_bytes_and_refuses_existing_destinations() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source");
        fs::create_dir(&source).unwrap();
        fs::create_dir(source.join("nested")).unwrap();
        fs::write(source.join("nested/file"), b"complete bundle bytes").unwrap();
        let destination = temp.path().join("copy");
        copy_new_tree(&source, &destination).unwrap();
        assert_eq!(
            fs::read(destination.join("nested/file")).unwrap(),
            b"complete bundle bytes"
        );
        assert!(copy_new_tree(&source, &destination).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn snapshot_copy_does_not_follow_links() {
        let temp = tempfile::tempdir().unwrap();
        fs::write(temp.path().join("outside"), b"not a bundle file").unwrap();
        fs::create_dir(temp.path().join("source")).unwrap();
        std::os::unix::fs::symlink(temp.path().join("outside"), temp.path().join("source/link"))
            .unwrap();
        assert!(copy_new_tree(&temp.path().join("source"), &temp.path().join("copy")).is_err());
        assert_eq!(
            fs::read(temp.path().join("outside")).unwrap(),
            b"not a bundle file"
        );
    }

    #[test]
    fn experimental_workflow_parses_as_yaml() {
        let workflow: Value = serde_saphyr::from_str(include_str!(
            "../../../.github/workflows/windows-bundle-profile.yml"
        ))
        .unwrap();
        assert!(workflow.is_object());
    }
    #[cfg(feature = "sdk")]
    #[test]
    fn sdk_manifest_serializer_matches_the_checked_wire_contract() {
        let manifest = nemoclaw_sdk::bundle::Manifest {
            version: "0.1.0-dev.fixture".into(),
            rust: "1.98.1".into(),
            opentofu: "1.12.6".into(),
            files: BTreeMap::from([("schemas/config.json".into(), "same".into())]),
        };
        let wire = serde_json::to_value(manifest).unwrap();
        assert!(compatible_inventory(&wire, &wire).is_ok());
    }

    #[test]
    fn profile_changes_preserve_bundle_identity_and_non_executable_payloads() {
        let base = serde_json::json!({"Version":"source-1","Rust":"1.98.1","OpenTofu":"pinned","Files":{"schema.json":"same","bin/tool.exe":"old"}});
        let mut candidate = base.clone();
        candidate["Files"]["bin/tool.exe"] = serde_json::json!("new");
        assert!(compatible_inventory(&base, &candidate).is_ok());
        candidate["Files"]["schema.json"] = serde_json::json!("different");
        assert!(
            compatible_inventory(&base, &candidate).is_err(),
            "changing optimization must not change the schema payload"
        );
        candidate = base.clone();
        candidate["Version"] = serde_json::json!("different-source");
        assert!(compatible_inventory(&base, &candidate).is_err());
    }

    #[test]
    fn measured_samples_reject_dependency_rebuilds_and_cached_workspace_libraries() {
        let packages = [
            "nemoclaw-sdk",
            "nemoclaw-provider",
            "openshell-provider",
            "fabric-provider",
            "nemoclaw-cli",
        ]
        .map(String::from);
        let mut units = serde_json::json!([
            {"name":"nemoclaw-sdk", "target":"", "duration":5.0},
            {"name":"nemoclaw-provider", "target":"", "duration":5.0},
            {"name":"openshell-provider", "target":"", "duration":5.0},
            {"name":"fabric-provider", "target":"", "duration":5.0},
            {"name":"nemoclaw-cli", "target":r#" nemoclaw "bin""#, "duration":5.0},
            {"name":"serde", "target":"", "duration":1.0}
        ]);
        assert!(
            validate_compilation(&units, &packages).is_err(),
            "dependency codegen makes this a cold-cache comparison"
        );
        units[5]["duration"] = serde_json::json!(0.0);
        assert!(validate_compilation(&units, &packages).is_ok());
        units[0]["duration"] = serde_json::json!(0.0);
        assert!(
            validate_compilation(&units, &packages).is_err(),
            "the SDK must be rebuilt in each measured sample"
        );
    }

    #[test]
    fn only_release_builds_receive_the_profile_override() {
        let release = ["build", "--locked", "--release"].map(OsString::from);
        let config = Path::new("profile directory/level-2.toml");
        let forwarded = cargo_arguments(&release, config);
        assert_eq!(
            &forwarded[..2],
            &[OsString::from("--config"), config.as_os_str().to_owned()]
        );
        assert!(forwarded.contains(&OsString::from("--verbose")));
        assert!(forwarded.ends_with(&release));
        for args in [
            vec![OsString::from("--version")],
            vec![OsString::from("build")],
        ] {
            assert_eq!(cargo_arguments(&args, config), args);
        }
    }

    #[test]
    fn warmups_are_not_samples_and_measurements_alternate_abba() {
        let order = sample_order();
        assert_eq!(&order[..2], &[(3, false), (2, false)]);
        assert_eq!(
            order
                .into_iter()
                .filter(|(_, measured)| *measured)
                .map(|(level, _)| level)
                .collect::<Vec<_>>(),
            [3, 2, 2, 3]
        );
    }

    #[test]
    fn run_is_rejected_outside_windows_ci() {
        assert!(execution_allowed(false, "windows").is_err());
        assert!(execution_allowed(true, "linux").is_err());
        assert!(execution_allowed(true, "windows").is_ok());
    }

    #[test]
    fn candidate_changes_only_named_workspace_packages() {
        let packages = vec!["nemoclaw-sdk".into(), "nemoclaw-provider".into()];
        let text = profile_override(&packages, 2).unwrap();
        let config: toml::Value = toml::from_str(&text).unwrap();
        assert_eq!(
            config
                .get("profile")
                .and_then(|v| v.get("release"))
                .and_then(|v| v.get("package"))
                .and_then(|v| v.get("nemoclaw-sdk"))
                .and_then(|v| v.get("opt-level"))
                .and_then(toml::Value::as_integer),
            Some(2),
            "candidate must lower the named workspace package, not all dependencies"
        );
        assert!(config["profile"]["release"].get("opt-level").is_none());
        assert!(config["profile"]["release"]["package"].get("*").is_none());
        assert_eq!(
            config["profile"]["release"]["package"]
                .as_table()
                .unwrap()
                .len(),
            2
        );
    }
}
