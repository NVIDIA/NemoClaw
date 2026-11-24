// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! The version a bundle reports in `nemoclaw --version` and names its
//! providers with. CI / Bundle's runs in NVIDIA/NemoClaw number their builds,
//! so no two of its builds share a version, except attempts of a tag's run,
//! which report the tag; any other build names its source inputs.
use std::{path::Path, process::Command};

/// Where a split bundle's compiled parts record their version for assembly.
pub const BUNDLE_VERSION_FILE: &str = "target/bundle-version";

/// The repository whose CI / Bundle runs number their bundles.
const REPOSITORY: &str = "NVIDIA/NemoClaw";
/// CI / Bundle's workflow, which counts its own run numbers.
const WORKFLOW: &str = "NVIDIA/NemoClaw/.github/workflows/rust.yml@";

/// The GitHub Actions run that builds a bundle, as its environment names it;
/// a local build has none.
#[derive(Clone, Debug, Default)]
pub struct Run {
    /// `GITHUB_REPOSITORY`.
    pub repository: String,
    /// `GITHUB_WORKFLOW_REF`, which names the calling workflow in a reusable one.
    pub workflow_ref: String,
    /// `GITHUB_EVENT_NAME`.
    pub event: String,
    /// `GITHUB_REF`.
    pub git_ref: String,
    /// `GITHUB_RUN_NUMBER`.
    pub number: String,
    /// `GITHUB_RUN_ATTEMPT`.
    pub attempt: String,
}

impl Run {
    pub fn from_env() -> Self {
        let get = |name| std::env::var(name).unwrap_or_default();
        Self {
            repository: get("GITHUB_REPOSITORY"),
            workflow_ref: get("GITHUB_WORKFLOW_REF"),
            event: get("GITHUB_EVENT_NAME"),
            git_ref: get("GITHUB_REF"),
            number: get("GITHUB_RUN_NUMBER"),
            attempt: get("GITHUB_RUN_ATTEMPT"),
        }
    }
}

/// The version of a bundle built at `root` from the sources that `source`
/// names, in the run that this process's environment describes; see
/// [`stamped_version`].
pub fn bundle_version(root: &Path, source: &str) -> Result<String, String> {
    stamped_version(root, env!("CARGO_PKG_VERSION"), source, &Run::from_env())
}

/// The version of a bundle built at `root`, whose workspace version is
/// `workspace` and whose source inputs hash to `source`, in `run`.
///
/// The next version is the higher of `workspace` and the patch after the
/// highest release tag `vA.B.C` that HEAD reaches; the highest reachable
/// release candidate tag `vX.Y.Z-rc.N` of that version applies to it.
/// CI / Bundle's run for the push of such a tag, at a clean checkout of it,
/// reports the tag; its other runs report `X.Y.Z-RUN` or `X.Y.Z-rc.N.RUN`,
/// with `.ATTEMPT` from the second attempt. Any other build reports
/// `X.Y.Z-dev.SOURCE`. A numbered build needs the checkout's history.
pub fn stamped_version(
    root: &Path,
    workspace: &str,
    source: &str,
    run: &Run,
) -> Result<String, String> {
    let workspace = core(workspace)
        .ok_or_else(|| format!("the workspace version {workspace} isn't MAJOR.MINOR.PATCH"))?;
    let numbered = run.repository == REPOSITORY
        && run.workflow_ref.starts_with(WORKFLOW)
        && number(&run.number).is_some_and(|number| number > 0);
    let tags = match reachable_tags(root) {
        Some(tags) => tags,
        None if numbered => {
            return Err(
                "a CI build names its version from the tags that HEAD reaches; check out the \
                 history and tags, such as with fetch-depth: 0"
                    .into(),
            );
        }
        // A local build without the history, such as from a source archive.
        None => Vec::new(),
    };
    let released = tags
        .iter()
        .filter_map(|tag| match tag {
            Tag::Release(version) => Some(*version),
            Tag::Candidate(..) => None,
        })
        .max();
    let next = released
        .map(|(major, minor, patch)| (major, minor, patch + 1))
        .map_or(workspace, |bumped| bumped.max(workspace));
    let (major, minor, patch) = next;
    if !numbered {
        return Ok(format!(
            "{major}.{minor}.{patch}-dev.{}",
            identifier(source)
        ));
    }
    if run.event == "push"
        && let Some(name) = run.git_ref.strip_prefix("refs/tags/")
        && let Some(version) = name.strip_prefix('v')
        && tag(name).is_some()
        && checked_out(root, name)
    {
        return Ok(version.into());
    }
    let mut version = format!("{major}.{minor}.{patch}-");
    let candidate = tags
        .iter()
        .filter_map(|tag| match tag {
            Tag::Candidate(version, candidate) if *version == next => Some(*candidate),
            _ => None,
        })
        .max();
    if let Some(candidate) = candidate {
        version.push_str(&format!("rc.{candidate}."));
    }
    version.push_str(&run.number);
    let attempt = if run.attempt.is_empty() {
        1
    } else {
        number(&run.attempt).ok_or_else(|| format!("invalid run attempt {}", run.attempt))?
    };
    if attempt >= 2 {
        version.push_str(&format!(".{attempt}"));
    }
    Ok(version)
}

/// What kind of build a version names: `release` without a pre-release
/// part, such as `0.1.0`, and `dev` otherwise.
pub fn build_kind(version: &str) -> &'static str {
    if version.split('+').next().unwrap_or_default().contains('-') {
        "dev"
    } else {
        "release"
    }
}

type Core = (u64, u64, u64);

enum Tag {
    Release(Core),
    Candidate(Core, u64),
}

/// A release tag `vX.Y.Z` or a release candidate tag `vX.Y.Z-rc.N`.
fn tag(name: &str) -> Option<Tag> {
    let version = name.strip_prefix('v')?;
    Some(match version.split_once('-') {
        None => Tag::Release(core(version)?),
        Some((version, candidate)) => {
            Tag::Candidate(core(version)?, number(candidate.strip_prefix("rc.")?)?)
        }
    })
}

pub(super) fn core(version: &str) -> Option<Core> {
    let mut parts = version.split('.');
    let core = (
        number(parts.next()?)?,
        number(parts.next()?)?,
        number(parts.next()?)?,
    );
    parts.next().is_none().then_some(core)
}

/// A semver numeric identifier: digits, without a leading zero.
fn number(identifier: &str) -> Option<u64> {
    let digits = !identifier.is_empty() && identifier.bytes().all(|b| b.is_ascii_digit());
    if !digits || (identifier.len() > 1 && identifier.starts_with('0')) {
        return None;
    }
    identifier.parse().ok()
}

/// `source` as a semver identifier: a hash of only digits loses its leading
/// zeros, which a numeric identifier can't have.
fn identifier(source: &str) -> &str {
    if source.bytes().all(|b| b.is_ascii_digit()) {
        let trimmed = source.trim_start_matches('0');
        if trimmed.is_empty() { "0" } else { trimmed }
    } else {
        source
    }
}

/// The version tags that HEAD reaches, or None without a complete history.
fn reachable_tags(root: &Path) -> Option<Vec<Tag>> {
    if git(root, &["rev-parse", "--is-shallow-repository"])? != "false" {
        return None;
    }
    let tags = git(root, &["tag", "--merged", "HEAD", "--list", "v*"])?;
    Some(tags.lines().filter_map(tag).collect())
}

/// Whether `root` is a clean checkout of tag `name`.
fn checked_out(root: &Path, name: &str) -> bool {
    let tagged = git(
        root,
        &[
            "rev-parse",
            "--verify",
            &format!("refs/tags/{name}^{{commit}}"),
        ],
    );
    tagged.is_some()
        && tagged == git(root, &["rev-parse", "--verify", "HEAD"])
        && git(root, &["status", "--porcelain", "--untracked-files=no"]).as_deref() == Some("")
}

fn git(root: &Path, args: &[&str]) -> Option<String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(args)
        .stderr(std::process::Stdio::null())
        .output()
        .ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).trim().to_owned())
}
