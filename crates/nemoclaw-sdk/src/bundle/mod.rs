// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

#[cfg(test)]
mod tests;

use crate::Error;
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs,
    path::{Component, Path, PathBuf},
};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase", deny_unknown_fields)]
pub struct Manifest {
    pub version: String,
    pub rust: String,
    #[serde(rename = "OpenTofu")]
    pub opentofu: String,
    pub files: BTreeMap<String, String>,
}
#[derive(Clone, Debug)]
pub struct Bundle {
    pub directory: PathBuf,
    pub manifest: Manifest,
}
impl Bundle {
    pub fn open(directory: &Path) -> Result<Self, Error> {
        let directory = directory
            .canonicalize()
            .map_err(|_| Error::Bundle("bundle directory is unavailable"))?;
        let bytes = fs::read(directory.join("manifest.json"))
            .map_err(|_| Error::Bundle("bundle manifest is unavailable"))?;
        let manifest: Manifest =
            serde_json::from_slice(&bytes).map_err(|_| Error::Bundle("invalid bundle manifest"))?;
        if manifest.opentofu != crate::compile::OPENTOFU_VERSION || manifest.rust.is_empty() {
            return Err(Error::Bundle("incompatible bundle manifest"));
        }
        for name in required_files(&manifest.version)? {
            if !manifest.files.contains_key(&name) {
                return Err(Error::Bundle("bundle is incomplete"));
            }
        }
        let files: Vec<_> = manifest.files.iter().collect();
        // Hash files concurrently; the first failure in manifest order decides
        // the error, as it would when checking them one at a time.
        let checks = verify_concurrently(&files, |(name, digest)| {
            verify_file(&directory, name, digest)
        });
        checks.into_iter().collect::<Result<(), Error>>()?;
        Ok(Self {
            directory,
            manifest,
        })
    }
    pub fn tofu(&self) -> PathBuf {
        self.directory.join("libexec").join(executable("tofu"))
    }
}
fn verify_file(directory: &Path, name: &str, digest: &str) -> Result<(), Error> {
    if name.is_empty()
        || Path::new(name)
            .components()
            .any(|c| !matches!(c, Component::Normal(_)))
        || name.contains('\\')
    {
        return Err(Error::Bundle("invalid bundle path"));
    }
    let path = directory.join(name);
    if !fs::symlink_metadata(&path)
        .map_err(|_| Error::Bundle("bundle file is unavailable"))?
        .is_file()
        || hash_file(&path)? != digest
    {
        return Err(Error::Bundle("bundle file integrity check failed"));
    }
    Ok(())
}
/// Run `check` on every item across a few threads, returning results in item order.
fn verify_concurrently<T: Sync, R: Send>(items: &[T], check: impl Fn(&T) -> R + Sync) -> Vec<R> {
    let workers = std::thread::available_parallelism()
        .map_or(1, std::num::NonZeroUsize::get)
        .min(items.len());
    if workers <= 1 {
        return items.iter().map(check).collect();
    }
    let next = std::sync::atomic::AtomicUsize::new(0);
    let mut results: Vec<(usize, R)> = std::thread::scope(|scope| {
        let handles: Vec<_> = (0..workers)
            .map(|_| {
                scope.spawn(|| {
                    let mut done = Vec::new();
                    loop {
                        let index = next.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                        let Some(item) = items.get(index) else {
                            return done;
                        };
                        done.push((index, check(item)));
                    }
                })
            })
            .collect();
        handles
            .into_iter()
            .flat_map(|handle| handle.join().expect("bundle verification thread"))
            .collect()
    });
    results.sort_by_key(|(index, _)| *index);
    results.into_iter().map(|(_, result)| result).collect()
}
/// Metadata that changes when a file is written or replaced.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Stamp {
    length: u64,
    modified: Option<std::time::SystemTime>,
    /// Unix inode change time and identity; the change time cannot be set
    /// back by a writer.
    #[cfg(unix)]
    identity: (u64, u64, i64, i64),
    #[cfg(not(unix))]
    created: Option<std::time::SystemTime>,
}
impl Stamp {
    fn read(path: &Path) -> Option<Self> {
        let metadata = fs::symlink_metadata(path).ok()?;
        #[cfg(unix)]
        let identity = {
            use std::os::unix::fs::MetadataExt;
            (
                metadata.dev(),
                metadata.ino(),
                metadata.ctime(),
                metadata.ctime_nsec(),
            )
        };
        Some(Self {
            length: metadata.len(),
            modified: metadata.modified().ok(),
            #[cfg(unix)]
            identity,
            #[cfg(not(unix))]
            created: metadata.created().ok(),
        })
    }
}
/// The manifest's and every listed file's metadata, or `None` when any is
/// unavailable.
fn stamps(directory: &Path, manifest: &Manifest) -> Option<Vec<Stamp>> {
    std::iter::once("manifest.json")
        .chain(manifest.files.keys().map(String::as_str))
        .map(|name| Stamp::read(&directory.join(name)))
        .collect()
}

/// A bundle verified once and verified again only when the manifest or a
/// file it lists is written, replaced, or removed.
#[derive(Debug, Default)]
pub struct VerifiedBundle {
    state: std::sync::Mutex<VerifiedState>,
}
#[derive(Debug, Default)]
struct VerifiedState {
    verified: Option<(Bundle, Vec<Stamp>)>,
    hashings: usize,
}
impl VerifiedBundle {
    /// Open `directory` as [`Bundle::open`] does, reusing the last
    /// verification while no listed file has changed.
    ///
    /// # Errors
    /// Returns the verification error; failures are not remembered.
    pub fn open(&self, directory: &Path) -> Result<Bundle, Error> {
        let directory = directory
            .canonicalize()
            .map_err(|_| Error::Bundle("bundle directory is unavailable"))?;
        let mut state = self
            .state
            .lock()
            .map_err(|_| Error::State("bundle verification state is unavailable"))?;
        if let Some((bundle, recorded)) = &state.verified
            && bundle.directory == directory
            && stamps(&directory, &bundle.manifest).as_ref() == Some(recorded)
        {
            return Ok(bundle.clone());
        }
        state.verified = None;
        state.hashings += 1;
        // Stamps taken before hashing make a write during it visible next time.
        let manifest = fs::read(directory.join("manifest.json"))
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Manifest>(&bytes).ok());
        let before = manifest.and_then(|manifest| stamps(&directory, &manifest));
        let bundle = Bundle::open(&directory)?;
        if let Some(before) = before {
            state.verified = Some((bundle.clone(), before));
        }
        Ok(bundle)
    }
    #[cfg(test)]
    pub(crate) fn hashings(&self) -> usize {
        self.state.lock().unwrap().hashings
    }
}
pub fn executable(name: &str) -> String {
    format!("{name}{}", std::env::consts::EXE_SUFFIX)
}
pub fn platform() -> Result<String, Error> {
    let os = match std::env::consts::OS {
        "linux" => "linux",
        "macos" => "darwin",
        "windows" => "windows",
        _ => return Err(Error::Bundle("unsupported bundle platform")),
    };
    let arch = match std::env::consts::ARCH {
        "aarch64" => "arm64",
        "x86_64" => "amd64",
        _ => return Err(Error::Bundle("unsupported bundle architecture")),
    };
    if os == "windows" && arch != "amd64" {
        return Err(Error::Bundle("unsupported Windows architecture"));
    }
    Ok(format!("{os}_{arch}"))
}
pub fn required_files(version: &str) -> Result<Vec<String>, Error> {
    if !regex::Regex::new(r"^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$")
        .expect("constant expression")
        .is_match(version)
    {
        return Err(Error::Bundle("invalid provider version"));
    }
    Ok(vec![
        format!("bin/{}", executable("nemoclaw")),
        format!("libexec/{}", executable("tofu")),
        format!(
            "providers/{}/{}/{}/{}",
            crate::compile::PROVIDER_ADDRESS,
            version,
            platform()?,
            executable(&format!("terraform-provider-nemoclaw_v{version}"))
        ),
        format!(
            "providers/{}/{}/{}/{}",
            crate::compile::OPENSHELL_PROVIDER_ADDRESS,
            version,
            platform()?,
            executable(&format!("terraform-provider-openshell_v{version}"))
        ),
        format!(
            "providers/{}/{}/{}/{}",
            crate::compile::FABRIC_PROVIDER_ADDRESS,
            version,
            platform()?,
            executable(&format!("terraform-provider-fabric_v{version}"))
        ),
        helm_provider_path(&platform()?)?,
        "licenses/helm-provider-LICENSE".into(),
        crate::config::schema::SCHEMA_PATH.into(),
    ])
}

pub fn helm_provider_path(platform: &str) -> Result<String, Error> {
    if !matches!(
        platform,
        "linux_arm64" | "linux_amd64" | "darwin_arm64" | "darwin_amd64" | "windows_amd64"
    ) {
        return Err(Error::Bundle("unsupported Helm provider platform"));
    }
    let extension = if platform.starts_with("windows") {
        ".exe"
    } else {
        ""
    };
    let address = crate::kubernetes::gateway::PROVIDER_ADDRESS;
    let version = crate::kubernetes::gateway::PROVIDER_VERSION;
    Ok(format!(
        "providers/{address}/{version}/{platform}/terraform-provider-helm_v{version}_x5{extension}"
    ))
}

pub fn hash_file(path: &Path) -> Result<String, Error> {
    nemoclaw_runtime::files::hash_file(path).map_err(Into::into)
}
