// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Plan expensive validation from changed paths and simulated Cargo builds.

use determinator::{Determinator, Utf8Paths0, rules::DeterminatorRules};
use guppy::{
    MetadataCommand,
    graph::{
        DependencyDirection, PackageGraph, PackageSet,
        cargo::{CargoOptions, CargoSet},
        feature::{FeatureSet, StandardFeatures},
    },
};
use serde::Serialize;
use std::{collections::BTreeSet, fs, path::Path, process::Command};

pub const RULES: &str = ".config/determinator-images.toml";
pub const LIVE_RULES: &str = ".config/determinator-live.toml";
pub const BUNDLE_RULES: &str = ".config/determinator-bundle.toml";
pub const LIFECYCLE_RULES: &str = ".config/determinator-lifecycle.toml";
/// Packages whose tests run live, and the CLI and providers the bundle ships.
pub const LIVE_PACKAGES: [&str; 8] = [
    "nemoclaw-build",
    "nemoclaw-cli",
    "nemoclaw-e2e",
    "nemoclaw-provider",
    "nemoclaw-runtime",
    "nemoclaw-sdk",
    "openshell-provider",
    "fabric-provider",
];

#[derive(Clone, Copy)]
pub enum Workflow {
    Images,
    Live,
    Bundle,
    Lifecycle,
}
impl Workflow {
    fn rules(self) -> &'static str {
        match self {
            Self::Images => RULES,
            Self::Live => LIVE_RULES,
            Self::Bundle => BUNDLE_RULES,
            Self::Lifecycle => LIFECYCLE_RULES,
        }
    }
    fn subject(self) -> &'static str {
        match self {
            Self::Images => "image",
            Self::Live => "live",
            Self::Bundle => "bundle",
            Self::Lifecycle => "lifecycle",
        }
    }
}

type Result<T> = std::result::Result<T, String>;

#[derive(Clone, Serialize)]
pub struct Decision {
    pub run: bool,
    pub reason: String,
}

/// Expensive work to run. The ordinary build, unit tests, and schema checks
/// always run; this plan does not claim to select individual tests.
#[derive(Serialize)]
pub struct Plan {
    pub bundle: Decision,
    pub lifecycle: Decision,
    pub images: Decision,
    pub live: Decision,
}
impl Plan {
    pub fn full(reason: &str) -> Self {
        let decision = Decision {
            run: true,
            reason: reason.to_owned(),
        };
        Self {
            bundle: decision.clone(),
            lifecycle: decision.clone(),
            images: decision.clone(),
            live: decision,
        }
    }
}

/// Analyze all suites with the same paths and old/new metadata. Local callers
/// include the index, working files, and untracked inputs. CI uses a clean revision.
pub fn plan(root: &Path, base: &str, worktree: bool) -> Plan {
    let workflows = [
        Workflow::Bundle,
        Workflow::Lifecycle,
        Workflow::Images,
        Workflow::Live,
    ];
    match analyze_many(root, base, worktree, &workflows) {
        Ok(decisions) => {
            let mut decisions = decisions.into_iter();
            let mut bundle = decisions.next().unwrap();
            let lifecycle = decisions.next().unwrap();
            let images = decisions.next().unwrap();
            let live = decisions.next().unwrap();
            if !bundle.run && (lifecycle.run || live.run) {
                bundle = Decision {
                    run: true,
                    reason: "selected lifecycle or live checks need a fresh bundle".into(),
                };
            }
            Plan {
                bundle,
                lifecycle,
                images,
                live,
            }
        }
        Err(error) => Plan::full(&format!(
            "could not analyze changes since {base} ({error}); running all checks"
        )),
    }
}

pub fn images(root: &Path, base: &str) -> Decision {
    decide(root, base, Workflow::Images)
}

/// Preserve the single-workflow output used by existing callers.
pub fn decide(root: &Path, base: &str, workflow: Workflow) -> Decision {
    analyze_many(root, base, false, &[workflow])
        .map(|mut decisions| decisions.remove(0))
        .unwrap_or_else(|error| Decision {
            run: true,
            reason: format!(
                "could not analyze changes since {base} ({error}); running the {} checks",
                workflow.subject()
            ),
        })
}

fn analyze_many(
    root: &Path,
    base: &str,
    worktree: bool,
    workflows: &[Workflow],
) -> Result<Vec<Decision>> {
    let base = String::from_utf8(git(
        root,
        &["rev-parse", "--verify", &format!("{base}^{{commit}}")],
    )?)
    .map_err(|_| "git printed a non-UTF-8 revision")?
    .trim()
    .to_owned();
    if !worktree && !git(root, &["status", "--porcelain", "--untracked-files=normal"])?.is_empty() {
        return Err(
            "committed analysis requires a clean checkout; use --worktree to include local edits"
                .into(),
        );
    }
    // Disable rename detection so moves report both the old and new paths.
    let mut changed = git(
        root,
        &[
            "diff",
            "-z",
            "--name-only",
            "--no-renames",
            &base,
            "HEAD",
            "--",
        ],
    )?;
    if worktree {
        changed.extend(git(
            root,
            &["diff", "-z", "--name-only", "--no-renames", "HEAD", "--"],
        )?);
        changed.extend(git(
            root,
            &["ls-files", "--others", "--exclude-standard", "-z"],
        )?);
    }
    let paths = Utf8Paths0::from_bytes(changed).map_err(|_| "a changed path is not UTF-8")?;
    let new = graph(root)?;
    // The package graph depends only on Cargo's manifests, lockfile, toolchain
    // and configuration. When none changed, the base graph is the same, so
    // reuse it rather than extract the base and run Cargo again.
    let base_tree;
    let base_graph;
    let old = if (&paths)
        .into_iter()
        .any(|path| affects_graph(path.as_str()))
    {
        base_tree = tempfile::tempdir().map_err(|e| e.to_string())?;
        let archive = git(root, &["archive", "--format=tar", &base])?;
        tar::Archive::new(archive.as_slice())
            .unpack(base_tree.path())
            .map_err(|e| e.to_string())?;
        base_graph = graph(base_tree.path())?;
        &base_graph
    } else {
        &new
    };
    workflows
        .iter()
        .map(|workflow| {
            let rules =
                fs::read_to_string(root.join(workflow.rules())).map_err(|e| e.to_string())?;
            let rules =
                DeterminatorRules::parse(&rules).map_err(|e| format!("invalid path rules: {e}"))?;
            let mut determinator = Determinator::new(old, &new);
            determinator.set_rules(&rules).map_err(|e| e.to_string())?;
            determinator.add_changed_paths(&paths);
            // These decisions concern specific feature sets, not every possible
            // build of each affected package. Intersect changed paths with that
            // build's dependency closure, then compare its dependency/feature summary.
            let path_changed = determinator.compute().path_changed_set;
            let build_for = |graph| match workflow {
                Workflow::Images => image_build(graph),
                Workflow::Live => live_build(graph),
                Workflow::Bundle => bundle_build(graph),
                Workflow::Lifecycle => lifecycle_build(graph),
            };
            let build = build_for(&new)?;
            let subject = workflow.subject();
            for package in packages(&build).packages(DependencyDirection::Forward) {
                if path_changed
                    .contains(package.id())
                    .map_err(|e| e.to_string())?
                {
                    return Ok(Decision {
                        run: true,
                        reason: format!(
                            "{} is part of the {subject} build and changed",
                            package.name()
                        ),
                    });
                }
            }
            if summary(&build) != summary(&build_for(old)?) {
                return Ok(Decision {
                    run: true,
                    reason: format!("the {subject} build's dependencies or features changed"),
                });
            }
            Ok(Decision {
                run: false,
                reason: format!("no {subject} inputs changed since {base}"),
            })
        })
        .collect()
}

fn bundle_build(graph: &PackageGraph) -> Result<CargoSet<'_>> {
    selected_build(
        graph,
        [
            "nemoclaw-build",
            "nemoclaw-cli",
            "nemoclaw-provider",
            "openshell-provider",
            "fabric-provider",
        ],
    )
}

fn lifecycle_build(graph: &PackageGraph) -> Result<CargoSet<'_>> {
    // The fixture provider is launched by OpenTofu rather than linked by Cargo.
    selected_build(
        graph,
        LIVE_PACKAGES
            .into_iter()
            .chain(["nemoclaw-fixture-provider"]),
    )
}

fn selected_build<'g>(
    graph: &'g PackageGraph,
    names: impl IntoIterator<Item = &'static str>,
) -> Result<CargoSet<'g>> {
    let initials = graph
        .resolve_workspace_names(names)
        .map_err(|e| e.to_string())?
        .to_feature_set(StandardFeatures::Default);
    CargoSet::new(
        initials,
        graph.feature_graph().resolve_none(),
        &CargoOptions::new(),
    )
    .map_err(|e| e.to_string())
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

/// Whether a changed path can change Cargo's package graph.
fn affects_graph(path: &str) -> bool {
    let path = Path::new(path);
    path.starts_with(".cargo")
        || path.file_name().is_some_and(|name| {
            [
                "Cargo.toml",
                "Cargo.lock",
                "rust-toolchain",
                "rust-toolchain.toml",
            ]
            .iter()
            .any(|graph_input| name == *graph_input)
        })
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

fn live_build(graph: &PackageGraph) -> Result<CargoSet<'_>> {
    let initials = graph
        .resolve_workspace_names(LIVE_PACKAGES)
        .map_err(|e| format!("workspace lacks a live package: {e}"))?
        .to_feature_set(StandardFeatures::Default);
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

/// Use the open PR's exact target commit when GitHub CLI and that commit are
/// available locally. A tracking upstream normally names the feature branch
/// itself, so it cannot establish a stack's parent.
pub fn default_base(root: &Path) -> Result<(String, String)> {
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct PullRequest {
        state: String,
        base_ref_name: String,
        base_ref_oid: String,
    }

    let detected = (|| -> Result<PullRequest> {
        git(root, &["symbolic-ref", "--quiet", "HEAD"])
            .map_err(|_| "detached checkout".to_owned())?;
        let output = Command::new("gh")
            .args(["pr", "view", "--json", "state,baseRefName,baseRefOid"])
            .env("GH_PROMPT_DISABLED", "true")
            .current_dir(root)
            .output()
            .map_err(|_| "GitHub CLI is unavailable".to_owned())?;
        if !output.status.success() {
            return Err("no open PR found or GitHub is unavailable".into());
        }
        let pr: PullRequest = serde_json::from_slice(&output.stdout)
            .map_err(|_| "GitHub returned invalid PR metadata".to_owned())?;
        if pr.state != "OPEN" {
            return Err("the branch's PR is not open".into());
        }
        if pr.base_ref_oid.len() != 40
            || !pr.base_ref_oid.bytes().all(|byte| byte.is_ascii_hexdigit())
        {
            return Err("GitHub returned an invalid base commit".into());
        }
        git(
            root,
            &["cat-file", "-e", &format!("{}^{{commit}}", pr.base_ref_oid)],
        )
        .map_err(|_| {
            format!(
                "PR target {} is not available locally; fetch it to select against it",
                pr.base_ref_name
            )
        })?;
        Ok(pr)
    })();
    let selected = match detected {
        Ok(pr) => (
            pr.base_ref_oid,
            format!("open PR target {}", pr.base_ref_name),
        ),
        Err(reason) => ("origin/v1".into(), format!("fallback: {reason}")),
    };
    git(root, &["rev-parse", "--verify", &format!("{}^{{commit}}", selected.0)])
        .map_err(|_| format!("default base {} is unavailable ({}); fetch origin v1, pass --base REVISION, or use --full", selected.0, selected.1))?;
    Ok(selected)
}
