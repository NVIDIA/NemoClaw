// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
#[cfg(feature = "sdk")]
mod platform;
mod run_ci;
use clap::{Parser, Subcommand};
#[cfg(feature = "sdk")]
use nemoclaw_sdk::bundle::{self, Manifest};
use serde::Deserialize;
use sha2::{Digest, Sha256};
#[cfg(feature = "sdk")]
use std::collections::BTreeMap;
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::Duration,
};
type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;
#[derive(Parser)]
struct Cli {
    #[command(subcommand)]
    command: Action,
}
#[derive(Subcommand)]
enum Action {
    /// Render repository Markdown into Fern pages and check local links.
    #[cfg(feature = "sdk")]
    Docs {
        /// Check generated output without changing it.
        #[arg(long)]
        check: bool,
        /// Immutable source revision for repository links (defaults to HEAD).
        #[arg(long)]
        revision: Option<String>,
    },
    /// Validate or publish documentation with the pinned Fern CLI.
    #[cfg(feature = "sdk")]
    Fern {
        #[command(subcommand)]
        action: FernAction,
    },
    /// Generate the configuration schema and reference, or check them for drift.
    #[cfg(feature = "sdk")]
    Schema {
        #[arg(long)]
        check: bool,
    },
    #[cfg(feature = "sdk")]
    Bundle {
        #[arg(long)]
        platform: Option<String>,
    },
    /// Run this platform's `CI / Bundle` steps, or one named step.
    ///
    /// Build this command without default features (`cargo ci`), so it can
    /// install the pinned Protocol Buffers compiler before anything needs it.
    Ci {
        /// One step: tools, fmt, clippy, build, test, schema, bundle, or lifecycle;
        /// archive, live-docker, and live-kind run only when named.
        step: Option<String>,
        /// Override the detected PR base (fallback: origin/v1), including local edits.
        #[arg(long, conflicts_with_all = ["step", "partition", "archive_file", "images"])]
        base: Option<String>,
        /// Run every local check without impact analysis or PR discovery.
        #[arg(long, conflicts_with_all = ["base", "step", "partition", "archive_file", "images"])]
        full: bool,
        /// Print the selected steps and their plan as JSON without running checks.
        #[arg(long, conflicts_with_all = ["step", "partition", "archive_file", "images"])]
        dry_run: bool,
        /// Nextest partition for an explicitly selected lifecycle run (for example slice:1/2).
        #[arg(long)]
        partition: Option<String>,
        /// Run lifecycle tests from a nextest archive instead of compiling them.
        #[arg(long)]
        archive_file: Option<PathBuf>,
        /// Load the live suites' images from this `ci live-images` archive
        /// instead of building them.
        #[arg(long)]
        images: Option<PathBuf>,
    },
    /// Build agent images with their installed Fabric metadata, or qualify them.
    Images {
        #[command(subcommand)]
        action: ImageAction,
    },
    /// Select expensive validation from changes since a base revision.
    ///
    /// `plan` writes JSON decisions with reasons. Single workflows write
    /// `WORKFLOW=true` or `WORKFLOW=false`, with reasons on standard error.
    /// Analysis failures select all requested checks.
    Changes {
        workflow: ChangedWorkflow,
        /// Include staged, unstaged, and untracked files in the validation plan.
        #[arg(long)]
        worktree: bool,
        /// Base revision, such as the pull request base commit.
        #[arg(long)]
        base: String,
    },
    /// Report a platform's whole lifecycle suite from its partitions' JUnit
    /// artifacts, and add the report to the GitHub job summary. On the Linux
    /// CI runners, fail when a test binary exceeds its budget.
    LifecycleTiming {
        /// Directory holding the downloaded lifecycle-PLATFORM-SHARD-ATTEMPT
        /// artifacts, one subdirectory each.
        directory: PathBuf,
        #[arg(long)]
        platform: String,
        /// The shards CI ran, as a JSON list such as [1, 2].
        #[arg(long)]
        shards: String,
    },
}
#[derive(Clone, clap::ValueEnum)]
enum ChangedWorkflow {
    /// All expensive validation, as JSON decisions with reasons.
    Plan,
    /// `CI / Images`.
    Images,
    /// `Live / Docker` and `Live / Kind`.
    Live,
}
#[cfg(feature = "sdk")]
#[derive(Subcommand)]
enum FernAction {
    /// Generate pages, check the schema and links, and validate Fern without publishing.
    Check,
    /// Check, then start Fern's local server.
    Dev,
    /// Publish an isolated preview; needs FERN_TOKEN.
    Preview {
        #[arg(long)]
        id: String,
    },
    /// Delete an isolated preview; needs FERN_TOKEN.
    Delete {
        #[arg(long)]
        id: String,
    },
    /// Delete previews of v1 pull requests merged by a commit; needs gh and FERN_TOKEN.
    DeleteMerged {
        #[arg(long)]
        repository: String,
        #[arg(long)]
        commit: String,
    },
    /// Create or update a pull request's preview comment; needs gh.
    Comment {
        #[arg(long)]
        repository: String,
        #[arg(long)]
        pull_request: u64,
        #[arg(long)]
        url: String,
    },
    /// Publish main and v1 from a tagged v1 release; needs FERN_TOKEN.
    Public,
}
#[derive(Subcommand)]
enum ImageAction {
    /// Build Bake targets (for example `agents`, `dummy`, or `openclaw`) and label them.
    Build {
        /// linux/arm64 or linux/amd64; must match the Docker host.
        #[arg(long)]
        platform: String,
        #[arg(required = true)]
        targets: Vec<String>,
    },
    /// Run the reference image's runtime contract: NemoClaw's test adapter through fabric-agent-ctl, offline.
    Qualify {
        #[arg(required = true)]
        images: Vec<String>,
    },
    /// Write the metadata bundle a Kubernetes sandbox names in image.metadata.
    ExportMetadata {
        /// A local image, by tag or digest.
        image: String,
        /// linux/arm64 or linux/amd64.
        #[arg(long)]
        platform: String,
        /// Where to write the bundle; refuses an existing file.
        #[arg(long)]
        output: PathBuf,
    },
}
#[derive(Deserialize)]
struct Artifact {
    url: String,
    sha256: String,
}
#[derive(Deserialize)]
struct Pins {
    rust: String,
    protobuf: String,
    nextest: String,
    #[cfg(feature = "sdk")]
    opentofu: String,
    #[cfg(feature = "sdk")]
    #[serde(rename = "dockerProvider")]
    docker_provider: String,
    #[cfg(feature = "sdk")]
    #[serde(rename = "helmProvider")]
    helm_provider: String,
    platforms: std::collections::BTreeMap<String, std::collections::BTreeMap<String, Artifact>>,
    /// Pinned OpenShell images; the Docker live tests pull these.
    #[serde(default)]
    images: std::collections::BTreeMap<String, String>,
}
/// A Cargo command without the variables that `cargo run` set for this tool.
///
/// This works around ring's build script (ring 0.17.14). It declares
/// `cargo:rerun-if-env-changed` for variables that Cargo sets for every build
/// script: CARGO_MANIFEST_DIR, CARGO_PKG_*, and OUT_DIR. The Cargo book says
/// that directive is for global variables such as CC, and that Cargo compares
/// those it names in the environment of the `cargo` process, not the build
/// script's. `cargo ci` runs this tool through `cargo run`, which sets the
/// package variables and, because this package has a build script, OUT_DIR.
/// A Cargo started from here would inherit them, so ring and its dependents,
/// such as rustls, tonic, reqwest, and kube, would be stale for any `cargo`
/// started another way. The docs job's `cargo run -p nemoclaw-build`, for
/// example, recompiled them from the bundle job's cache.
///
/// The list must cover every variable ring tracks that `cargo run` sets. If
/// CI logs show `Dirty ring ...: the env variable ... changed`, add that
/// variable and bump the cache prefixes in `.github/actions/setup-rust`,
/// because caches saved before the change keep the stale artifacts. Remove
/// this once ring stops tracking variables that Cargo sets.
fn cargo() -> Command {
    let mut command = Command::new(std::env::var_os("CARGO").unwrap_or_else(|| "cargo".into()));
    for (name, _) in std::env::vars_os() {
        let Some(name) = name.to_str() else { continue };
        if name == "CARGO_MANIFEST_DIR"
            || name == "CARGO_MANIFEST_PATH"
            || name.starts_with("CARGO_PKG_")
            || name.starts_with("CARGO_BIN_")
            || name == "CARGO_CRATE_NAME"
            || name == "CARGO_PRIMARY_PACKAGE"
            || name == "OUT_DIR"
        {
            command.env_remove(name);
        }
    }
    command
}
fn run(command: &mut Command) -> Result<()> {
    if !command
        .stdin(Stdio::null())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .status()?
        .success()
    {
        return Err("build command failed".into());
    }
    Ok(())
}
#[cfg(feature = "sdk")]
fn sources() -> Result<Vec<(String, Vec<u8>)>> {
    Ok(nemoclaw_build::source_inputs(Path::new("."))?)
}
async fn download(artifact: &Artifact) -> Result<Vec<u8>> {
    let directory = Path::new(".build/downloads");
    fs::create_dir_all(directory)?;
    let path = directory.join(&artifact.sha256);
    if path.is_file() {
        let bytes = fs::read(&path)?;
        if nemoclaw_build::hex(&Sha256::digest(&bytes)) == artifact.sha256 {
            return Ok(bytes);
        }
        return Err("cached build artifact failed its immutable checksum".into());
    }
    if !artifact.url.starts_with("https://") {
        return Err("artifact origin must use HTTPS".into());
    }
    let http = reqwest::Client::builder()
        .https_only(true)
        .no_proxy()
        .timeout(Duration::from_secs(300))
        .build()?;
    let mut response = http.get(&artifact.url).send().await?.error_for_status()?;
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        if bytes.len() + chunk.len() > 256 << 20 {
            return Err("build artifact exceeds size limit".into());
        }
        bytes.extend(chunk);
    }
    if nemoclaw_build::hex(&Sha256::digest(&bytes)) != artifact.sha256 {
        return Err("downloaded artifact failed its immutable checksum".into());
    }
    let mut temporary = tempfile::NamedTempFile::new_in(directory)?;
    temporary.write_all(&bytes)?;
    temporary.as_file().sync_all()?;
    temporary.persist(path)?;
    Ok(bytes)
}
#[cfg(feature = "sdk")]
fn target(platform: &str) -> Result<&'static str> {
    Ok(match platform {
        "linux_arm64" => "aarch64-unknown-linux-gnu",
        "linux_amd64" => "x86_64-unknown-linux-gnu",
        "darwin_arm64" => "aarch64-apple-darwin",
        "darwin_amd64" => "x86_64-apple-darwin",
        "windows_amd64" => "x86_64-pc-windows-msvc",
        _ => return Err("unsupported platform".into()),
    })
}
#[cfg(feature = "sdk")]
fn build(packages: &[&str], target: &str) -> Result<()> {
    let root = std::env::current_dir()?;
    let mut command = cargo();
    command.args([
        "build",
        "--locked",
        "--release",
        "--target",
        target,
        "--timings",
    ]);
    for package in packages {
        command.args(["-p", package]);
    }
    command
        .env_remove("CARGO_ENCODED_RUSTFLAGS")
        .env("CARGO_TARGET_DIR", root.join("target"))
        .env(
            "RUSTFLAGS",
            format!("--remap-path-prefix={}=/workspace", root.display()),
        );
    run(&mut command)
}
#[cfg(feature = "sdk")]
fn executable(path: &Path, bytes: &[u8]) -> Result<()> {
    fs::write(path, bytes)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o755))?;
    }
    Ok(())
}
#[cfg(feature = "sdk")]
async fn bundle(pins: &Pins, platform: &str) -> Result<()> {
    let artifact = pins
        .platforms
        .get(platform)
        .and_then(|p| p.get("tofu"))
        .ok_or("missing platform pin")?;
    let bytes = download(artifact).await?;
    let binary = nemoclaw_build::extract_tofu(&bytes, platform.starts_with("windows"))?;
    let docker_archive = download(
        pins.platforms
            .get(platform)
            .and_then(|p| p.get("dockerProvider"))
            .ok_or("missing Docker provider platform pin")?,
    )
    .await?;
    let helm_archive = download(
        pins.platforms
            .get(platform)
            .and_then(|p| p.get("helmProvider"))
            .ok_or("missing Helm provider platform pin")?,
    )
    .await?;
    let version = nemoclaw_build::BUILDER_SOURCE_VERSION.to_owned();
    nemoclaw_build::verify_source_version(&version, &sources()?)?;
    let target = target(platform)?;
    build(
        &[
            "nemoclaw-cli",
            "nemoclaw-provider",
            "openshell-provider",
            "fabric-provider",
        ],
        target,
    )?;
    nemoclaw_build::verify_source_version(&version, &sources()?)?;
    fs::create_dir_all("dist")?;
    let temporary = tempfile::tempdir_in("dist")?;
    let root = temporary.path();
    fs::create_dir_all(root.join("bin"))?;
    fs::create_dir_all(root.join("libexec"))?;
    let openshell =
        format!("providers/registry.opentofu.org/nvidia/openshell/{version}/{platform}");
    fs::create_dir_all(root.join(&openshell))?;
    let fabric = format!("providers/registry.opentofu.org/nvidia/fabric/{version}/{platform}");
    fs::create_dir_all(root.join(&fabric))?;
    // The vllm, ollama, and host providers build from the nemoclaw-provider package.
    let vllm = format!("providers/registry.opentofu.org/nvidia/vllm/{version}/{platform}");
    fs::create_dir_all(root.join(&vllm))?;
    let ollama = format!("providers/registry.opentofu.org/nvidia/ollama/{version}/{platform}");
    fs::create_dir_all(root.join(&ollama))?;
    let host = format!("providers/registry.opentofu.org/nvidia/host/{version}/{platform}");
    fs::create_dir_all(root.join(&host))?;
    let extension = if platform.starts_with("windows") {
        ".exe"
    } else {
        ""
    };
    let tofu = format!("libexec/tofu{extension}");
    executable(&root.join(&tofu), &binary)?;
    let mut manifest = Manifest {
        version: version.clone(),
        rust: pins.rust.clone(),
        opentofu: pins.opentofu.clone(),
        files: BTreeMap::new(),
    };
    for (source, dest) in [
        (
            format!("nemoclaw{extension}"),
            format!("bin/nemoclaw{extension}"),
        ),
        (
            format!("terraform-provider-openshell{extension}"),
            format!("{openshell}/terraform-provider-openshell_v{version}{extension}"),
        ),
        (
            format!("terraform-provider-fabric{extension}"),
            format!("{fabric}/terraform-provider-fabric_v{version}{extension}"),
        ),
        (
            format!("terraform-provider-vllm{extension}"),
            format!("{vllm}/terraform-provider-vllm_v{version}{extension}"),
        ),
        (
            format!("terraform-provider-ollama{extension}"),
            format!("{ollama}/terraform-provider-ollama_v{version}{extension}"),
        ),
        (
            format!("terraform-provider-host{extension}"),
            format!("{host}/terraform-provider-host_v{version}{extension}"),
        ),
    ] {
        fs::copy(
            Path::new("target")
                .join(target)
                .join("release")
                .join(source),
            root.join(&dest),
        )?;
        manifest
            .files
            .insert(dest.clone(), bundle::hash_file(&root.join(dest))?);
    }
    manifest
        .files
        .insert(tofu.clone(), bundle::hash_file(&root.join(tofu))?);
    fs::create_dir_all(root.join("licenses"))?;
    let license = "licenses/OpenTofu-LICENSE";
    fs::write(
        root.join(license),
        nemoclaw_build::extract_tofu_license(&bytes)?,
    )?;
    manifest
        .files
        .insert(license.into(), bundle::hash_file(&root.join(license))?);
    fs::copy("LICENSE", root.join("LICENSE"))?;
    manifest
        .files
        .insert("LICENSE".into(), bundle::hash_file(&root.join("LICENSE"))?);
    manifest
        .files
        .extend(nemoclaw_build::docker_provider::install(
            root,
            &docker_archive,
            &pins.docker_provider,
            platform,
        )?);
    manifest
        .files
        .extend(nemoclaw_build::helm_provider::install(
            root,
            &helm_archive,
            &pins.helm_provider,
            platform,
        )?);
    nemoclaw_build::schema::add_to_bundle(root, &mut manifest)?;
    nemoclaw_build::verify_source_version(&version, &sources()?)?;
    fs::write(
        root.join("manifest.json"),
        serde_json::to_vec_pretty(&manifest)?,
    )?;
    let destination = PathBuf::from("dist").join(platform);
    if destination.exists() {
        fs::remove_dir_all(&destination)?;
    }
    fs::rename(temporary.keep(), &destination)?;
    eprintln!(
        "Verified inputs assembled at {} ({version})",
        destination.display()
    );
    Ok(())
}
#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();
    #[cfg(feature = "sdk")]
    if let Action::Docs { check, revision } = cli.command {
        return nemoclaw_build::docs::generate(Path::new("."), check, revision.as_deref());
    }
    #[cfg(feature = "sdk")]
    if let Action::Fern { action } = cli.command {
        use nemoclaw_build::fern;
        let root = Path::new(".");
        return match action {
            FernAction::Check => fern::check(root),
            FernAction::Dev => fern::dev(root),
            FernAction::Preview { id } => fern::preview(root, &id).map(|url| println!("{url}")),
            FernAction::Delete { id } => fern::delete(root, &id),
            FernAction::DeleteMerged { repository, commit } => {
                fern::delete_merged(root, &repository, &commit)
            }
            FernAction::Comment {
                repository,
                pull_request,
                url,
            } => fern::comment(&repository, pull_request, &url),
            FernAction::Public => fern::public(root, &fern::Release::from_environment()),
        }
        .map_err(Into::into);
    }
    #[cfg(feature = "sdk")]
    if let Action::Schema { check } = cli.command {
        return nemoclaw_build::schema::generate(Path::new("."), check).map_err(Into::into);
    }
    #[cfg(feature = "sdk")]
    if matches!(cli.command, Action::Bundle { .. })
        && nemoclaw_build::source_version(&sources()?) != nemoclaw_build::BUILDER_SOURCE_VERSION
    {
        return Err("build tool source inputs changed; rebuild with cargo run --locked -p nemoclaw-build -- bundle".into());
    }
    if let Action::Images { action } = cli.command {
        let root = Path::new(".");
        return match action {
            ImageAction::Build { platform, targets } => {
                nemoclaw_build::images::build(root, &platform, &targets)
            }
            ImageAction::Qualify { images } => images.iter().try_for_each(|image| {
                eprintln!("Qualifying {image}");
                nemoclaw_build::images::qualify(root, image)
            }),
            ImageAction::ExportMetadata {
                image,
                platform,
                output,
            } => nemoclaw_build::images::export_metadata(&image, &platform, &output),
        }
        .map_err(Into::into);
    }
    if let Action::LifecycleTiming {
        directory,
        platform,
        shards,
    } = &cli.command
    {
        let shards: Vec<u32> = serde_json::from_str(shards)
            .map_err(|error| format!("--shards must be a JSON list of numbers: {error}"))?;
        return run_ci::report_lifecycle_suite(directory, platform, &shards);
    }
    if let Action::Changes {
        workflow,
        base,
        worktree,
    } = &cli.command
    {
        if matches!(workflow, ChangedWorkflow::Plan) {
            let plan = nemoclaw_build::changes::plan(Path::new("."), base, *worktree);
            println!("{}", serde_json::to_string_pretty(&plan)?);
            return Ok(());
        }
        if *worktree {
            return Err("--worktree requires changes plan".into());
        }
        let (workflow, name) = match workflow {
            ChangedWorkflow::Plan => unreachable!(),
            ChangedWorkflow::Images => (nemoclaw_build::changes::Workflow::Images, "images"),
            ChangedWorkflow::Live => (nemoclaw_build::changes::Workflow::Live, "live"),
        };
        let decision = nemoclaw_build::changes::decide(Path::new("."), base, workflow);
        eprintln!("{}", decision.reason);
        println!("{name}={}", decision.run);
        return Ok(());
    }
    if let Action::Ci {
        step,
        partition,
        archive_file,
        images,
        base,
        full,
        dry_run,
    } = &cli.command
    {
        if partition.is_some() && step.as_deref() != Some("lifecycle") {
            return Err("--partition requires ci lifecycle".into());
        }
        if archive_file.is_some()
            && !matches!(
                step.as_deref(),
                Some("lifecycle" | "live-docker" | "live-kind")
            )
        {
            return Err("--archive-file requires ci lifecycle, live-docker, or live-kind".into());
        }
        if images.is_some() && !matches!(step.as_deref(), Some("live-docker" | "live-kind")) {
            return Err("--images requires ci live-docker or live-kind".into());
        }
        let plan = if *full {
            Some(nemoclaw_build::changes::Plan::full("explicit --full"))
        } else if step.is_none() {
            let (base, reason) = match base {
                Some(base) => (base.clone(), "explicit --base".into()),
                None => nemoclaw_build::changes::default_base(Path::new("."))?,
            };
            eprintln!("validation base: {base} ({reason})");
            Some(nemoclaw_build::changes::plan(Path::new("."), &base, true))
        } else {
            None
        };
        if *dry_run {
            let steps: Vec<_> = nemoclaw_build::ci::planned_steps(plan.as_ref())
                .into_iter()
                .map(nemoclaw_build::ci::Step::name)
                .collect();
            println!(
                "{}",
                serde_json::to_string_pretty(&serde_json::json!({"steps": steps, "plan": plan}))?
            );
            return Ok(());
        }
        if let Some(plan) = &plan {
            for (name, decision) in [("bundle", &plan.bundle), ("lifecycle", &plan.lifecycle)] {
                eprintln!(
                    "{name}: {} ({})",
                    if decision.run { "run" } else { "skip" },
                    decision.reason
                );
            }
        }
        let pins: Pins = serde_json::from_slice(&fs::read("versions.json")?)?;
        return run_ci::run_steps(
            &pins,
            step.as_deref(),
            partition.as_deref(),
            archive_file.as_deref(),
            images.as_deref(),
            plan.as_ref(),
        )
        .await;
    }
    let pins: Pins = serde_json::from_slice(&fs::read("versions.json")?)?;

    let version = cargo().arg("--version").output()?;
    if !version.status.success()
        || !String::from_utf8(version.stdout)?.starts_with(&format!("cargo {} ", pins.rust))
    {
        return Err("build requires the pinned Rust toolchain".into());
    }
    match cli.command {
        #[cfg(feature = "sdk")]
        Action::Schema { .. } | Action::Docs { .. } | Action::Fern { .. } => {
            unreachable!("documentation generation returned before build tool checks")
        }
        Action::Ci { .. }
        | Action::Images { .. }
        | Action::Changes { .. }
        | Action::LifecycleTiming { .. } => {
            unreachable!("CI, image, change, and timing commands returned before build tool checks")
        }
        #[cfg(feature = "sdk")]
        Action::Bundle { platform } => {
            if !run_ci::protoc_matches(&run_ci::protoc_command(&pins.protobuf), &pins.protobuf) {
                return Err(
                    "build requires the pinned Protocol Buffers compiler; run cargo ci tools"
                        .into(),
                );
            }

            bundle(&pins, &platform::select(platform, bundle::platform)?).await
        }
    }
}
