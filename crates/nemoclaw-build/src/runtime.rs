// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use super::*;
use serde_json::json;
mod image;
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
    let recipe = nemoclaw_build::RuntimeArtifact::parse(&fs::read(manifest)?)?;
    recipe.require_native_host(nemoclaw_build::native_runtime_platform()?)?;
    image::require_containerd(Path::new("docker"))?;
    let inputs = manifest.parent().ok_or("artifact directory missing")?;
    let root = PathBuf::from(".build").join(&recipe.name);
    let root = root.as_path();
    let context = root.join("context");
    fs::create_dir_all(&context)?;
    let source = tempfile::tempdir_in(root)?;
    let directory = source.path().canonicalize()?;
    let (archive, version) = retained_source(Path::new("."), &directory, recipe.source_date_epoch)?;
    fs::write(context.join("supervisor-source.tar.gz"), archive)?;
    let binary = build_retained_source(
        root,
        &context.join("supervisor-source.tar.gz"),
        target(&recipe.platform)?,
    )?;
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
    let metadata = json!({"rust":pins.rust,"sourceVersion":version,"nemoclaw-runtime":hash_file(&context.join("nemoclaw-runtime"))?,"supervisor-source.tar.gz":hash_file(&context.join("supervisor-source.tar.gz"))?});
    fs::write(
        context.join("supervisor.json"),
        serde_json::to_vec_pretty(&metadata)?,
    )?;
    nemoclaw_build::verify_source_version(
        &version,
        &nemoclaw_build::runtime_source_inputs(Path::new("."))?,
    )?;
    let output = root.join("runtime.tar");
    let reference = image::export_and_load(Path::new("docker"), &recipe, &context, &output)?;
    println!("Runtime image loaded: {reference}");
    Ok(())
}

fn retained_source(repository: &Path, directory: &Path, epoch: u64) -> Result<(Vec<u8>, String)> {
    let mut files = nemoclaw_build::stage_runtime_sources(repository, directory)?;
    let retained_inputs = files
        .iter()
        .map(|(name, path)| Ok((name.clone(), fs::read(path)?)))
        .collect::<Result<Vec<_>>>()?;
    let version = nemoclaw_build::source_version(&retained_inputs);
    let vendor = directory.join("vendor");
    let output = cargo()
        .current_dir(directory)
        .args(["vendor", "--locked", "--versioned-dirs"])
        .arg(&vendor)
        .stderr(Stdio::inherit())
        .output()?;
    if !output.status.success() {
        return Err("cannot retain pinned runtime dependency sources and licenses".into());
    }
    let config =
        String::from_utf8(output.stdout)?.replace(&vendor.to_string_lossy().to_string(), "vendor");
    let config_path = directory.join("vendor-config.toml");
    fs::write(&config_path, config)?;
    files.push((".cargo/config.toml".into(), config_path));
    vendor_files(&vendor, &vendor, &mut files)?;
    Ok((nemoclaw_build::source_archive(&files, epoch)?, version))
}

fn hash_file(path: &Path) -> Result<String> {
    Ok(nemoclaw_build::hex(&Sha256::digest(fs::read(path)?)))
}

fn build_retained_source(root: &Path, archive: &Path, rust_target: &str) -> Result<PathBuf> {
    compile_retained_source(root, archive, rust_target, cargo())
}

fn compile_retained_source(
    root: &Path,
    archive: &Path,
    rust_target: &str,
    mut compiler: Command,
) -> Result<PathBuf> {
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
    run(compiler
        .current_dir(&directory)
        .args([
            "build",
            "--locked",
            "--offline",
            "--release",
            "--target",
            rust_target,
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
    Ok(target.join(rust_target).join("release/nemoclaw-runtime"))
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    #[ignore = "compiles an isolated vendored dependency closure; run explicitly"]
    fn retained_runtime_rebuilds_offline_without_protobuf_or_a_dependency_cache() {
        let repository = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        let root = tempfile::tempdir().unwrap();
        let staged = tempfile::tempdir().unwrap();
        let (archive, _) = retained_source(&repository, staged.path(), 1234).unwrap();
        let archive_path = root.path().join("supervisor-source.tar.gz");
        fs::write(&archive_path, archive).unwrap();
        let mut compiler = cargo();
        compiler.env("PROTOC", root.path().join("missing-protoc"));
        compiler.env("CARGO_HOME", root.path().join("empty-cargo-home"));
        let rust_target = target(nemoclaw_build::native_runtime_platform().unwrap()).unwrap();
        let binary =
            compile_retained_source(root.path(), &archive_path, rust_target, compiler).unwrap();
        assert!(binary.is_file());
        let output = Command::new(binary)
            .env_remove("NEMOCLAW_RUNTIME_SPEC")
            .output()
            .unwrap();
        assert!(!output.status.success());
        assert!(String::from_utf8_lossy(&output.stderr).contains("missing runtime specification"));
    }

    #[test]
    fn retained_compilation_returns_the_binary_for_the_selected_platform() {
        for platform in ["linux_arm64", "linux_amd64"] {
            let root = tempfile::tempdir().unwrap();
            let input = root.path().join("input");
            fs::write(&input, b"retained source").unwrap();
            let archive = root.path().join("source.tar.gz");
            fs::write(
                &archive,
                nemoclaw_build::source_archive(&[("input".into(), input)], 1234).unwrap(),
            )
            .unwrap();
            let rust_target = target(platform).unwrap();
            let mut compiler = Command::new("sh");
            compiler.args(["-c", include_str!("runtime_fixture.sh"), "fixture-cargo"]);
            let binary =
                compile_retained_source(root.path(), &archive, rust_target, compiler).unwrap();
            assert_eq!(
                fs::read_to_string(binary).unwrap(),
                rust_target,
                "{platform}"
            );
        }
    }
}
