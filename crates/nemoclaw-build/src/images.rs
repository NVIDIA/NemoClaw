// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Build agent images with their installed Fabric metadata, and qualify them.
//!
//! Every container these commands start is disposable, offline, and read-only;
//! none starts an adapter, contacts a model, or touches deployment resources.

use serde_json::Value;
use std::{
    collections::BTreeMap,
    fs,
    io::Read,
    path::Path,
    process::{Command, Stdio},
    time::Duration,
};

type Result<T> = std::result::Result<T, String>;

pub const PLATFORMS: [&str; 2] = ["linux/arm64", "linux/amd64"];
const CATALOG_LABEL: &str = "io.nemoclaw.fabric.catalog";
const REFERENCE_LABEL: &str = "io.nemoclaw.fabric.reference";
/// The adapter the reference dummy image implements.
const REFERENCE_ADAPTER: &str = "org.nemoclaw.dummy";
// The reference runtime starts and answers without a model.
const QUALIFY_TIMEOUT: Duration = Duration::from_secs(120);

fn docker() -> Command {
    let mut command = Command::new("docker");
    command.stdin(Stdio::null());
    command
}

fn output_of(command: &mut Command, what: &str) -> Result<Vec<u8>> {
    output(command, what)
}

fn output(command: &mut Command, what: &str) -> Result<Vec<u8>> {
    let output = command
        .stderr(Stdio::inherit())
        .output()
        .map_err(|_| format!("cannot run docker to {what}"))?;
    if !output.status.success() {
        return Err(format!("docker failed to {what}"));
    }
    Ok(output.stdout)
}

fn status(command: &mut Command, what: &str) -> Result<()> {
    let succeeded = command
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .status()
        .map_err(|_| format!("cannot run docker to {what}"))?
        .success();
    succeeded
        .then_some(())
        .ok_or_else(|| format!("docker failed to {what}"))
}

/// The metadata bundle a Kubernetes sandbox names in `image.metadata`, from
/// a `docker image save` archive of one image: its root, and for each Linux
/// platform the root lists, that platform's manifest and config, each kept as
/// its exact bytes. Layers and attestations are left out, so the bundle stays small.
pub fn metadata_bundle(archive: &[u8]) -> Result<Vec<u8>> {
    let mut tar = tar::Archive::new(archive);
    let files = metadata_files(tar.entries().map_err(|_| "invalid image archive")?)?;
    Ok(bundle_from_files(files, None)?.1)
}

/// Read a named image's metadata from a saved OCI archive, seeking past layers.
/// Returns its root digest and the verified metadata bundle.
pub fn archived_image_metadata(archive: &Path, image: &str) -> Result<(String, Vec<u8>)> {
    let file = fs::File::open(archive).map_err(|_| "cannot open image archive")?;
    let mut tar = tar::Archive::new(file);
    let files = metadata_files(
        tar.entries_with_seek()
            .map_err(|_| "invalid image archive")?,
    )?;
    bundle_from_files(files, Some(image))
}

fn metadata_files<R: Read>(entries: tar::Entries<'_, R>) -> Result<BTreeMap<String, Vec<u8>>> {
    let mut files = BTreeMap::new();
    for entry in entries {
        let mut entry = entry.map_err(|_| "invalid image archive entry")?;
        let path = entry
            .path()
            .map_err(|_| "invalid image archive path")?
            .to_string_lossy()
            .into_owned();
        // Only small JSON documents are needed; skip layer contents.
        if path == "index.json" || (path.starts_with("blobs/sha256/") && entry.size() <= 1 << 20) {
            let mut bytes = Vec::new();
            entry
                .read_to_end(&mut bytes)
                .map_err(|_| "incomplete image archive entry")?;
            files.insert(path, bytes);
        }
    }
    Ok(files)
}

fn bundle_from_files(
    files: BTreeMap<String, Vec<u8>>,
    image: Option<&str>,
) -> Result<(String, Vec<u8>)> {
    use sha2::{Digest, Sha256};
    let blob = |digest: &str, what: &str| -> Result<String> {
        let hex = digest
            .strip_prefix("sha256:")
            .ok_or("image digest is not SHA-256")?;
        let bytes = files
            .get(&format!("blobs/sha256/{hex}"))
            .ok_or_else(|| format!("image archive lacks {what}"))?;
        if crate::hex(&Sha256::digest(bytes)) != hex {
            return Err("image metadata blob does not match its digest".into());
        }
        String::from_utf8(bytes.clone()).map_err(|_| "image metadata is not UTF-8".into())
    };
    let json = |raw: &str| -> Result<Value> {
        serde_json::from_str(raw).map_err(|_| "invalid image metadata".into())
    };
    let outer = json(&String::from_utf8_lossy(
        files
            .get("index.json")
            .ok_or("image archive lacks index.json")?,
    ))?;
    let entries = outer["manifests"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or_default();
    let matching: Vec<_> = entries
        .iter()
        .filter(|entry| {
            image.is_none_or(|name| entry["annotations"]["io.containerd.image.name"] == name)
        })
        .collect();
    let [entry] = matching.as_slice() else {
        return Err(match image {
            Some(name) => format!("image archive must hold exactly one entry for {name}"),
            None => "image archive must hold exactly one image".into(),
        });
    };
    let root = entry["digest"]
        .as_str()
        .ok_or("image archive entry has no digest")?
        .to_owned();
    let root_raw = blob(&root, "the image's root")?;
    let index = json(&root_raw)?;
    let mut blobs = BTreeMap::from([(root.clone(), root_raw)]);
    // An index names each Linux platform it lists; a manifest is its own platform.
    let platforms: Vec<(String, Option<String>)> = match index["manifests"].as_array() {
        Some(children) => children
            .iter()
            .filter(|child| child["platform"]["os"] == "linux")
            .map(|child| {
                let digest = child["digest"]
                    .as_str()
                    .ok_or("image manifest has no digest")?;
                let architecture = child["platform"]["architecture"]
                    .as_str()
                    .unwrap_or_default();
                Ok((digest.to_owned(), Some(architecture.to_owned())))
            })
            .collect::<Result<_>>()?,
        None => vec![(root.clone(), None)],
    };
    if platforms.is_empty() {
        return Err("image lists no Linux platform".into());
    }
    for (manifest, architecture) in platforms {
        if manifest != root {
            let what = format!(
                "the linux/{} manifest; export a multi-platform image from its registry",
                architecture.as_deref().unwrap_or_default()
            );
            blobs.insert(manifest.clone(), blob(&manifest, &what)?);
        }
        let config = json(&blobs[&manifest])?["config"]["digest"]
            .as_str()
            .ok_or("image manifest has no config")?
            .to_owned();
        let config_raw = blob(&config, "a manifest's config")?;
        let configuration = json(&config_raw)?;
        if configuration["os"] != "linux"
            || architecture
                .is_some_and(|architecture| configuration["architecture"] != architecture.as_str())
        {
            return Err("image manifest config does not match its platform".into());
        }
        blobs.insert(config, config_raw);
    }
    let bundle = serde_json::to_vec(&serde_json::json!({"schema_version": 2, "blobs": blobs}))
        .map_err(|_| "cannot encode the image metadata bundle")?;
    Ok((root, bundle))
}

/// Save `image` from the local Docker engine and write its metadata bundle
/// to `output`, a new file. Returns the image's digest reference.
pub fn export_metadata(image: &str, output: &Path) -> Result<()> {
    let archive = output_of(docker().args(["image", "save", image]), "save the image")?;
    let bundle = metadata_bundle(&archive)?;
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(output)
        .map_err(|_| {
            "cannot create the metadata bundle; the output must be a new file".to_owned()
        })?;
    std::io::Write::write_all(&mut file, &bundle)
        .map_err(|_| "cannot write the metadata bundle".to_owned())?;
    Ok(())
}

/// Bake targets for `selection`, each with the tags it should publish locally.
pub fn plan(
    root: &Path,
    platform: &str,
    selection: &[String],
) -> Result<Vec<(String, Vec<String>)>> {
    if !PLATFORMS.contains(&platform) {
        return Err(format!("choose --platform {}", PLATFORMS.join(" or ")));
    }
    let printed = output(
        docker()
            .current_dir(root)
            .env("AGENT_PLATFORM", platform)
            .args(["buildx", "bake", "--print"])
            .args(selection),
        "plan the image build",
    )?;
    let plan: Value = serde_json::from_slice(&printed).map_err(|_| "unreadable bake plan")?;
    let targets = plan["target"]
        .as_object()
        .ok_or("bake plan has no targets")?;
    targets
        .iter()
        .map(|(name, target)| {
            let tags: Vec<String> = target["tags"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|tag| tag.as_str().map(str::to_owned))
                .collect();
            if tags.is_empty() {
                return Err(format!("{name} is not a tagged agent image"));
            }
            Ok((name.clone(), tags))
        })
        .collect()
}

/// The label that publishes the image's catalog: its installed adapters with
/// their descriptors, and its runtime.
pub fn labels(name: &str, catalog: Value) -> Result<Vec<(String, String)>> {
    let compact = |value: &Value| {
        serde_json::to_string(value).map_err(|_| "unserializable metadata".to_owned())
    };
    // Only the reference image publishes the reference adapter, and it
    // publishes nothing else, so neither can pass for the other.
    let adapters: Vec<&str> = catalog["adapters"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|adapter| adapter["descriptor"]["adapter_id"].as_str().unwrap_or(""))
        .collect();
    if name == "dummy" {
        if adapters != [REFERENCE_ADAPTER] {
            return Err(format!(
                "the reference image must list only {REFERENCE_ADAPTER}"
            ));
        }
    } else if adapters.contains(&REFERENCE_ADAPTER) {
        return Err(format!(
            "{name} lists {REFERENCE_ADAPTER}, which only the reference image may publish"
        ));
    }
    Ok(vec![(CATALOG_LABEL.to_owned(), compact(&catalog)?)])
}

/// Build each target labeled with the catalog it installs. Bake exports the
/// target's `catalog` stage, then builds its `labeled` stage with that catalog,
/// which the build checks against the installed one; both reuse the harness
/// stage's cache, so the image Bake builds is the image we use.
pub fn build(root: &Path, platform: &str, selection: &[String]) -> Result<()> {
    for (name, _) in plan(root, platform, selection)? {
        let bake = || {
            let mut command = docker();
            command
                .current_dir(root)
                .env("AGENT_PLATFORM", platform)
                .args(["buildx", "bake", &name]);
            command
        };
        // Bake writes local output only below the directory it runs in.
        let output = format!(".build/catalog/{name}");
        let exported = root.join(&output);
        let _ = fs::remove_dir_all(&exported);
        fs::create_dir_all(&exported).map_err(|_| "cannot create the catalog directory")?;
        status(
            bake()
                .arg("--set")
                .arg(format!("{name}.target=catalog"))
                .arg("--set")
                .arg(format!("{name}.output=type=local,dest={output}")),
            &format!("catalog {name}"),
        )?;
        let catalog = fs::read(exported.join("catalog.json"))
            .map_err(|_| format!("{name} exported no catalog"))?;
        let catalog: Value =
            serde_json::from_slice(&catalog).map_err(|_| "the exported catalog is not JSON")?;
        let [(_, label)] = <[_; 1]>::try_from(labels(&name, catalog)?)
            .map_err(|_| "an image carries exactly one catalog label")?;
        status(
            bake()
                .args(["--load", "--set"])
                .arg(format!("{name}.target=labeled"))
                .arg("--set")
                .arg(format!("{name}.args.CATALOG={label}")),
            &format!("build {name}"),
        )?;
    }
    Ok(())
}

/// Run the black-box command contract inside one image, offline and read-only.
/// The `docker run` arguments for the reference runtime contract: offline,
/// read-only, with only sandbox storage writable and the suite mounted.
pub fn qualify_arguments(root: &Path, name: &str, id: &str) -> Vec<String> {
    let suite = root.join("image").join("test_agent_contract.py");
    [
        "run",
        "--name",
        name,
        "--rm",
        "--runtime=runc",
        "--network=none",
        "--read-only",
        "--tmpfs",
        "/sandbox:rw,uid=10001,gid=10001,mode=0700",
        "--tmpfs",
        "/tmp:rw,mode=1777",
        "-e",
        "HOME=/sandbox",
        "--workdir",
        "/sandbox",
        "--mount",
        &format!("type=bind,src={},dst=/test.py,readonly", suite.display()),
        "--entrypoint",
        "/opt/fabric/bin/python",
        id,
        "-B",
        "/test.py",
    ]
    .map(String::from)
    .to_vec()
}

/// Run the reference image's runtime contract: NemoClaw's test adapter started,
/// invoked and stopped through `fabric-agent-ctl` under the conditions an
/// OpenShell sandbox imposes. Fabric's native adapters are Fabric's to test;
/// production images get only the assembly checks in `image/test_image.py`.
pub fn qualify(root: &Path, image: &str) -> Result<()> {
    let inspected = output(
        docker().args(["image", "inspect", image]),
        "inspect the image",
    )?;
    let inspected: Value =
        serde_json::from_slice(&inspected).map_err(|_| "unreadable image inspection")?;
    let labels = &inspected[0]["Config"]["Labels"];
    if labels[CATALOG_LABEL].as_str().is_none() {
        return Err(format!(
            "{image} has no {CATALOG_LABEL} label; build it with cargo images build"
        ));
    }
    if labels[REFERENCE_LABEL].as_str().is_none() {
        return Err(format!(
            "{image} is not the reference image; production images are checked by image/test_image.py (docs/contributing/testing.md#image-source-checks)"
        ));
    }
    let id = inspected[0]["Id"].as_str().ok_or("image has no ID")?;
    let root = std::path::absolute(root).map_err(|_| "cannot locate the repository")?;
    let mut nonce = [0u8; 16];
    getrandom::fill(&mut nonce).map_err(|_| "cannot name the qualification container")?;
    let name = format!("nemoclaw-contract-{}", crate::hex(&nonce));
    let mut child = docker()
        .args(qualify_arguments(&root, &name, id))
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|_| "cannot run docker to qualify the image")?;
    let deadline = std::time::Instant::now() + QUALIFY_TIMEOUT;
    let outcome = loop {
        match child.try_wait() {
            Ok(Some(exit)) => {
                break exit
                    .success()
                    .then_some(())
                    .ok_or("the reference runtime contract failed");
            }
            Ok(None) if std::time::Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(200));
            }
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                break Err("the reference runtime contract timed out");
            }
            Err(_) => break Err("cannot observe the qualification container"),
        }
    };
    // Only this invocation's container is removed, including after a timeout.
    let _ = docker()
        .args(["rm", "--force", &name])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    outcome.map_err(|error| format!("{image}: {error}"))
}
