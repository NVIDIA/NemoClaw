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

const MANIFEST_TYPES: &str = "application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json";

/// The bundle `export_metadata` writes, read from a registry instead of a local
/// archive: the root at `reference` (`HOST/REPOSITORY@sha256:...`) and, for each
/// Linux platform it lists, that platform's manifest and config. Every document
/// is checked against its digest. `credentials` answer the registry's token
/// challenge; without them the registry must allow anonymous pulls.
pub async fn registry_metadata(
    reference: &str,
    credentials: Option<(String, String)>,
) -> Result<Vec<u8>> {
    let (name, root) = reference
        .rsplit_once('@')
        .ok_or("a registry reference must pin a digest")?;
    let (host, repository) = name
        .split_once('/')
        .ok_or("a registry reference names its registry host")?;
    // A tag beside the digest doesn't select anything.
    let repository = match repository.rsplit_once(':') {
        Some((repository, tag)) if !tag.contains('/') => repository,
        _ => repository,
    };
    let loopback = host.starts_with("127.0.0.1") || host.starts_with("localhost");
    let registry = Registry {
        http: reqwest::Client::builder()
            .https_only(!loopback)
            .timeout(std::time::Duration::from_secs(60))
            .build()
            .map_err(|_| "cannot create the registry client")?,
        base: format!(
            "{}://{host}/v2/{repository}",
            if loopback { "http" } else { "https" }
        ),
        credentials,
        token: tokio::sync::Mutex::new(None),
    };
    let mut files = BTreeMap::new();
    let mut add = |digest: &str, bytes: Vec<u8>| {
        files.insert(
            format!("blobs/sha256/{}", digest.trim_start_matches("sha256:")),
            bytes,
        );
    };
    let config_of = |raw: &[u8]| -> Result<String> {
        let value: Value =
            serde_json::from_slice(raw).map_err(|_| "invalid image manifest".to_owned())?;
        Ok(value["config"]["digest"]
            .as_str()
            .ok_or("image manifest has no config")?
            .to_owned())
    };
    let root_raw = registry.fetch("manifests", root).await?;
    let index: Value =
        serde_json::from_slice(&root_raw).map_err(|_| "invalid image index".to_owned())?;
    let manifests: Vec<(String, Vec<u8>)> = match index["manifests"].as_array() {
        Some(children) => {
            let mut manifests = Vec::new();
            for child in children
                .iter()
                .filter(|child| child["platform"]["os"] == "linux")
            {
                let digest = child["digest"]
                    .as_str()
                    .ok_or("image manifest has no digest")?;
                manifests.push((
                    digest.to_owned(),
                    registry.fetch("manifests", digest).await?,
                ));
            }
            manifests
        }
        None => vec![(root.to_owned(), root_raw.clone())],
    };
    add(root, root_raw);
    for (digest, raw) in manifests {
        let config = config_of(&raw)?;
        add(&digest, raw);
        add(&config, registry.fetch("blobs", &config).await?);
    }
    files.insert(
        "index.json".into(),
        serde_json::to_vec(&serde_json::json!({"manifests": [{"digest": root}]}))
            .map_err(|_| "cannot encode the image index")?,
    );
    Ok(bundle_from_files(files, None)?.1)
}

struct Registry {
    http: reqwest::Client,
    base: String,
    credentials: Option<(String, String)>,
    token: tokio::sync::Mutex<Option<String>>,
}

impl Registry {
    /// One manifest or blob by digest, at most 1 MiB, checked against the digest.
    async fn fetch(&self, kind: &str, digest: &str) -> Result<Vec<u8>> {
        use sha2::{Digest, Sha256};
        let hex = digest
            .strip_prefix("sha256:")
            .filter(|hex| hex.len() == 64 && hex.bytes().all(|byte| byte.is_ascii_hexdigit()))
            .ok_or("image digest is not SHA-256")?;
        let url = format!("{}/{kind}/{digest}", self.base);
        let mut response = self.request(&url).await?;
        if response.status() == reqwest::StatusCode::UNAUTHORIZED {
            let challenge = response
                .headers()
                .get(reqwest::header::WWW_AUTHENTICATE)
                .and_then(|value| value.to_str().ok())
                .ok_or("the registry refused the request without a token challenge")?
                .to_owned();
            *self.token.lock().await = Some(self.authenticate(&challenge).await?);
            response = self.request(&url).await?;
        }
        let response = response.error_for_status().map_err(|error| {
            format!(
                "cannot fetch {kind} {digest}: {}",
                error
                    .status()
                    .map(|status| status.to_string())
                    .unwrap_or_default()
            )
        })?;
        let bytes = response
            .bytes()
            .await
            .map_err(|_| format!("cannot read {kind} {digest}"))?;
        if bytes.len() > 1 << 20 {
            return Err(format!("{kind} {digest} exceeds 1 MiB"));
        }
        if crate::hex(&Sha256::digest(&bytes)) != hex {
            return Err("image metadata blob does not match its digest".into());
        }
        Ok(bytes.to_vec())
    }

    async fn request(&self, url: &str) -> Result<reqwest::Response> {
        let mut request = self
            .http
            .get(url)
            .header(reqwest::header::ACCEPT, MANIFEST_TYPES);
        if let Some(token) = self.token.lock().await.as_deref() {
            request = request.bearer_auth(token);
        }
        request
            .send()
            .await
            .map_err(|_| "cannot reach the registry".to_owned())
    }

    /// Answer a `Bearer realm=...,service=...,scope=...` challenge with a token.
    async fn authenticate(&self, challenge: &str) -> Result<String> {
        let parameters: BTreeMap<&str, &str> = challenge
            .strip_prefix("Bearer ")
            .ok_or("the registry asks for an unsupported authentication scheme")?
            .split(',')
            .filter_map(|part| part.trim().split_once('='))
            .map(|(key, value)| (key, value.trim_matches('"')))
            .collect();
        let realm = parameters
            .get("realm")
            .ok_or("the registry's token challenge names no realm")?;
        let query: Vec<(&str, &str)> = ["service", "scope"]
            .into_iter()
            .filter_map(|key| parameters.get(key).map(|value| (key, *value)))
            .collect();
        let url = reqwest::Url::parse_with_params(realm, &query)
            .map_err(|_| "the registry's token realm is not a URL")?;
        let mut request = self.http.get(url);
        if let Some((username, password)) = &self.credentials {
            request = request.basic_auth(username, Some(password));
        }
        let bytes = request
            .send()
            .await
            .and_then(reqwest::Response::error_for_status)
            .map_err(|_| "the registry refused a token".to_owned())?
            .bytes()
            .await
            .map_err(|_| "the registry returned no token".to_owned())?;
        let body: Value = serde_json::from_slice(&bytes)
            .map_err(|_| "the registry returned an invalid token".to_owned())?;
        body["token"]
            .as_str()
            .or(body["access_token"].as_str())
            .map(str::to_owned)
            .ok_or_else(|| "the registry returned no token".into())
    }
}

/// Save `image` from the local Docker engine and write its metadata bundle
/// to `output`, a new file. Returns the image's digest reference.
pub fn export_metadata(image: &str, output: &Path) -> Result<()> {
    let archive = output_of(docker().args(["image", "save", image]), "save the image")?;
    write_bundle(&metadata_bundle(&archive)?, output)
}

/// Write a metadata bundle to `output`, which must be a new file.
pub fn write_bundle(bundle: &[u8], output: &Path) -> Result<()> {
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(output)
        .map_err(|_| {
            "cannot create the metadata bundle; the output must be a new file".to_owned()
        })?;
    std::io::Write::write_all(&mut file, bundle)
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
