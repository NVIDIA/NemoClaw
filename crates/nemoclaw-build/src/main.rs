// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
mod runtime;
use clap::{Parser, Subcommand};
use nemoclaw_sdk::bundle::{self, Manifest};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
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
    Bundle {
        #[arg(long)]
        platform: Option<String>,
    },
    Runtime {
        manifest: PathBuf,
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
    opentofu: String,
    platforms: BTreeMap<String, BTreeMap<String, Artifact>>,
}
fn cargo() -> Command {
    Command::new(std::env::var_os("CARGO").unwrap_or_else(|| "cargo".into()))
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
fn build(packages: &[&str], target: &str) -> Result<()> {
    let root = std::env::current_dir()?;
    let mut command = cargo();
    command.args(["build", "--locked", "--release", "--target", target]);
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
fn executable(path: &Path, bytes: &[u8]) -> Result<()> {
    fs::write(path, bytes)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o755))?;
    }
    Ok(())
}
async fn bundle(pins: &Pins, platform: &str) -> Result<()> {
    let artifact = pins
        .platforms
        .get(platform)
        .and_then(|p| p.get("tofu"))
        .ok_or("missing platform pin")?;
    let bytes = download(artifact).await?;
    let binary = nemoclaw_build::extract_tofu(&bytes, platform.starts_with("windows"))?;
    let version = nemoclaw_build::source_version(&sources()?);
    let target = target(platform)?;
    build(&["nemoclaw-cli", "nemoclaw-provider"], target)?;
    nemoclaw_build::verify_source_version(&version, &sources()?)?;
    fs::create_dir_all("dist")?;
    let temporary = tempfile::tempdir_in("dist")?;
    let root = temporary.path();
    fs::create_dir_all(root.join("bin"))?;
    fs::create_dir_all(root.join("libexec"))?;
    let provider = format!("providers/registry.opentofu.org/nvidia/nemoclaw/{version}/{platform}");
    fs::create_dir_all(root.join(&provider))?;
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
            format!("terraform-provider-nemoclaw{extension}"),
            format!("{provider}/terraform-provider-nemoclaw_v{version}{extension}"),
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
    let pins: Pins = serde_json::from_slice(&fs::read("versions.json")?)?;
    let version = cargo().arg("--version").output()?;
    if !version.status.success()
        || !String::from_utf8(version.stdout)?.starts_with(&format!("cargo {} ", pins.rust))
    {
        return Err("build requires the pinned Rust toolchain".into());
    }
    let protoc = Command::new(std::env::var_os("PROTOC").unwrap_or_else(|| "protoc".into()))
        .arg("--version")
        .output()?;
    if !protoc.status.success()
        || String::from_utf8(protoc.stdout)?.trim() != format!("libprotoc {}", pins.protobuf)
    {
        return Err("build requires the pinned Protocol Buffers compiler".into());
    }
    match cli.command {
        Action::Bundle { platform } => {
            bundle(&pins, &platform.unwrap_or(bundle::platform()?)).await
        }
        Action::Runtime { manifest } => runtime::build_runtime(&pins, &manifest).await,
    }
}
