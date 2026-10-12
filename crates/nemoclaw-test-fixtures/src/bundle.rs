// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! The bundle that `NEMOCLAW_TEST_BUNDLE` names: the one input of the tests
//! that run OpenTofu. It supplies pinned OpenTofu and the providers it ships.

use std::{
    fs,
    path::{Path, PathBuf},
};

/// A built bundle directory, such as `dist/linux_arm64`.
#[derive(Clone, Debug)]
pub struct Bundle {
    root: PathBuf,
}

impl Bundle {
    /// The bundle `NEMOCLAW_TEST_BUNDLE` names, which must be an absolute path.
    #[must_use]
    pub fn from_env() -> Self {
        let root = PathBuf::from(
            std::env::var_os("NEMOCLAW_TEST_BUNDLE")
                .expect("NEMOCLAW_TEST_BUNDLE names a bundle; build one with cargo ci bundle"),
        );
        assert!(
            root.is_absolute(),
            "NEMOCLAW_TEST_BUNDLE is not absolute: {}",
            root.display()
        );
        Self::open(root)
    }

    /// The bundle at `root`.
    pub fn open(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    #[must_use]
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// The bundle's pinned OpenTofu.
    #[must_use]
    pub fn tofu(&self) -> PathBuf {
        let tofu = self.root.join("libexec").join(crate::executable("tofu"));
        assert!(tofu.is_file(), "{} is missing", tofu.display());
        tofu
    }

    /// The bundle's `registry.opentofu.org/nvidia/{name}` provider, such as
    /// `nemoclaw`, `openshell`, or `fabric`.
    #[must_use]
    pub fn provider(&self, name: &str) -> PathBuf {
        // providers/registry.opentofu.org/nvidia/NAME/VERSION/PLATFORM/terraform-provider-NAME_vVERSION
        let source = ["providers", "registry.opentofu.org", "nvidia", name]
            .iter()
            .fold(self.root.clone(), |path, part| path.join(part));
        assert!(
            source.is_dir(),
            "the bundle ships no {name} provider: {} is missing",
            source.display()
        );
        let version = only_entry(&source);
        let platform = only_entry(&version);
        let version = version.file_name().unwrap().to_string_lossy();
        let provider = platform.join(crate::executable(&format!(
            "terraform-provider-{name}_v{version}"
        )));
        assert!(provider.is_file(), "{} is missing", provider.display());
        provider
    }
}

/// The one entry of `directory`, as a bundle has one version and platform of each provider.
fn only_entry(directory: &Path) -> PathBuf {
    let entries: Vec<_> = fs::read_dir(directory)
        .unwrap_or_else(|error| panic!("{}: {error}", directory.display()))
        .map(|entry| entry.unwrap().path())
        .collect();
    assert_eq!(
        entries.len(),
        1,
        "{} must hold exactly one entry",
        directory.display()
    );
    entries.into_iter().next().unwrap()
}

/// A binary target of the calling test's own package, such as the provider
/// its contract tests check.
///
/// Nextest names the executable at run time, also where it extracts an
/// archive; under `cargo test`, the path Cargo compiled in is used.
#[macro_export]
macro_rules! package_executable {
    ($name:literal) => {
        $crate::bundle::package_executable($name, env!(concat!("CARGO_BIN_EXE_", $name)))
    };
}

#[doc(hidden)]
#[must_use]
pub fn package_executable(name: &str, compiled: &str) -> PathBuf {
    std::env::var_os(format!("NEXTEST_BIN_EXE_{name}"))
        .map_or_else(|| PathBuf::from(compiled), PathBuf::from)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bundle() -> (tempfile::TempDir, Bundle) {
        let root = tempfile::tempdir().unwrap();
        let files = [
            "libexec/tofu".to_owned(),
            "providers/registry.opentofu.org/nvidia/openshell/0.1.0-dev.abc/linux_arm64/terraform-provider-openshell_v0.1.0-dev.abc".to_owned(),
            "providers/registry.opentofu.org/nvidia/fabric/0.1.0-dev.abc/linux_arm64/terraform-provider-fabric_v0.1.0-dev.abc".to_owned(),
        ];
        for file in files {
            let path = root.path().join(crate::executable(&file));
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, file).unwrap();
        }
        let bundle = Bundle::open(root.path());
        (root, bundle)
    }

    #[test]
    fn finds_pinned_opentofu_and_each_shipped_provider() {
        let (root, bundle) = bundle();
        assert_eq!(
            bundle.tofu(),
            root.path().join("libexec").join(crate::executable("tofu"))
        );
        for name in ["openshell", "fabric"] {
            let provider = bundle.provider(name);
            let contents = fs::read_to_string(&provider).unwrap();
            assert!(contents.contains(&format!("nvidia/{name}/")), "{contents}");
        }
    }

    #[test]
    #[should_panic(expected = "the bundle ships no nemoclaw provider")]
    fn a_provider_the_bundle_does_not_ship_is_named_in_the_failure() {
        let (_root, bundle) = bundle();
        let _ = bundle.provider("nemoclaw");
    }

    #[test]
    #[should_panic(expected = "exactly one entry")]
    fn a_second_provider_version_is_ambiguous() {
        let (root, bundle) = bundle();
        fs::create_dir_all(
            root.path()
                .join("providers/registry.opentofu.org/nvidia/fabric/0.1.0-dev.def"),
        )
        .unwrap();
        let _ = bundle.provider("fabric");
    }
}
