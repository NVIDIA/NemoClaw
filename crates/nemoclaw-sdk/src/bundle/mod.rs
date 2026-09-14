// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

#[cfg(test)]
mod tests;

use crate::Error;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs::{self, File},
    io::Read,
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
        for (name, digest) in &manifest.files {
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
                || hash_file(&path)? != *digest
            {
                return Err(Error::Bundle("bundle file integrity check failed"));
            }
        }
        Ok(Self {
            directory,
            manifest,
        })
    }
    pub fn tofu(&self) -> PathBuf {
        self.directory.join("libexec").join(executable("tofu"))
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
    ])
}
pub fn hash_file(path: &Path) -> Result<String, Error> {
    let mut file =
        File::open(path).map_err(|_| Error::Bundle("cannot open artifact for verification"))?;
    let mut hash = Sha256::new();
    let mut buffer = [0_u8; 65536];
    loop {
        let count = file
            .read(&mut buffer)
            .map_err(|_| Error::Bundle("cannot read artifact for verification"))?;
        if count == 0 {
            break;
        }
        hash.update(&buffer[..count]);
    }
    Ok(hash.finalize().iter().map(|b| format!("{b:02x}")).collect())
}
