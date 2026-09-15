// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use super::*;
use serde_json::json;
fn vendor_files(directory: &Path, root: &Path, files: &mut Vec<(String, PathBuf)>) -> Result<()> {
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        let path = entry.path();
        if entry.file_type()?.is_dir() {
            vendor_files(&path, root, files)?;
        } else {
            let name = format!(
                "vendor/{}",
                path.strip_prefix(root)?
                    .to_string_lossy()
                    .replace('\\', "/")
            );
            files.push((name, path));
        }
    }
    Ok(())
}
pub(super) async fn build_runtime(pins: &Pins, manifest: &Path) -> Result<()> {
    if bundle::platform()? != "linux_arm64" {
        return Err("Spark runtime image requires the qualified Linux ARM64 build host".into());
    }
    let version = nemoclaw_build::source_version(&sources()?);
    let recipe = nemoclaw_build::RuntimeArtifact::parse(&fs::read(manifest)?)?;
    let inputs = manifest.parent().ok_or("artifact directory missing")?;
    let root = PathBuf::from(".build").join(&recipe.name);
    let root = root.as_path();
    let context = root.join("context");
    fs::create_dir_all(&context)?;
    let vendor = root.join("vendor");
    let output = cargo()
        .args(["vendor", "--locked", "--versioned-dirs"])
        .arg(&vendor)
        .stderr(Stdio::inherit())
        .output()?;
    if !output.status.success() {
        return Err("cannot retain pinned dependency sources and licenses".into());
    }
    let config =
        String::from_utf8(output.stdout)?.replace(&vendor.to_string_lossy().to_string(), "vendor");
    let config_path = root.join("vendor-config.toml");
    fs::write(&config_path, config)?;
    let mut files = nemoclaw_build::supervisor_source_files(Path::new("."))?;
    files.push((".cargo/config.toml".into(), config_path));
    vendor_files(&vendor, &vendor, &mut files)?;
    openshell_sources(&mut files)?;
    fs::write(
        context.join("supervisor-source.tar.gz"),
        nemoclaw_build::source_archive(&files, recipe.source_date_epoch)?,
    )?;
    let binary = build_retained_source(root, &context.join("supervisor-source.tar.gz"))?;
    for name in &recipe.files {
        let source = inputs.join(name);
        if !fs::symlink_metadata(&source)?.is_file() {
            return Err("artifact input is not a regular file".into());
        }
        fs::copy(source, context.join(name))?;
    }
    for (name, source) in &recipe.downloads {
        let bytes = download(&Artifact {
            url: source.url.clone(),
            sha256: source.sha256.clone(),
        })
        .await?;
        fs::write(context.join(name), bytes)?;
    }
    fs::copy(manifest, context.join("build.json"))?;
    fs::copy("LICENSE", context.join("LICENSE"))?;
    fs::copy(binary, context.join("nemoclaw-runtime"))?;
    let metadata = json!({"rust":pins.rust,"sourceVersion":version,"nemoclaw-runtime":bundle::hash_file(&context.join("nemoclaw-runtime"))?,"supervisor-source.tar.gz":bundle::hash_file(&context.join("supervisor-source.tar.gz"))?});
    fs::write(
        context.join("supervisor.json"),
        serde_json::to_vec_pretty(&metadata)?,
    )?;
    nemoclaw_build::verify_source_version(&version, &sources()?)?;
    let output = root.join("runtime.tar");
    run(Command::new("docker")
        .args([
            "buildx",
            "build",
            "--provenance=false",
            "--platform=linux/arm64",
            "--output",
        ])
        .arg(format!(
            "type=oci,dest={},rewrite-timestamp=true",
            output.display()
        ))
        .arg("--build-arg")
        .arg(format!("SOURCE_DATE_EPOCH={}", recipe.source_date_epoch))
        .args(["-t", &recipe.image])
        .arg(&context))?;
    run(Command::new("docker").args(["load", "-i"]).arg(output))?;
    Ok(())
}

fn openshell_sources(files: &mut Vec<(String, PathBuf)>) -> Result<()> {
    let metadata = cargo()
        .args(["metadata", "--locked", "--offline", "--format-version", "1"])
        .output()?;
    if !metadata.status.success() {
        return Err("cannot locate pinned OpenShell build inputs".into());
    }
    let metadata: serde_json::Value = serde_json::from_slice(&metadata.stdout)?;
    let packages = metadata["packages"]
        .as_array()
        .ok_or("incomplete dependency metadata")?;
    let packages: Vec<_> = packages
        .iter()
        .filter(|p| p["name"] == "openshell-core")
        .collect();
    if packages.len() != 1 {
        return Err("ambiguous OpenShell source package".into());
    }
    let manifest = Path::new(
        packages[0]["manifest_path"]
            .as_str()
            .ok_or("missing OpenShell source path")?,
    );
    let root = manifest
        .parent()
        .ok_or("missing OpenShell source directory")?
        .join("../..");
    let proto = root.join("proto");
    let mut paths = Vec::new();
    vendor_files(&proto, &proto, &mut paths)?;
    if !paths
        .iter()
        .any(|(name, _)| name.ends_with("openshell.proto"))
    {
        return Err("OpenShell protobuf sources are incomplete".into());
    }
    files.extend(
        paths
            .into_iter()
            .map(|(name, path)| (name.replacen("vendor/", "proto/", 1), path)),
    );
    let retained = root.join("licenses/openshell-LICENSE");
    files.push((
        "licenses/openshell-LICENSE".into(),
        if retained.is_file() {
            retained
        } else {
            root.join("LICENSE")
        },
    ));
    Ok(())
}

fn build_retained_source(root: &Path, archive: &Path) -> Result<PathBuf> {
    let source = tempfile::tempdir_in(root)?;
    tar::Archive::new(flate2::read::GzDecoder::new(fs::File::open(archive)?))
        .unpack(source.path())?;
    let directory = source.path().canonicalize()?;
    let target = root.join("runtime-target");
    fs::create_dir_all(&target)?;
    let target = target.canonicalize()?;
    let prefix = directory.to_str().ok_or("build source path is not UTF-8")?;
    // Compile the exact retained files, using their vendored dependency layout.
    // Neither dependency cache paths nor a parent repository version may leak
    // into the binary's inputs when the archive is rebuilt elsewhere.
    run(cargo()
        .current_dir(&directory)
        .args([
            "build",
            "--locked",
            "--offline",
            "--release",
            "--target",
            "aarch64-unknown-linux-gnu",
            "-p",
            "nemoclaw-runtime",
        ])
        .env_remove("CARGO_ENCODED_RUSTFLAGS")
        .env("CARGO_TARGET_DIR", &target)
        .env("GIT_CEILING_DIRECTORIES", &directory)
        .env(
            "RUSTFLAGS",
            format!("--remap-path-prefix={prefix}=/workspace"),
        )
        .env("CFLAGS", format!("-ffile-prefix-map={prefix}=/workspace"))
        .env("CXXFLAGS", format!("-ffile-prefix-map={prefix}=/workspace")))?;
    Ok(target.join("aarch64-unknown-linux-gnu/release/nemoclaw-runtime"))
}
