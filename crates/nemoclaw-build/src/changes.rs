// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Decide whether changes since a base revision can affect `CI / Images`.
//!
//! determinator maps changed files to workspace packages, using the rules in
//! [`RULES`] for files outside crates. guppy then simulates the image build:
//! nemoclaw-build without default features, including the dev-dependencies its
//! `bake::` tests compile, and the Ollama proxy with its defaults and tests.
//! The images are affected when a changed package is in that build, or when
//! its third-party dependencies or enabled features differ from the base.

use determinator::{Determinator, Utf8Paths0, rules::DeterminatorRules};
use guppy::{
    MetadataCommand,
    graph::{
        DependencyDirection, PackageGraph, PackageSet,
        cargo::{CargoOptions, CargoSet},
        feature::{FeatureSet, StandardFeatures},
    },
};
use std::{collections::BTreeSet, fs, path::Path, process::Command};

/// Path rules for files outside crates, relative to the repository root.
pub const RULES: &str = ".config/determinator-images.toml";

type Result<T> = std::result::Result<T, String>;

/// Whether to run the image checks, and why.
pub struct Decision {
    pub run: bool,
    pub reason: String,
}

/// Decide for the changes from `base` to `HEAD` in the repository at `root`.
///
/// Any failure to analyze the change runs the checks rather than skipping them.
pub fn images(root: &Path, base: &str) -> Decision {
    analyze(root, base).unwrap_or_else(|error| Decision {
        run: true,
        reason: format!(
            "could not analyze changes since {base} ({error}); running the image checks"
        ),
    })
}

fn analyze(root: &Path, base: &str) -> Result<Decision> {
    let base = String::from_utf8(git(
        root,
        &["rev-parse", "--verify", &format!("{base}^{{commit}}")],
    )?)
    .map_err(|_| "git printed a non-UTF-8 revision")?
    .trim()
    .to_owned();
    // Without rename detection a moved file reports both its old and new paths.
    let changed = git(
        root,
        &["diff", "-z", "--name-only", "--no-renames", &base, "HEAD"],
    )?;
    let paths = Utf8Paths0::from_bytes(changed).map_err(|_| "a changed path is not UTF-8")?;
    let rules =
        fs::read_to_string(root.join(RULES)).map_err(|e| format!("cannot read {RULES}: {e}"))?;
    let rules = DeterminatorRules::parse(&rules).map_err(|e| format!("invalid {RULES}: {e}"))?;

    let new = graph(root)?;
    let base_tree = tempfile::tempdir().map_err(|e| e.to_string())?;
    let archive = git(root, &["archive", "--format=tar", &base])?;
    tar::Archive::new(archive.as_slice())
        .unpack(base_tree.path())
        .map_err(|e| format!("cannot extract {base}: {e}"))?;
    let old = graph(base_tree.path())?;

    let mut determinator = Determinator::new(&old, &new);
    determinator
        .set_rules(&rules)
        .map_err(|e| format!("invalid {RULES}: {e}"))?;
    determinator.add_changed_paths(&paths);
    let path_changed = determinator.compute().path_changed_set;

    let build = image_build(&new)?;
    for package in packages(&build).packages(DependencyDirection::Forward) {
        if path_changed
            .contains(package.id())
            .map_err(|e| e.to_string())?
        {
            return Ok(Decision {
                run: true,
                reason: format!("{} is part of the image build and changed", package.name()),
            });
        }
    }
    if summary(&build) != summary(&image_build(&old)?) {
        return Ok(Decision {
            run: true,
            reason: "the image build's dependencies or features changed".into(),
        });
    }
    Ok(Decision {
        run: false,
        reason: format!("no image inputs changed since {base}"),
    })
}

fn git(root: &Path, args: &[&str]) -> Result<Vec<u8>> {
    let output = Command::new("git")
        .args(args)
        .current_dir(root)
        .output()
        .map_err(|e| format!("cannot run git: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "git {} failed: {}",
            args.first().unwrap_or(&""),
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(output.stdout)
}

fn graph(root: &Path) -> Result<PackageGraph> {
    MetadataCommand::new()
        .current_dir(root)
        .other_options(["--locked"])
        .build_graph()
        .map_err(|e| format!("cargo metadata failed in {}: {e}", root.display()))
}

fn image_build(graph: &PackageGraph) -> Result<CargoSet<'_>> {
    let workspace = |name: &str| {
        graph
            .resolve_workspace_names([name])
            .map_err(|e| format!("workspace has no {name}: {e}"))
    };
    let initials: FeatureSet<'_> = workspace("nemoclaw-build")?
        .to_feature_set(StandardFeatures::None)
        .union(&workspace("nemoclaw-ollama-proxy")?.to_feature_set(StandardFeatures::Default));
    // The default options follow dev-dependencies of the initials, resolve for any
    // platform, and use resolver 1, which unifies at least the workspace resolver's features.
    CargoSet::new(
        initials,
        graph.feature_graph().resolve_none(),
        &CargoOptions::new(),
    )
    .map_err(|e| e.to_string())
}

fn packages<'g>(build: &CargoSet<'g>) -> PackageSet<'g> {
    build
        .target_features()
        .to_package_set()
        .union(&build.host_features().to_package_set())
}

/// Packages and enabled features, comparable across the two checkouts.
///
/// Workspace packages are named without their path, which differs between checkouts;
/// file changes inside them are detected separately.
fn summary(build: &CargoSet<'_>) -> BTreeSet<String> {
    let mut summary = BTreeSet::new();
    for (platform, features) in [
        ("target", build.target_features()),
        ("host", build.host_features()),
    ] {
        for list in features.packages_with_features(DependencyDirection::Forward) {
            let package = list.package();
            let identity = if package.in_workspace() {
                package.name().to_owned()
            } else {
                format!(
                    "{} {} {}",
                    package.name(),
                    package.version(),
                    package.source()
                )
            };
            let enabled: Vec<String> = list
                .labels()
                .iter()
                .map(|label| label.to_string())
                .collect();
            summary.insert(format!("{platform} {identity} [{}]", enabled.join(",")));
        }
    }
    summary
}
