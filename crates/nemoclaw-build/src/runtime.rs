// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use super::*;
use serde_json::json;
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Recipe {
    recipe_revision: String,
    #[serde(rename = "recipeArchiveSHA256")]
    recipe_archive_sha256: String,
    source_date_epoch: u64,
}
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
pub(super) async fn build_runtime(pins: &Pins) -> Result<()> {
    if bundle::platform()? != "linux_arm64" {
        return Err("Spark runtime image requires the qualified Linux ARM64 build host".into());
    }
    let version = nemoclaw_build::source_version(&sources()?);
    let recipe: Recipe = serde_json::from_slice(&fs::read("runtimes/qwen38/pins.json")?)?;
    let archive = download(&Artifact {
        url: format!(
            "https://codeload.github.com/MiaAI-Lab/Qwen3.8-Flash-Next-Single-DGX-Spark/tar.gz/{}",
            recipe.recipe_revision
        ),
        sha256: recipe.recipe_archive_sha256,
    })
    .await?;
    build(&["nemoclaw-runtime"], "aarch64-unknown-linux-gnu")?;
    let root = Path::new(".build/spark");
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
    let config = String::from_utf8(output.stdout)?.replace(".build/spark/vendor", "vendor");
    let config_path = root.join("vendor-config.toml");
    fs::write(&config_path, config)?;
    let mut files: Vec<_> = sources()?
        .into_iter()
        .map(|(name, _)| {
            let path = PathBuf::from(&name);
            (name, path)
        })
        .collect();
    files.push((".cargo/config.toml".into(), config_path));
    vendor_files(&vendor, &vendor, &mut files)?;
    fs::write(
        context.join("supervisor-source.tar.gz"),
        nemoclaw_build::source_archive(&files, recipe.source_date_epoch)?,
    )?;
    fs::write(context.join("recipe.tar.gz"), archive)?;
    for name in [
        "Dockerfile",
        "apply_patches.py",
        "pins.json",
        "NOTICE.md",
        "AGPL-3.0-or-later.txt",
    ] {
        fs::copy(Path::new("runtimes/qwen38").join(name), context.join(name))?;
    }
    for name in ["verify_packed.py", "model.json"] {
        fs::copy(
            Path::new("crates/nemoclaw-sdk/src/spark").join(name),
            context.join(name),
        )?;
    }
    fs::copy("LICENSE", context.join("LICENSE"))?;
    fs::copy(
        "target/aarch64-unknown-linux-gnu/release/nemoclaw-spark",
        context.join("nemoclaw-spark"),
    )?;
    let metadata = json!({"rust":pins.rust,"sourceVersion":version,"nemoclaw-spark":bundle::hash_file(&context.join("nemoclaw-spark"))?,"supervisor-source.tar.gz":bundle::hash_file(&context.join("supervisor-source.tar.gz"))?});
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
        .args(["-t", "nc-prototype-qwen38:spark-rust-v1"])
        .arg(&context))?;
    run(Command::new("docker").args(["load", "-i"]).arg(output))?;
    Ok(())
}
