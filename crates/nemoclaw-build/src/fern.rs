// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Prepare, validate, and publish documentation with the pinned Fern CLI.
//!
//! Adapted from main's Fern workflows; see fern/NOTICE.md. Cargo generates
//! the v1 pages; main's pages come from an isolated import of a pinned
//! revision. Every publication guard runs before any tool sees a token.

use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

type Result<T> = std::result::Result<T, String>;

const STAGING: &str = "nvidia-nemoclaw-staging.docs.buildwithfern.com/nemoclaw";
const PUBLIC: &str = "nvidia-nemoclaw.docs.buildwithfern.com/nemoclaw";
const MAIN_SCRIPTS: [&str; 2] = ["generate-starter-prompt", "sync-agent-variant-docs"];
const COMMENT_MARKER: &str = "<!-- fern-preview-docs-v1 -->";

fn lowercase_hex(text: &str, length: usize) -> bool {
    text.len() == length
        && text
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// Main's documentation must come from a full, immutable commit.
pub fn validate_revision(revision: &str) -> Result<()> {
    if lowercase_hex(revision, 40) {
        Ok(())
    } else {
        Err("main documentation source requires a full lowercase 40-hex commit".into())
    }
}

/// Main's absolute snippet paths are relative to its original fern folder.
pub fn adapt_main_snippets(root: &Path) -> Result<()> {
    fn visit(directory: &Path) -> Result<()> {
        for entry in fs::read_dir(directory).map_err(|e| e.to_string())? {
            let path = entry.map_err(|e| e.to_string())?.path();
            if path.is_dir() {
                visit(&path)?;
            } else if path.extension().is_some_and(|ext| ext == "mdx") {
                let source = fs::read_to_string(&path).map_err(|e| e.to_string())?;
                let adapted = source.replace("src=\"/../docs/", "src=\"/_main/docs/");
                if adapted != source {
                    fs::write(&path, adapted).map_err(|e| e.to_string())?;
                }
            }
        }
        Ok(())
    }
    visit(&root.join("docs"))
}

/// Previews use `nemoclaw-v1` IDs so they never replace main's previews.
pub fn preview_url(identifier: &str) -> Result<String> {
    let words = identifier.strip_prefix("nemoclaw-v1");
    let valid = words.is_some_and(|rest| {
        rest.is_empty()
            || rest.strip_prefix('-').is_some_and(|rest| {
                rest.split('-').all(|word| {
                    !word.is_empty()
                        && word
                            .bytes()
                            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
                })
            })
    });
    if !valid {
        return Err("preview ID must be nemoclaw-v1 or start with nemoclaw-v1- and use lowercase words/numbers".into());
    }
    Ok(format!(
        "https://nvidia-preview-{identifier}.docs.buildwithfern.com/nemoclaw"
    ))
}

/// The URL Fern reports for a successful preview, if it is this preview's.
pub fn published_preview(identifier: &str, succeeded: bool, output: &str) -> Result<String> {
    let expected = preview_url(identifier)?;
    if !succeeded {
        return Err("Fern preview publication failed".into());
    }
    let reported = output
        .split("Published docs to ")
        .nth(1)
        .map(|rest| {
            rest.split(|c: char| c.is_whitespace() || c == '\u{1b}')
                .next()
                .unwrap_or("")
        })
        .filter(|url| url.starts_with("https://"));
    match reported {
        Some(url) if url == expected || url.starts_with(&format!("{expected}/")) => Ok(url.into()),
        _ => Err("Fern did not report the expected v1 preview URL".into()),
    }
}

/// The release identity, read from the workflow environment.
pub struct Release {
    pub enabled: Option<String>,
    pub ref_type: Option<String>,
    pub ref_name: Option<String>,
}

impl Release {
    pub fn from_environment() -> Self {
        let var = |name| std::env::var(name).ok();
        Self {
            enabled: var("FERN_V1_PUBLIC_ENABLED"),
            ref_type: var("GITHUB_REF_TYPE"),
            ref_name: var("GITHUB_REF_NAME"),
        }
    }

    /// The v1 release tag, if public publication is enabled for it.
    pub fn tag(&self) -> Result<&str> {
        if self.enabled.as_deref() != Some("true") {
            return Err(
                "set FERN_V1_PUBLIC_ENABLED=true only after coordinating shared-site publication"
                    .into(),
            );
        }
        let tag = self.ref_name.as_deref().unwrap_or("");
        let version = tag.strip_prefix("v1.").unwrap_or("");
        let (numbers, suffix) = version.split_once('-').unwrap_or((version, ""));
        let numbers: Vec<_> = numbers.split('.').collect();
        let valid = self.ref_type.as_deref() == Some("tag")
            && numbers.len() == 2
            && numbers
                .iter()
                .all(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
            && (!version.contains('-') || !suffix.is_empty())
            && suffix
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-');
        if valid {
            Ok(tag)
        } else {
            Err("public publication requires a v1 release tag".into())
        }
    }
}

/// Preview IDs of merged v1 pull requests, from `gh api --paginate --slurp`.
pub fn preview_ids_to_delete(pages: &Value) -> Result<Vec<String>> {
    let mut identifiers = Vec::new();
    for pull in pages
        .as_array()
        .into_iter()
        .flatten()
        .flat_map(|page| page.as_array().into_iter().flatten())
    {
        if pull["merged_at"].is_string() && pull["base"]["ref"] == "v1" {
            let number = pull["number"]
                .as_u64()
                .ok_or("pull request number is not an integer")?;
            identifiers.push(format!("nemoclaw-v1-pr-{number}"));
        }
    }
    Ok(identifiers)
}

/// The GitHub API request that updates this workflow's preview comment, or
/// creates it: endpoint, method, and body.
pub fn preview_comment(
    repository: &str,
    number: u64,
    url: &str,
    pages: &Value,
) -> Result<(String, &'static str, Value)> {
    let existing = pages
        .as_array()
        .into_iter()
        .flatten()
        .flat_map(|page| page.as_array().into_iter().flatten())
        .find(|comment| {
            comment["user"]["login"] == "github-actions[bot]"
                && comment["body"]
                    .as_str()
                    .is_some_and(|body| body.contains(COMMENT_MARKER))
        });
    let body = json!({"body": format!("**v1 documentation preview:** {url}\n\n{COMMENT_MARKER}")});
    Ok(match existing {
        Some(comment) => {
            let id = comment["id"]
                .as_u64()
                .ok_or("comment ID is not an integer")?;
            (
                format!("repos/{repository}/issues/comments/{id}"),
                "PATCH",
                body,
            )
        }
        None => (
            format!("repos/{repository}/issues/{number}/comments"),
            "POST",
            body,
        ),
    })
}

// --- Tool-running steps -----------------------------------------------------

fn windows_suffix(name: &str) -> String {
    if cfg!(windows) {
        format!("{name}.cmd")
    } else {
        name.into()
    }
}

fn status(command: &mut Command, what: &str) -> Result<()> {
    let succeeded = command
        .stdin(Stdio::null())
        .status()
        .map_err(|_| format!("cannot run {what}"))?
        .success();
    succeeded
        .then_some(())
        .ok_or_else(|| format!("{what} failed"))
}

fn output(command: &mut Command, what: &str) -> Result<String> {
    let result = command
        .stdin(Stdio::null())
        .stderr(Stdio::inherit())
        .output()
        .map_err(|_| format!("cannot run {what}"))?;
    if !result.status.success() {
        return Err(format!("{what} failed"));
    }
    String::from_utf8(result.stdout).map_err(|_| format!("{what} printed non-UTF-8 output"))
}

fn read_json(path: &Path) -> Result<Value> {
    let bytes = fs::read(path).map_err(|_| format!("cannot read {}", path.display()))?;
    serde_json::from_slice(&bytes).map_err(|_| format!("{} is not JSON", path.display()))
}

fn git(root: &Path) -> Command {
    let mut command = Command::new("git");
    command.current_dir(root);
    command
}

fn run_main_script(directory: &Path, script: &str, arguments: &[&str]) -> Result<()> {
    let result = Command::new("node")
        .arg(format!("scripts/{script}.mts"))
        .args(arguments)
        .current_dir(directory)
        .stdin(Stdio::null())
        .output()
        .map_err(|_| "cannot run node; install Node.js for the documentation tools")?;
    if !result.status.success() {
        return Err(format!(
            "{script} failed:\n{}{}",
            String::from_utf8_lossy(&result.stdout),
            String::from_utf8_lossy(&result.stderr)
        ));
    }
    Ok(())
}

/// Import main's documentation at its pinned revision, regenerating only when
/// the revision or its locked generator dependency changes.
fn prepare_main(root: &Path) -> Result<()> {
    let revision = read_json(&root.join("fern/main-source.json"))?["revision"]
        .as_str()
        .unwrap_or("")
        .to_owned();
    validate_revision(&revision)?;
    let dependencies = root.join("tools/docs/main");
    let lock = fs::read(dependencies.join("package-lock.json"))
        .map_err(|_| "cannot read the main docs lock file")?;
    let identity = json!({
        "revision": revision,
        "dependencies": crate::hex(&Sha256::digest(&lock)),
        "format": 2,
    });
    let destination = root.join("fern/_main");
    let stamp = destination.join(".source.json");
    if read_json(&stamp).ok() != Some(identity.clone()) {
        let present = git(root)
            .args(["cat-file", "-e", &format!("{revision}^{{commit}}")])
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|status| status.success());
        if !present {
            status(
                git(root).args(["fetch", "--no-tags", "--depth=1", "origin", &revision]),
                "git fetch of main's documentation revision",
            )?;
        }
        let staging = tempfile::tempdir_in(root.join("fern"))
            .map_err(|_| "cannot create a staging directory")?;
        let archive = git(root)
            .args(["archive", &revision, "LICENSE", "docs", "fern"])
            .args(MAIN_SCRIPTS.map(|script| format!("scripts/{script}.mts")))
            .arg("scripts/check-docs-published-routes.mts")
            .stdin(Stdio::null())
            .stderr(Stdio::inherit())
            .output()
            .map_err(|_| "cannot run git archive")?;
        if !archive.status.success() {
            return Err("git archive of main's documentation failed".into());
        }
        tar::Archive::new(archive.stdout.as_slice())
            .unpack(staging.path())
            .map_err(|_| "cannot unpack main's documentation")?;
        for name in ["package.json", "package-lock.json"] {
            fs::copy(dependencies.join(name), staging.path().join(name))
                .map_err(|_| format!("cannot copy {name}"))?;
        }
        status(
            Command::new(windows_suffix("npm"))
                .args(["ci", "--ignore-scripts", "--prefix"])
                .arg(staging.path()),
            "npm ci for main's documentation generators",
        )?;
        for script in MAIN_SCRIPTS {
            run_main_script(staging.path(), script, &[])?;
        }
        adapt_main_snippets(staging.path())?;
        let mut stamp_text = serde_json::to_string_pretty(&identity).expect("identity serializes");
        stamp_text.push('\n');
        fs::write(staging.path().join(".source.json"), stamp_text)
            .map_err(|_| "cannot write the import stamp")?;
        if destination.exists() {
            fs::remove_dir_all(&destination).map_err(|_| "cannot replace fern/_main")?;
        }
        fs::rename(staging.keep(), &destination).map_err(|_| "cannot install fern/_main")?;
    }
    for script in MAIN_SCRIPTS {
        run_main_script(&destination, script, &["--check"])?;
    }
    run_main_script(&destination, "check-docs-published-routes", &[])?;
    eprintln!("Main documentation prepared from {revision}.");
    Ok(())
}

fn fern_command(root: &Path, directory: Option<&Path>) -> Result<Command> {
    let version = read_json(&root.join("fern/fern.config.json"))?["version"]
        .as_str()
        .ok_or("fern/fern.config.json has no version")?
        .to_owned();
    let mut command = Command::new(windows_suffix("npx"));
    command
        .args(["--yes", &format!("fern-api@{version}")])
        .current_dir(directory.map_or_else(|| root.join("fern"), Path::to_path_buf))
        .stdin(Stdio::null());
    Ok(command)
}

fn run_fern(root: &Path, arguments: &[&str], directory: Option<&Path>) -> Result<()> {
    status(fern_command(root, directory)?.args(arguments), "fern")
}

/// Run Fern and return whether it succeeded and its combined output, also
/// echoed to stdout.
fn capture_fern(root: &Path, arguments: &[&str]) -> Result<(bool, String)> {
    let result = fern_command(root, None)?
        .args(arguments)
        .output()
        .map_err(|_| "cannot run fern")?;
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&result.stdout),
        String::from_utf8_lossy(&result.stderr)
    );
    print!("{text}");
    Ok((result.status.success(), text))
}

/// Check v1 alone, with strict link checking, from a copy of its sources.
fn validate_v1(root: &Path) -> Result<()> {
    let source = root.join("fern");
    let parsed = output(
        Command::new("node")
            .arg("-e")
            .arg("const fs = require('node:fs'); const {createRequire} = require('node:module'); const yaml = createRequire(process.argv[1])('yaml'); console.log(JSON.stringify(yaml.parse(fs.readFileSync(process.argv[2], 'utf8'))));")
            .arg(source.join("_main/package.json"))
            .arg(source.join("docs.yml")),
        "node to read fern/docs.yml",
    )?;
    let mut config: Value =
        serde_json::from_str(&parsed).map_err(|_| "fern/docs.yml did not parse")?;
    let versions: Vec<Value> = config["versions"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|version| version["slug"] == "v1")
        .cloned()
        .collect();
    if versions.len() != 1 {
        return Err("Fern must define exactly one v1 version".into());
    }
    config["versions"] = Value::Array(versions);
    if let Some(object) = config.as_object_mut() {
        for legacy in ["redirects", "css", "experimental", "js"] {
            object.remove(legacy);
        }
    }
    config["logo"]["href"] = json!("/nemoclaw/v1/overview");
    let build = root.join(".build");
    fs::create_dir_all(&build).map_err(|_| "cannot create .build")?;
    let temporary =
        tempfile::tempdir_in(&build).map_err(|_| "cannot create a v1 check directory")?;
    let destination = temporary.path().join("fern");
    fs::create_dir(&destination).map_err(|_| "cannot create the v1 check directory")?;
    fs::copy(
        source.join("fern.config.json"),
        destination.join("fern.config.json"),
    )
    .map_err(|_| "cannot copy fern.config.json")?;
    for directory in ["_generated", "assets"] {
        copy_tree(&source.join(directory), &destination.join(directory))?;
    }
    let mut text = serde_json::to_string_pretty(&config).expect("config serializes");
    text.push('\n');
    fs::write(destination.join("docs.yml"), text).map_err(|_| "cannot write the v1 docs.yml")?;
    run_fern(
        root,
        &["check", "--local", "--strict-broken-links"],
        Some(&destination),
    )
}

fn copy_tree(from: &Path, to: &Path) -> Result<()> {
    fs::create_dir_all(to).map_err(|_| format!("cannot create {}", to.display()))?;
    for entry in fs::read_dir(from).map_err(|_| format!("cannot read {}", from.display()))? {
        let entry = entry.map_err(|e| e.to_string())?;
        let target: PathBuf = to.join(entry.file_name());
        if entry.path().is_dir() {
            copy_tree(&entry.path(), &target)?;
        } else {
            fs::copy(entry.path(), &target)
                .map_err(|_| format!("cannot copy {}", entry.path().display()))?;
        }
    }
    Ok(())
}

/// Import main, check generated outputs, then validate v1 and the combined site.
pub fn check(root: &Path) -> Result<()> {
    // Node resolves the imported `yaml` package from an absolute path.
    let root = &std::path::absolute(root).map_err(|_| "cannot resolve the repository root")?;
    prepare_main(root)?;
    crate::schema::generate(root, true)?;
    crate::docs::generate(root, false, None).map_err(|e| e.to_string())?;
    crate::docs::generate(root, true, None).map_err(|e| e.to_string())?;
    validate_v1(root)?;
    // Main keeps its own route checker; Fern's stricter rule reports legacy
    // Markdown-download URLs and relative component links as broken.
    run_fern(root, &["check", "--local"], None)
}

pub fn dev(root: &Path) -> Result<()> {
    check(root)?;
    run_fern(root, &["docs", "dev"], None)
}

/// Publish an isolated preview and return its URL.
pub fn preview(root: &Path, identifier: &str) -> Result<String> {
    preview_url(identifier)?;
    check(root)?;
    let (succeeded, text) = capture_fern(
        root,
        &[
            "generate",
            "--docs",
            "--instance",
            STAGING,
            "--preview",
            "--id",
            identifier,
        ],
    )?;
    let url = published_preview(identifier, succeeded, &text)?;
    if let Some(file) = std::env::var_os("GITHUB_OUTPUT") {
        use std::io::Write;
        let mut file = fs::OpenOptions::new()
            .append(true)
            .open(file)
            .map_err(|_| "cannot open GITHUB_OUTPUT")?;
        writeln!(file, "preview_url={url}").map_err(|_| "cannot write GITHUB_OUTPUT")?;
    }
    Ok(url)
}

pub fn delete(root: &Path, identifier: &str) -> Result<()> {
    let url = preview_url(identifier)?;
    let (succeeded, text) = capture_fern(root, &["docs", "preview", "delete", &url])?;
    if succeeded || text.lines().any(|line| line == "Domain not registered") {
        Ok(())
    } else {
        Err("Fern preview deletion failed".into())
    }
}

/// Publish main and v1 from a tagged commit on v1's history.
pub fn public(root: &Path, release: &Release) -> Result<()> {
    // Check the release identity before compiling, validating, or using a token.
    let tag = release.tag()?;
    let tagged = output(
        git(root).args(["rev-parse", &format!("{tag}^{{commit}}")]),
        "git rev-parse",
    )?;
    let current = output(git(root).args(["rev-parse", "HEAD"]), "git rev-parse")?;
    if tagged.trim() != current.trim() {
        return Err("public publication must run from the tagged commit".into());
    }
    status(
        git(root).args(["fetch", "--no-tags", "origin", "v1"]),
        "git fetch of v1",
    )?;
    status(
        git(root).args(["merge-base", "--is-ancestor", "HEAD", "origin/v1"]),
        "the check that the tag is on v1's history",
    )?;
    check(root)?;
    run_fern(root, &["generate", "--docs", "--instance", PUBLIC], None)
}

fn gh_json(arguments: &[&str]) -> Result<Value> {
    let text = output(Command::new("gh").args(arguments), "gh api")?;
    serde_json::from_str(&text).map_err(|_| "gh api returned non-JSON output".into())
}

/// Create or update the pull request's preview comment.
pub fn comment(repository: &str, number: u64, url: &str) -> Result<()> {
    let pages = gh_json(&[
        "api",
        "--paginate",
        "--slurp",
        &format!("repos/{repository}/issues/{number}/comments"),
    ])?;
    let (endpoint, method, body) = preview_comment(repository, number, url, &pages)?;
    let file = tempfile::NamedTempFile::new().map_err(|_| "cannot create the comment body")?;
    fs::write(file.path(), body.to_string()).map_err(|_| "cannot write the comment body")?;
    status(
        Command::new("gh")
            .args(["api", &endpoint, "--method", method, "--input"])
            .arg(file.path()),
        "gh api comment",
    )
}

/// Delete previews of v1 pull requests merged by this commit.
pub fn delete_merged(root: &Path, repository: &str, commit: &str) -> Result<()> {
    if !lowercase_hex(commit, 40) {
        return Err("commit must be a full lowercase 40-hex SHA".into());
    }
    let pages = gh_json(&[
        "api",
        "--paginate",
        "--slurp",
        &format!("repos/{repository}/commits/{commit}/pulls"),
    ])?;
    for identifier in preview_ids_to_delete(&pages)? {
        delete(root, &identifier)?;
    }
    Ok(())
}
