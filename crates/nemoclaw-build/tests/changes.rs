// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Whether a change can affect `CI / Images` or the live suites, decided from a real
//! Git history and Cargo workspace without network access.

use std::{fs, path::Path, process::Command};

const RULES: &str = include_str!("../../../.config/determinator-images.toml");
const LIVE_RULES: &str = include_str!("../../../.config/determinator-live.toml");
const BUNDLE_RULES: &str = include_str!("../../../.config/determinator-bundle.toml");
const LIFECYCLE_RULES: &str = include_str!("../../../.config/determinator-lifecycle.toml");

fn manifest(name: &str, dependencies: &str) -> String {
    format!(
        "[package]\nname = \"{name}\"\nversion = \"0.1.0\"\nedition = \"2021\"\n\n[dependencies]\n{dependencies}"
    )
}

fn run(dir: &Path, program: &str, args: &[&str]) -> std::process::Output {
    Command::new(program)
        .args(args)
        .current_dir(dir)
        .env("GIT_AUTHOR_NAME", "test")
        .env("GIT_AUTHOR_EMAIL", "test@example.com")
        .env("GIT_COMMITTER_NAME", "test")
        .env("GIT_COMMITTER_EMAIL", "test@example.com")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("HOME", dir)
        .output()
        .unwrap()
}

fn succeed(dir: &Path, program: &str, args: &[&str]) -> String {
    let output = run(dir, program, args);
    assert!(
        output.status.success(),
        "{program} {args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap()
}

fn cargo() -> String {
    std::env::var("CARGO").unwrap_or_else(|_| "cargo".into())
}

/// A committed workspace shaped like this repository's image build: the build tool
/// reaches the SDK only through its default feature, and the proxy uses the runtime.
struct Repo(tempfile::TempDir);

/// The fixture workspace's files, by path.
fn fixture_files() -> Vec<(String, String)> {
    let build = manifest(
        "nemoclaw-build",
        "nemoclaw-runtime = { path = \"../nemoclaw-runtime\" }\nnemoclaw-sdk = { path = \"../nemoclaw-sdk\", optional = true }\n\n[features]\ndefault = [\"sdk\"]\nsdk = [\"dep:nemoclaw-sdk\"]\n",
    );
    let files = [
        (
            "Cargo.toml",
            "[workspace]\nmembers = [\"crates/*\"]\nresolver = \"2\"\n".to_owned(),
        ),
        ("crates/nemoclaw-build/Cargo.toml", build),
        (
            "crates/nemoclaw-ollama-proxy/Cargo.toml",
            manifest(
                "nemoclaw-ollama-proxy",
                "nemoclaw-runtime = { path = \"../nemoclaw-runtime\" }\n",
            ),
        ),
        (
            "crates/nemoclaw-runtime/Cargo.toml",
            manifest("nemoclaw-runtime", ""),
        ),
        (
            "crates/nemoclaw-sdk/Cargo.toml",
            manifest("nemoclaw-sdk", ""),
        ),
        ("crates/nemoclaw-sdk/src/extra.rs", String::new()),
        (
            "crates/nemoclaw-e2e/Cargo.toml",
            manifest(
                "nemoclaw-e2e",
                "nemoclaw-sdk = { path = \"../nemoclaw-sdk\" }\n",
            ),
        ),
        (".config/determinator-images.toml", RULES.to_owned()),
        (".config/determinator-live.toml", LIVE_RULES.to_owned()),
        (".config/determinator-bundle.toml", BUNDLE_RULES.to_owned()),
        (
            ".config/determinator-lifecycle.toml",
            LIFECYCLE_RULES.to_owned(),
        ),
        (".config/nextest.toml", "\n".into()),
        (
            ".github/workflows/bundle-platform.yml",
            "name: native\n".into(),
        ),
        ("examples/local.yaml", "kind: Deployment\n".into()),
        ("versions.json", "{}\n".into()),
        (".dockerignore", "*\n".into()),
        (".github/workflows/images.yml", "name: images\n".into()),
        (".github/workflows/rust.yml", "name: rust\n".into()),
        ("LICENSE", "license\n".into()),
        ("docker-bake.hcl", "\n".into()),
        ("docs/guide.md", "# Guide\n".into()),
        ("image/fabric/Dockerfile", "FROM scratch\n".into()),
        ("ruff.toml", "\n".into()),
        ("image/vllm/Dockerfile", "FROM scratch\n".into()),
        (
            "rust-toolchain.toml",
            "[toolchain]\nchannel = \"1.98.1\"\n".into(),
        ),
    ];
    let mut files: Vec<(String, String)> = files
        .into_iter()
        .map(|(path, contents)| (path.to_owned(), contents))
        .collect();
    // The rest of the live build: the CLI and providers in the bundle, and a
    // package outside it.
    for name in [
        "nemoclaw-cli",
        "nemoclaw-provider",
        "openshell-provider",
        "fabric-provider",
        "nemoclaw-onboarding",
        "nemoclaw-fixture-provider",
    ] {
        files.push((
            format!("crates/{name}/Cargo.toml"),
            manifest(name, "nemoclaw-sdk = { path = \"../nemoclaw-sdk\" }\n"),
        ));
        files.push((format!("crates/{name}/src/lib.rs"), String::new()));
    }
    for name in ["build", "ollama-proxy", "runtime", "sdk", "e2e"] {
        files.push((format!("crates/nemoclaw-{name}/src/lib.rs"), String::new()));
    }
    files
}

/// The committed fixture workspace. Building it runs Cargo and Git, which is
/// slow on a loaded runner, so it's built once per fixture and toolchain in
/// Cargo's test directory and each test copies it.
fn template() -> std::path::PathBuf {
    use sha2::{Digest, Sha256};
    let files = fixture_files();
    let mut hash = Sha256::new();
    hash.update(include_str!("../../../rust-toolchain.toml"));
    for (path, contents) in &files {
        hash.update(path);
        hash.update([0]);
        hash.update(contents);
        hash.update([0]);
    }
    let key: String = hash.finalize()[..8]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    let root = Path::new(env!("CARGO_TARGET_TMPDIR"));
    let template = root.join(format!("changes-fixture-{key}"));
    if complete(&template) {
        return template;
    }
    let building = tempfile::tempdir_in(root).unwrap();
    for (path, contents) in &files {
        write(building.path(), path, contents);
    }
    succeed(
        building.path(),
        &cargo(),
        &["generate-lockfile", "--offline"],
    );
    succeed(building.path(), "git", &["init", "-q"]);
    succeed(building.path(), "git", &["add", "-A"]);
    succeed(building.path(), "git", &["commit", "-q", "-m", "base"]);
    fs::write(building.path().join(".git").join(COMPLETE), "").unwrap();
    // A cache can restore an incomplete template; replace it. A concurrent
    // test may finish first; the copies are equivalent.
    if template.exists() && !complete(&template) {
        let _ = fs::remove_dir_all(&template);
    }
    let building = building.keep();
    if fs::rename(&building, &template).is_err() {
        let _ = fs::remove_dir_all(&building);
    }
    assert!(
        complete(&template),
        "the changes fixture template is incomplete"
    );
    template
}

/// Marks a template whose build finished; inside `.git`, so copies don't see
/// it as an untracked file.
const COMPLETE: &str = "nemoclaw-fixture-complete";

/// Whether `template` finished building and is still a usable Git repository.
/// A restored cache can keep directories but drop files, so `.git` existing
/// isn't enough.
fn complete(template: &Path) -> bool {
    template.join(".git").join(COMPLETE).is_file()
        && std::process::Command::new("git")
            .args(["rev-parse", "--verify", "--quiet", "HEAD"])
            .current_dir(template)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .is_ok_and(|status| status.success())
}

#[test]
fn an_incomplete_template_is_not_reused() {
    let partial = tempfile::tempdir().unwrap();
    fs::create_dir_all(partial.path().join(".git").join("objects")).unwrap();
    fs::write(partial.path().join(".git").join(COMPLETE), "").unwrap();
    assert!(
        !complete(partial.path()),
        "an empty .git must not count as a template"
    );
    assert!(complete(&template()));
}

/// Copy a directory tree, Git metadata included.
fn copy_tree(from: &Path, to: &Path) {
    for entry in fs::read_dir(from).unwrap() {
        let entry = entry.unwrap();
        let target = to.join(entry.file_name());
        if entry.file_type().unwrap().is_dir() {
            fs::create_dir_all(&target).unwrap();
            copy_tree(&entry.path(), &target);
        } else {
            fs::copy(entry.path(), &target).unwrap();
        }
    }
}

impl Repo {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        copy_tree(&template(), dir.path());
        Self(dir)
    }

    fn base(&self) -> String {
        succeed(self.0.path(), "git", &["rev-parse", "HEAD"])
            .trim()
            .to_owned()
    }

    /// Commit the edits (None deletes a file), then ask about the base commit.
    fn decide(&self, edits: &[(&str, Option<&str>)], base: Option<&str>) -> (String, String) {
        self.decide_for("images", edits, base)
    }

    fn decide_for(
        &self,
        workflow: &str,
        edits: &[(&str, Option<&str>)],
        base: Option<&str>,
    ) -> (String, String) {
        let recorded = self.base();
        for (path, contents) in edits {
            match contents {
                Some(contents) => write(self.0.path(), path, contents),
                None => fs::remove_file(self.0.path().join(path)).unwrap(),
            }
        }
        succeed(self.0.path(), "git", &["add", "-A"]);
        succeed(self.0.path(), "git", &["commit", "-q", "-m", "change"]);
        let output = Command::new(env!("CARGO_BIN_EXE_nemoclaw-build"))
            .args(["changes", workflow, "--base", base.unwrap_or(&recorded)])
            .current_dir(self.0.path())
            .env("CARGO", cargo())
            .env("CARGO_NET_OFFLINE", "true")
            .env("HOME", self.0.path())
            .output()
            .unwrap();
        let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
        assert!(output.status.success(), "{stderr}");
        (
            String::from_utf8(output.stdout).unwrap().trim().to_owned(),
            stderr,
        )
    }
}

fn write(root: &Path, path: &str, contents: &str) {
    let path = root.join(path);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, contents).unwrap();
}

/// Decide for a valid change, which the analysis must complete rather than fail open.
fn images(edits: &[(&str, Option<&str>)]) -> String {
    let (decision, stderr) = Repo::new().decide(edits, None);
    assert!(!stderr.contains("could not analyze"), "{stderr}");
    decision
}

/// Reuse setup within one test, but give every path the same clean base.
fn assert_each_change_selects(workflow: &str, paths: &[&str], contents: &str) {
    let repo = Repo::new();
    let base = repo.base();
    for path in paths {
        // Earlier triggering edits must not make a later case pass by accident.
        succeed(repo.0.path(), "git", &["reset", "--hard", &base]);
        let (decision, stderr) = repo.decide_for(workflow, &[(path, Some(contents))], Some(&base));
        assert!(!stderr.contains("could not analyze"), "{path}: {stderr}");
        assert_eq!(
            succeed(
                repo.0.path(),
                "git",
                &["diff", "--name-only", &base, "HEAD"]
            )
            .trim(),
            *path,
            "each case must compare only its own edit"
        );
        assert_eq!(decision, format!("{workflow}=true"), "{path}");
    }
}

#[test]
fn documentation_runtimes_and_other_workflows_do_not_rebuild_images() {
    let decision = images(&[
        ("docs/guide.md", Some("# Changed\n")),
        ("image/vllm/Dockerfile", Some("FROM changed\n")),
        (".github/workflows/rust.yml", Some("name: changed\n")),
    ]);
    assert_eq!(decision, "images=false");
}

#[test]
fn sdk_changes_reach_the_build_tool_only_through_its_disabled_default_feature() {
    let decision = images(&[
        (
            "crates/nemoclaw-sdk/src/lib.rs",
            Some("pub fn changed() {}\n"),
        ),
        ("crates/nemoclaw-sdk/src/extra.rs", None),
        (
            "crates/nemoclaw-e2e/src/lib.rs",
            Some("pub fn changed() {}\n"),
        ),
    ]);
    assert_eq!(decision, "images=false");
}

#[test]
fn crates_in_the_image_build_rebuild_images() {
    assert_each_change_selects(
        "images",
        &[
            "crates/nemoclaw-runtime/src/lib.rs",
            "crates/nemoclaw-build/src/lib.rs",
            "crates/nemoclaw-ollama-proxy/src/lib.rs",
        ],
        "pub fn changed() {}\n",
    );
}

#[test]
fn image_inputs_outside_crates_rebuild_images() {
    assert_each_change_selects(
        "images",
        &[
            "image/fabric/Dockerfile",
            "docker-bake.hcl",
            ".dockerignore",
            "ruff.toml",
            "LICENSE",
            "rust-toolchain.toml",
            ".github/workflows/images.yml",
        ],
        "# changed\n",
    );
}

#[test]
fn unclassified_files_rebuild_images() {
    assert_eq!(images(&[("Makefile", Some("all:\n"))]), "images=true");
}

#[test]
fn an_unanalyzable_change_runs_the_image_checks() {
    let (decision, stderr) = Repo::new().decide(
        &[("docs/guide.md", Some("# Changed\n"))],
        Some("0000000000000000000000000000000000000000"),
    );
    assert_eq!(decision, "images=true");
    assert!(stderr.contains("running the image checks"), "{stderr}");
}

fn live(edits: &[(&str, Option<&str>)]) -> String {
    let (decision, stderr) = Repo::new().decide_for("live", edits, None);
    assert!(!stderr.contains("could not analyze"), "{stderr}");
    decision
}

#[test]
fn documentation_other_workflows_and_packages_outside_the_live_build_skip_live_suites() {
    let decision = live(&[
        ("docs/guide.md", Some("# Changed\n")),
        (".github/workflows/images.yml", Some("name: changed\n")),
        (
            "crates/nemoclaw-onboarding/src/lib.rs",
            Some("pub fn changed() {}\n"),
        ),
    ]);
    assert_eq!(decision, "live=false");
}

#[test]
fn live_build_packages_and_their_inputs_run_live_suites() {
    assert_each_change_selects(
        "live",
        &[
            "crates/nemoclaw-sdk/src/lib.rs",
            "crates/nemoclaw-runtime/src/lib.rs",
            "crates/nemoclaw-e2e/src/lib.rs",
            "crates/nemoclaw-build/src/lib.rs",
            "crates/nemoclaw-cli/src/lib.rs",
            "crates/openshell-provider/src/lib.rs",
            "image/vllm/Dockerfile",
            "image/fabric/Dockerfile",
            "examples/local.yaml",
            "versions.json",
            ".config/nextest.toml",
            ".github/workflows/bundle-platform.yml",
            ".github/workflows/rust.yml",
            "Makefile",
        ],
        "# changed\n",
    );
}

impl Repo {
    fn plan(&self, base: &str, worktree: bool) -> serde_json::Value {
        let mut command = Command::new(env!("CARGO_BIN_EXE_nemoclaw-build"));
        command.args(["changes", "plan", "--base", base]);
        if worktree {
            command.arg("--worktree");
        }
        let output = command
            .current_dir(self.0.path())
            .env("CARGO", cargo())
            .env("CARGO_NET_OFFLINE", "true")
            .env("HOME", self.0.path())
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        serde_json::from_slice(&output.stdout).unwrap()
    }
}

#[test]
fn documentation_changes_skip_bundle_lifecycle_images_and_live_work() {
    let repo = Repo::new();
    let base = repo.base();
    repo.decide(&[("docs/guide.md", Some("# Changed\n"))], None);
    let plan = repo.plan(&base, false);
    for step in ["bundle", "lifecycle", "images", "live"] {
        assert_eq!(plan[step]["run"], false, "{step}: {plan}");
        assert!(
            !plan[step]["reason"]
                .as_str()
                .unwrap()
                .contains("could not analyze")
        );
    }
}

#[test]
fn local_preview_skips_expensive_steps_without_installing_tools() {
    let repo = Repo::new();
    write(repo.0.path(), "docs/guide.md", "# Local edits\n");
    let output = Command::new(env!("CARGO_BIN_EXE_nemoclaw-build"))
        .args(["ci", "--base", "HEAD", "--dry-run"])
        .current_dir(repo.0.path())
        .env("CARGO", cargo())
        .env("CARGO_NET_OFFLINE", "true")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let preview: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    let steps = preview["steps"].as_array().unwrap();
    assert!(steps.iter().any(|step| step == "test"), "{preview}");
    assert!(
        !steps
            .iter()
            .any(|step| step == "bundle" || step == "lifecycle"),
        "{preview}"
    );
    assert!(!repo.0.path().join(".tools").exists());
}

fn no_fallback(plan: &serde_json::Value) {
    for step in ["bundle", "lifecycle", "images", "live"] {
        assert!(
            !plan[step]["reason"]
                .as_str()
                .unwrap()
                .contains("could not analyze"),
            "{plan}"
        );
    }
}

#[test]
fn local_plans_include_staged_unstaged_and_untracked_runtime_inputs() {
    for state in ["staged", "unstaged", "untracked"] {
        let repo = Repo::new();
        let path = if state == "untracked" {
            "crates/nemoclaw-sdk/src/new.rs"
        } else {
            "crates/nemoclaw-sdk/src/lib.rs"
        };
        write(repo.0.path(), path, "pub fn changed() {}\n");
        if state == "staged" {
            succeed(repo.0.path(), "git", &["add", path]);
        }
        let plan = repo.plan("HEAD", true);
        no_fallback(&plan);
        for step in ["bundle", "lifecycle", "live"] {
            assert_eq!(plan[step]["run"], true, "{state}: {plan}");
        }
        assert_eq!(plan["images"]["run"], false, "{state}: {plan}");
    }
}

#[test]
fn packages_outside_lifecycle_still_rebuild_the_bundled_source_archive() {
    let repo = Repo::new();
    write(
        repo.0.path(),
        "crates/nemoclaw-onboarding/src/lib.rs",
        "pub fn changed() {}\n",
    );
    let plan = repo.plan("HEAD", true);
    no_fallback(&plan);
    assert_eq!(plan["bundle"]["run"], true, "{plan}");
    assert_eq!(plan["lifecycle"]["run"], false, "{plan}");
}

#[test]
fn unknown_inputs_and_missing_bases_select_all_expensive_checks() {
    let repo = Repo::new();
    write(repo.0.path(), "Makefile", "all:\n");
    let unknown = repo.plan("HEAD", true);
    no_fallback(&unknown);
    let missing = repo.plan("not-a-revision", true);
    for plan in [&unknown, &missing] {
        for step in ["bundle", "lifecycle", "images", "live"] {
            assert_eq!(plan[step]["run"], true, "{plan}");
        }
    }
    assert!(
        missing["bundle"]["reason"]
            .as_str()
            .unwrap()
            .contains("could not analyze")
    );
}

#[test]
fn committed_plans_refuse_to_skip_work_from_a_dirty_checkout() {
    let repo = Repo::new();
    write(
        repo.0.path(),
        "crates/nemoclaw-sdk/src/lib.rs",
        "pub fn changed() {}\n",
    );
    let plan = repo.plan("HEAD", false);
    for step in ["bundle", "lifecycle", "images", "live"] {
        assert_eq!(plan[step]["run"], true, "{plan}");
        assert!(
            plan[step]["reason"]
                .as_str()
                .unwrap()
                .contains("clean checkout"),
            "{plan}"
        );
    }
}

#[test]
fn moved_runtime_files_keep_their_old_consumers_selected() {
    let repo = Repo::new();
    fs::rename(
        repo.0.path().join("crates/nemoclaw-sdk/src/extra.rs"),
        repo.0.path().join("docs/extra.rs"),
    )
    .unwrap();
    let plan = repo.plan("HEAD", true);
    no_fallback(&plan);
    assert_eq!(plan["lifecycle"]["run"], true, "{plan}");
}

#[test]
fn changing_selection_rules_exercises_all_suites() {
    let repo = Repo::new();
    write(
        repo.0.path(),
        ".config/determinator-bundle.toml",
        &format!("{BUNDLE_RULES}\n# changed\n"),
    );
    let plan = repo.plan("HEAD", true);
    no_fallback(&plan);
    for step in ["bundle", "lifecycle", "images", "live"] {
        assert_eq!(plan[step]["run"], true, "{step}: {plan}");
    }
}

#[test]
fn lockfile_only_git_dependency_updates_select_their_consumers() {
    let dependency = tempfile::tempdir().unwrap();
    write(
        dependency.path(),
        "Cargo.toml",
        &manifest("plan-dependency", ""),
    );
    write(
        dependency.path(),
        "src/lib.rs",
        "pub fn version() -> u8 { 1 }\n",
    );
    succeed(dependency.path(), "git", &["init", "-q"]);
    succeed(dependency.path(), "git", &["add", "-A"]);
    succeed(dependency.path(), "git", &["commit", "-q", "-m", "first"]);
    let repo = Repo::new();
    // Cargo fetches only this local file URL. Keep its cache outside Git inputs.
    write(repo.0.path(), ".gitignore", ".cargo/\n");
    write(
        repo.0.path(),
        "crates/nemoclaw-sdk/Cargo.toml",
        &manifest(
            "nemoclaw-sdk",
            &format!(
                "plan-dependency = {{ git = \"file://{}\" }}\n",
                dependency.path().display()
            ),
        ),
    );
    succeed(repo.0.path(), &cargo(), &["generate-lockfile"]);
    succeed(repo.0.path(), "git", &["add", "-A"]);
    succeed(repo.0.path(), "git", &["commit", "-q", "-m", "dependency"]);
    let base = repo.base();
    write(
        dependency.path(),
        "src/lib.rs",
        "pub fn version() -> u8 { 2 }\n",
    );
    succeed(dependency.path(), "git", &["add", "-A"]);
    succeed(dependency.path(), "git", &["commit", "-q", "-m", "second"]);
    succeed(
        repo.0.path(),
        &cargo(),
        &["update", "-p", "plan-dependency"],
    );
    succeed(repo.0.path(), "git", &["add", "Cargo.lock"]);
    succeed(
        repo.0.path(),
        "git",
        &["commit", "-q", "-m", "update lockfile"],
    );
    assert_eq!(
        succeed(
            repo.0.path(),
            "git",
            &["diff", "--name-only", &base, "HEAD"]
        )
        .trim(),
        "Cargo.lock"
    );
    let plan = repo.plan(&base, false);
    no_fallback(&plan);
    assert_eq!(plan["images"]["run"], false, "{plan}");
    assert_eq!(plan["bundle"]["run"], true, "{plan}");
    for step in ["lifecycle", "live"] {
        assert_eq!(plan[step]["run"], true, "{plan}");
        assert!(
            plan[step]["reason"]
                .as_str()
                .unwrap()
                .contains("dependencies or features changed"),
            "{plan}"
        );
    }
}

#[test]
fn enabling_a_dependency_feature_changes_image_selection() {
    let repo = Repo::new();
    let base = repo.base();
    // The SDK is not in the image build until the build tool's disabled feature
    // is enabled by the proxy's normal dependency edge.
    let proxy = manifest(
        "nemoclaw-ollama-proxy",
        "nemoclaw-runtime = { path = \"../nemoclaw-runtime\" }\nnemoclaw-build = { path = \"../nemoclaw-build\" }\n",
    );
    write(
        repo.0.path(),
        "crates/nemoclaw-ollama-proxy/Cargo.toml",
        &proxy,
    );
    succeed(repo.0.path(), &cargo(), &["generate-lockfile", "--offline"]);
    succeed(repo.0.path(), "git", &["add", "-A"]);
    succeed(repo.0.path(), "git", &["commit", "-q", "-m", "enable sdk"]);
    let enabled = repo.plan(&base, false);
    no_fallback(&enabled);
    assert_eq!(enabled["images"]["run"], true, "{enabled}");
    let base = repo.base();
    repo.decide(
        &[(
            "crates/nemoclaw-sdk/src/lib.rs",
            Some("pub fn changed() {}\n"),
        )],
        None,
    );
    let changed = repo.plan(&base, false);
    no_fallback(&changed);
    assert_eq!(changed["images"]["run"], true, "{changed}");
}

#[test]
fn local_execution_skips_bundle_and_lifecycle_but_keeps_ordinary_checks() {
    use std::os::unix::fs::PermissionsExt;
    let repo = Repo::new();
    let tools = tempfile::tempdir().unwrap();
    for (name, script) in [
        ("protoc", "#!/bin/sh\necho 'libprotoc 36.2'\n"),
        (
            "cargo",
            r#"#!/bin/sh
if [ "$1" = metadata ]; then exec "$REAL_CARGO" "$@"; fi
if [ "$1 $2" = 'nextest --version' ]; then echo 'cargo-nextest 0.9.150'; exit 0; fi
printf '%s\n' "$*" >> "$CHECK_LOG"
if [ "$1" = build ]; then
  mkdir -p target/debug
  printf '#!/bin/sh\n[ "$1 $2" = "schema --check" ]\n' > target/debug/nemoclaw-build
  chmod +x target/debug/nemoclaw-build
fi
if [ "$1" = nextest ]; then
  case "$*" in *lifecycle*) exit 91 ;; esac
fi
"#,
        ),
    ] {
        let path = tools.path().join(name);
        fs::write(&path, script).unwrap();
        fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
    }
    write(
        repo.0.path(),
        "versions.json",
        include_str!("../../../versions.json"),
    );
    write(repo.0.path(), ".gitignore", "target/\n");
    succeed(repo.0.path(), "git", &["add", "-A"]);
    succeed(repo.0.path(), "git", &["commit", "-q", "-m", "tools"]);
    write(repo.0.path(), "docs/guide.md", "# Changed\n");
    let log = tools.path().join("checks.log");
    let output = Command::new(env!("CARGO_BIN_EXE_nemoclaw-build"))
        .args(["ci", "--base", "HEAD"])
        .current_dir(repo.0.path())
        .env("CARGO", tools.path().join("cargo"))
        .env("REAL_CARGO", cargo())
        .env("PROTOC", tools.path().join("protoc"))
        .env(
            "PATH",
            std::env::join_paths(
                std::iter::once(tools.path().to_path_buf())
                    .chain(std::env::split_paths(&std::env::var_os("PATH").unwrap())),
            )
            .unwrap(),
        )
        .env("CHECK_LOG", &log)
        .env("CARGO_NET_OFFLINE", "true")
        .env_remove("GITHUB_ENV")
        .env_remove("GITHUB_PATH")
        .env_remove("GITHUB_STEP_SUMMARY")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let log = fs::read_to_string(log).unwrap();
    assert!(log.contains("fmt --check"), "{log}");
    assert!(log.contains("clippy"), "{log}");
    assert!(log.contains("nextest run"), "{log}");
    assert!(log.contains("--doc"), "{log}");
    assert!(!log.contains("lifecycle"), "{log}");
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("bundle: skip") && stderr.contains("lifecycle: skip"),
        "{stderr}"
    );
}

#[test]
fn lockfile_content_changes_rebuild_the_retained_source_even_without_dependency_changes() {
    let repo = Repo::new();
    let lockfile = fs::read_to_string(repo.0.path().join("Cargo.lock")).unwrap();
    write(
        repo.0.path(),
        "Cargo.lock",
        &format!("{lockfile}\n# changed\n"),
    );
    let plan = repo.plan("HEAD", true);
    no_fallback(&plan);
    assert_eq!(plan["bundle"]["run"], true, "{plan}");
    assert_eq!(plan["lifecycle"]["run"], false, "{plan}");
}

#[test]
fn default_ci_selects_changes_against_origin_v1() {
    let repo = Repo::new();
    succeed(
        repo.0.path(),
        "git",
        &["update-ref", "refs/remotes/origin/v1", "HEAD"],
    );
    succeed(repo.0.path(), "git", &["checkout", "--detach", "-q"]);
    write(repo.0.path(), "docs/guide.md", "# Changed\n");
    let output = run(
        repo.0.path(),
        env!("CARGO_BIN_EXE_nemoclaw-build"),
        &["ci", "--dry-run"],
    );
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let preview: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    no_fallback(&preview["plan"]);
    assert_eq!(preview["plan"]["bundle"]["run"], false, "{preview}");
    assert_eq!(preview["plan"]["lifecycle"]["run"], false, "{preview}");
    assert!(String::from_utf8_lossy(&output.stderr).contains("origin/v1"));
}

fn preview_with_pr(
    repo: &Repo,
    response: serde_json::Value,
    args: &[&str],
) -> (std::process::Output, bool) {
    use std::os::unix::fs::PermissionsExt;
    let tools = tempfile::tempdir().unwrap();
    let gh = tools.path().join("gh");
    fs::write(&gh, "#!/bin/sh\ntouch \"$PR_CALL\"\ncat \"$PR_RESPONSE\"\n").unwrap();
    fs::set_permissions(gh, fs::Permissions::from_mode(0o755)).unwrap();
    let response_file = tools.path().join("response.json");
    fs::write(&response_file, serde_json::to_vec(&response).unwrap()).unwrap();
    let call = tools.path().join("called");
    let output = Command::new(env!("CARGO_BIN_EXE_nemoclaw-build"))
        .args(args)
        .current_dir(repo.0.path())
        .env("CARGO", cargo())
        .env("CARGO_NET_OFFLINE", "true")
        .env("PR_RESPONSE", response_file)
        .env("PR_CALL", &call)
        .env(
            "PATH",
            std::env::join_paths(
                std::iter::once(tools.path().to_path_buf())
                    .chain(std::env::split_paths(&std::env::var_os("PATH").unwrap())),
            )
            .unwrap(),
        )
        .output()
        .unwrap();
    (output, call.exists())
}

#[test]
fn default_ci_uses_the_open_pr_parent_for_a_stack() {
    let repo = Repo::new();
    succeed(
        repo.0.path(),
        "git",
        &["update-ref", "refs/remotes/origin/v1", "HEAD"],
    );
    repo.decide(
        &[(
            "crates/nemoclaw-sdk/src/lib.rs",
            Some("// Parent changes\n"),
        )],
        None,
    );
    let parent = repo.base();
    succeed(
        repo.0.path(),
        "git",
        &["checkout", "-q", "-b", "stack-child"],
    );
    write(repo.0.path(), "docs/guide.md", "# Child edits\n");
    let (output, called) = preview_with_pr(
        &repo,
        serde_json::json!({"state":"OPEN", "baseRefName":"stack-parent", "baseRefOid":parent}),
        &["ci", "--dry-run"],
    );
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let preview: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    no_fallback(&preview["plan"]);
    assert_eq!(preview["plan"]["lifecycle"]["run"], false, "{preview}");
    assert_eq!(preview["plan"]["bundle"]["run"], false, "{preview}");
    assert!(called);
    assert!(String::from_utf8_lossy(&output.stderr).contains("stack-parent"));
}

#[test]
fn full_ci_explicitly_selects_every_step_without_pr_discovery() {
    let repo = Repo::new();
    let (output, called) = preview_with_pr(
        &repo,
        serde_json::Value::Null,
        &["ci", "--full", "--dry-run"],
    );
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let preview: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(
        preview["steps"],
        serde_json::json!([
            "tools",
            "fmt",
            "clippy",
            "build",
            "test",
            "schema",
            "bundle",
            "lifecycle"
        ])
    );
    assert!(!called);
}

#[test]
fn missing_default_base_requires_a_choice_instead_of_accidentally_running_everything() {
    let repo = Repo::new();
    succeed(repo.0.path(), "git", &["checkout", "--detach", "-q"]);
    let output = run(
        repo.0.path(),
        env!("CARGO_BIN_EXE_nemoclaw-build"),
        &["ci", "--dry-run"],
    );
    assert!(
        !output.status.success(),
        "missing default must not silently select all checks"
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("origin/v1") && stderr.contains("--base") && stderr.contains("--full"),
        "{stderr}"
    );
}

#[test]
fn unavailable_or_closed_pr_metadata_falls_back_to_origin_v1() {
    let repo = Repo::new();
    succeed(
        repo.0.path(),
        "git",
        &["update-ref", "refs/remotes/origin/v1", "HEAD"],
    );
    write(repo.0.path(), "docs/guide.md", "# Changed\n");
    for response in [
        serde_json::Value::Null,
        serde_json::json!({"state":"CLOSED", "baseRefName":"old-parent", "baseRefOid":repo.base()}),
        serde_json::json!({"state":"MERGED", "baseRefName":"old-parent", "baseRefOid":repo.base()}),
        serde_json::json!({"state":"OPEN", "baseRefName":"unfetched-parent", "baseRefOid":"a".repeat(40)}),
        serde_json::json!({"state":"OPEN", "baseRefName":"invalid-parent", "baseRefOid":"HEAD"}),
    ] {
        let (output, called) = preview_with_pr(&repo, response, &["ci", "--dry-run"]);
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(called);
        let preview: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
        no_fallback(&preview["plan"]);
        assert_eq!(preview["plan"]["bundle"]["run"], false, "{preview}");
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(
            stderr.contains("origin/v1") && stderr.contains("fallback"),
            "{stderr}"
        );
    }
}

#[test]
fn explicit_base_bypasses_pr_discovery() {
    let repo = Repo::new();
    write(repo.0.path(), "docs/guide.md", "# Changed\n");
    let (output, called) = preview_with_pr(
        &repo,
        serde_json::Value::Null,
        &["ci", "--base", "HEAD", "--dry-run"],
    );
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(!called);
    let preview: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    no_fallback(&preview["plan"]);
    assert_eq!(preview["plan"]["bundle"]["run"], false, "{preview}");
}

/// The references `v1` pushes for `commit` that the live suites pull: the
/// agent, the reference image, and the proxy, on both Linux architectures.
fn pushed(commit: &str) -> Vec<String> {
    ["openclaw", "hermes", "dummy", "ollama-proxy"]
        .iter()
        .flat_map(|name| {
            ["arm64", "amd64"]
                .map(|arch| format!("ghcr.io/nvidia/nemoclaw/v1-ci:{name}-{commit}-{arch}"))
        })
        .collect()
}

impl Repo {
    /// Commit the edits and return the new commit.
    fn commit(&self, edits: &[(&str, Option<&str>)]) -> String {
        for (path, contents) in edits {
            match contents {
                Some(contents) => write(self.0.path(), path, contents),
                None => fs::remove_file(self.0.path().join(path)).unwrap(),
            }
        }
        succeed(self.0.path(), "git", &["add", "-A"]);
        succeed(self.0.path(), "git", &["commit", "-q", "-m", "change"]);
        self.base()
    }

    /// Ask which `v1` commit's images the live suites can pull, with a fake
    /// `docker` that finds only the `pushed` references.
    fn live_images(&self, base: &str, pushed: &[String]) -> (String, String) {
        use std::os::unix::fs::PermissionsExt;
        let tools = tempfile::tempdir().unwrap();
        let list = tools.path().join("pushed");
        fs::write(&list, pushed.join("\n") + "\n").unwrap();
        let docker = tools.path().join("docker");
        fs::write(
            &docker,
            "#!/bin/sh\n[ \"$1 $2 $3\" = 'buildx imagetools inspect' ] || exit 2\ngrep -qxF \"$4\" \"$PUSHED\" && exit 0\necho \"ERROR: $4: not found\" >&2\nexit 1\n",
        )
        .unwrap();
        fs::set_permissions(&docker, fs::Permissions::from_mode(0o755)).unwrap();
        let path = format!(
            "{}:{}",
            tools.path().display(),
            std::env::var("PATH").unwrap_or_default()
        );
        let output = Command::new(env!("CARGO_BIN_EXE_nemoclaw-build"))
            .args(["changes", "live-images", "--base", base])
            .current_dir(self.0.path())
            .env("CARGO", cargo())
            .env("CARGO_NET_OFFLINE", "true")
            .env("HOME", self.0.path())
            .env("PATH", path)
            .env("PUSHED", &list)
            .output()
            .unwrap();
        let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
        assert!(output.status.success(), "{stderr}");
        (
            String::from_utf8(output.stdout).unwrap().trim().to_owned(),
            stderr,
        )
    }
}

#[cfg(unix)]
#[test]
fn live_suites_pull_a_v1_commits_images_when_no_image_input_changed_since() {
    let repo = Repo::new();
    let pushed_commit = repo.base();
    // v1 moves on without pushing images, as after a documentation change.
    let base = repo.commit(&[("docs/guide.md", Some("# v1\n"))]);
    repo.commit(&[("docs/other.md", Some("# change\n"))]);
    let (decision, stderr) = repo.live_images(&base, &pushed(&pushed_commit));
    assert_eq!(decision, format!("live-images={pushed_commit}"), "{stderr}");
}

#[cfg(unix)]
#[test]
fn live_suites_build_their_images_when_an_image_input_changed_since_the_pushed_commit() {
    let repo = Repo::new();
    let pushed_commit = repo.base();
    // Also the case where v1 changed an image input but a later push
    // cancelled that commit's image run.
    let base = repo.commit(&[("image/fabric/Dockerfile", Some("# changed\n"))]);
    repo.commit(&[("docs/other.md", Some("# change\n"))]);
    let (decision, stderr) = repo.live_images(&base, &pushed(&pushed_commit));
    assert_eq!(decision, "live-images=", "{stderr}");
}

#[cfg(unix)]
#[test]
fn live_suites_build_their_images_when_no_recent_commit_pushed_all_of_them() {
    let repo = Repo::new();
    let pushed_commit = repo.base();
    repo.commit(&[("docs/other.md", Some("# change\n"))]);
    let missing = format!("ghcr.io/nvidia/nemoclaw/v1-ci:dummy-{pushed_commit}-amd64");
    let mut references = pushed(&pushed_commit);
    references.retain(|reference| *reference != missing);
    let (decision, stderr) = repo.live_images(&pushed_commit, &references);
    assert_eq!(decision, "live-images=", "{stderr}");
}
