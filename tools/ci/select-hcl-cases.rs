// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Select existing live HCL cases without dispatching jobs.
use std::{collections::BTreeSet, process::Command};

const MAP: &str = ".config/hcl-case-changes.tsv";
const CASES: &str = "crates/nemoclaw-e2e/cases/";
const TESTS: &str = "crates/nemoclaw-e2e/tests/e2e/hcl/tests/";
type Result<T> = std::result::Result<T, String>;

fn catalog(files: &[&str]) -> BTreeSet<String> {
    files
        .iter()
        .filter_map(|file| {
            let id = file.strip_prefix(TESTS)?.strip_suffix(".tftest.hcl")?;
            files
                .contains(&format!("{CASES}{id}.yaml").as_str())
                .then(|| id.to_owned())
        })
        .collect()
}

fn select(
    map: &str,
    known: &BTreeSet<String>,
    paths: &[&str],
    recommended: &[&str],
) -> Result<BTreeSet<String>> {
    let valid_path = |path: &str| {
        !path.is_empty()
            && !path.contains(['\\', ':'])
            && !path.chars().any(char::is_control)
            && path.split('/').all(|part| !matches!(part, "" | "." | ".."))
    };
    if paths.iter().any(|path| !valid_path(path)) {
        return Err("changed paths must be normalized repository-relative paths".into());
    }
    let valid_id = |id: &str| {
        !id.is_empty()
            && id
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
            && known.contains(id)
    };
    let mut selected = BTreeSet::new();
    let mut rules = 0;
    for line in map
        .lines()
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
    {
        let fields: Vec<&str> = line.split('\t').collect();
        if fields.len() < 2
            || !valid_path(fields[0].strip_suffix('/').unwrap_or(fields[0]))
            || fields[1..].iter().any(|id| !valid_id(id))
        {
            return Err(format!("invalid change-map row: {line:?}"));
        }
        rules += 1;
        if paths.iter().any(|path| {
            *path == fields[0] || (fields[0].ends_with('/') && path.starts_with(fields[0]))
        }) {
            selected.extend(fields[1..].iter().map(|id| (*id).to_owned()));
        }
    }
    if rules == 0 {
        return Err("change map contains no rules".into());
    }
    for id in recommended {
        if !valid_id(id) {
            return Err(format!("unknown recommended live HCL case: {id:?}"));
        }
        selected.insert((*id).to_owned());
    }
    Ok(selected)
}

fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}

fn git(args: &[&str]) -> Result<String> {
    let output = Command::new("git")
        .args(args)
        .output()
        .map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_owned());
    }
    String::from_utf8(output.stdout).map_err(|_| "Git output is not UTF-8".into())
}

fn run() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.len() < 2 {
        return Err("usage: select-hcl-cases BASE EXACT_COMMIT [RECOMMENDED_CASE ...] (run at repository root)".into());
    }
    let commit = &args[1];
    if !exact_commit(commit) {
        return Err("EXACT_COMMIT must be a full 40-character commit ID".into());
    }
    let resolved = git(&["rev-parse", "--verify", &format!("{commit}^{{commit}}")])?;
    if resolved.trim() != commit {
        return Err("EXACT_COMMIT must name the commit itself".into());
    }
    let base = git(&[
        "rev-parse",
        "--verify",
        "--end-of-options",
        &format!("{}^{{commit}}", args[0]),
    ])?;
    let files = git(&["ls-tree", "-rz", "--name-only", commit])?;
    let files: Vec<&str> = files.split_terminator('\0').collect();
    let known = catalog(&files);
    let map = git(&["show", &format!("{commit}:{MAP}")])?;
    let changed = git(&[
        "diff",
        "--name-only",
        "--no-renames",
        "-z",
        base.trim(),
        commit,
        "--",
    ])?;
    let paths: Vec<&str> = changed.split_terminator('\0').collect();
    let recommended: Vec<&str> = args[2..].iter().map(String::as_str).collect();
    let selected = select(&map, &known, &paths, &recommended)?;
    // IDs come only from the validated catalog, so these JSON strings need no escaping.
    let ids: Vec<String> = selected.iter().map(|id| format!("\"{id}\"")).collect();
    println!(
        "{{\"commit\":\"{commit}\",\"case_ids\":[{}]}}",
        ids.join(",")
    );
    Ok(())
}

fn exact_commit(commit: &str) -> bool {
    commit.len() == 40
        && commit
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

#[cfg(test)]
mod tests {
    use super::*;
    const MAPPING: &str = include_str!("../../.config/hcl-case-changes.tsv");
    fn known() -> BTreeSet<String> {
        catalog(&[
            "crates/nemoclaw-e2e/cases/docker-openclaw-nvidia.yaml",
            "crates/nemoclaw-e2e/cases/docker-openclaw-vllm.yaml",
            "crates/nemoclaw-e2e/tests/e2e/hcl/tests/docker-openclaw-nvidia.tftest.hcl",
            "crates/nemoclaw-e2e/tests/e2e/hcl/tests/docker-openclaw-vllm.tftest.hcl",
        ])
    }
    #[test]
    fn shared_paths_select_both_cases() {
        assert_eq!(
            select(MAPPING, &known(), &["crates/nemoclaw-sdk/src/lib.rs"], &[]).unwrap(),
            known()
        );
    }
    #[test]
    fn shared_build_and_live_support_inputs_select_both() {
        for path in [
            "versions.json",
            "crates/nemoclaw-build/src/images.rs",
            "examples/docker/example.yaml",
            "schemas/nemoclaw.json",
            ".github/actions/example/action.yml",
            ".config/determinator-live.toml",
            ".github/workflows/bundle-platform.yml",
            "crates/nemoclaw-test-fixtures/src/lib.rs",
            "crates/nemoclaw-e2e/Cargo.toml",
            "docker-bake.hcl",
            ".dockerignore",
        ] {
            assert_eq!(
                select(MAPPING, &known(), &[path], &[]).unwrap(),
                known(),
                "{path}"
            );
        }
    }
    #[test]
    fn local_runtime_and_image_inputs_select_only_vllm() {
        for path in [
            "crates/nemoclaw-runtime/src/lib.rs",
            "image/vllm/Dockerfile",
            "image/supervisor/Dockerfile",
        ] {
            assert_eq!(
                select(MAPPING, &known(), &[path], &[]).unwrap(),
                BTreeSet::from(["docker-openclaw-vllm".into()]),
                "{path}"
            );
        }
    }
    #[test]
    fn unrelated_changes_select_none() {
        assert!(
            select(MAPPING, &known(), &["WRITING.md"], &[])
                .unwrap()
                .is_empty()
        );
    }
    #[test]
    fn case_specific_paths_and_recommendations_are_additive() {
        let path = "crates/nemoclaw-e2e/cases/docker-openclaw-vllm.yaml";
        assert_eq!(
            select(MAPPING, &known(), &[path], &[]).unwrap(),
            BTreeSet::from(["docker-openclaw-vllm".into()])
        );
        assert_eq!(
            select(
                MAPPING,
                &known(),
                &[path, path],
                &["docker-openclaw-nvidia", "docker-openclaw-nvidia"]
            )
            .unwrap(),
            known()
        );
    }
    #[test]
    fn invalid_paths_ids_and_mapping_fail() {
        for path in [
            "",
            "/tmp/file",
            "../file",
            "crates/../file",
            "a\\b",
            "a//b",
            "./file",
            "a\nfile",
        ] {
            assert!(select(MAPPING, &known(), &[path], &[]).is_err(), "{path:?}");
        }
        assert!(select(MAPPING, &known(), &[], &["not-a-case"]).is_err());
        for map in [
            "path",
            "path\tmissing",
            "../\tdocker-openclaw-vllm",
            "path\tdocker-openclaw-vllm\textra",
        ] {
            assert!(select(map, &known(), &[], &[]).is_err(), "{map:?}");
        }
    }
    #[test]
    fn catalog_requires_both_live_scenario_and_yaml() {
        assert!(catalog(&["crates/nemoclaw-e2e/cases/docker-openclaw-vllm.yaml"]).is_empty());
        assert!(
            catalog(&["crates/nemoclaw-e2e/tests/e2e/hcl/tests/docker-openclaw-vllm.tftest.hcl"])
                .is_empty()
        );
    }
    #[test]
    fn checked_in_map_names_only_existing_live_cases() {
        let root = std::path::Path::new(".");
        let mut files = Vec::new();
        for directory in [CASES, TESTS] {
            for entry in std::fs::read_dir(root.join(directory)).unwrap() {
                files.push(format!(
                    "{directory}{}",
                    entry.unwrap().file_name().to_str().unwrap()
                ));
            }
        }
        let files: Vec<&str> = files.iter().map(String::as_str).collect();
        assert_eq!(
            select(
                MAPPING,
                &catalog(&files),
                &[".config/hcl-case-changes.tsv"],
                &[]
            )
            .unwrap(),
            known()
        );
        for line in MAPPING
            .lines()
            .filter(|line| !line.starts_with('#') && !line.is_empty())
        {
            let path = line.split('\t').next().unwrap();
            assert!(
                root.join(path).exists(),
                "mapped path does not exist: {path}"
            );
        }
    }
    #[test]
    fn directory_prefixes_do_not_match_neighbor_names() {
        assert!(
            select(
                MAPPING,
                &known(),
                &["crates/nemoclaw-sdk-extra/src/lib.rs"],
                &[]
            )
            .unwrap()
            .is_empty()
        );
        assert_eq!(
            select(MAPPING, &known(), &[], &["docker-openclaw-vllm"]).unwrap(),
            BTreeSet::from(["docker-openclaw-vllm".into()])
        );
        assert!(select("# empty", &known(), &[], &[]).is_err());
    }
    #[test]
    fn commit_identity_rejects_refs_abbreviations_and_options() {
        assert!(exact_commit("86b8d94273a76a696e06b300dc29f7035b163667"));
        for commit in [
            "",
            "HEAD",
            "86b8d94273",
            "--help",
            "86b8d94273a76a696e06b300dc29f7035b16366g",
        ] {
            assert!(!exact_commit(commit), "{commit}");
        }
    }

    #[test]
    fn executable_reads_exact_commit_map_catalog_and_diff() {
        let root = std::env::temp_dir().join(format!(
            "nemoclaw-13939-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&root).unwrap();
        struct Cleanup(std::path::PathBuf);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
        let _cleanup = Cleanup(root.clone());
        let executable = root.join("selector");
        assert!(
            Command::new("rustc")
                .args(["--edition=2024", "tools/ci/select-hcl-cases.rs", "-o"])
                .arg(&executable)
                .status()
                .unwrap()
                .success()
        );
        let git = |args: &[&str]| {
            let output = Command::new("git")
                .current_dir(&root)
                .args([
                    "-c",
                    "user.name=Selector Test",
                    "-c",
                    "user.email=selector@example.invalid",
                    "-c",
                    "commit.gpgsign=false",
                    "-c",
                    "core.hooksPath=/dev/null",
                ])
                .args(args)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            String::from_utf8(output.stdout).unwrap().trim().to_owned()
        };
        git(&["init", "-q"]);
        let write = |path: &str, text: &str| {
            let path = root.join(path);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, text).unwrap();
        };
        write(MAP, MAPPING);
        for id in known() {
            write(&format!("{CASES}{id}.yaml"), "fixture");
            write(&format!("{TESTS}{id}.tftest.hcl"), "fixture");
        }
        git(&["add", ".config", "crates"]);
        git(&["commit", "-qm", "base fixture"]);
        let base = git(&["rev-parse", "HEAD"]);
        write("crates/nemoclaw-runtime/src/lib.rs", "changed");
        git(&["add", "crates"]);
        git(&["commit", "-qm", "runtime fixture"]);
        let commit = git(&["rev-parse", "HEAD"]);
        // Dirty local rules cannot alter an exact-commit result.
        write(MAP, "invalid working tree map");
        let invoke_between = |from: &str, candidate: &str, recommendations: &[&str]| {
            Command::new(&executable)
                .current_dir(&root)
                .args([from, candidate])
                .args(recommendations)
                .output()
                .unwrap()
        };
        let invoke = |candidate: &str, recommendations: &[&str]| {
            invoke_between(&base, candidate, recommendations)
        };
        let output = invoke(&commit, &[]);
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(
            String::from_utf8(output.stdout).unwrap(),
            format!("{{\"commit\":\"{commit}\",\"case_ids\":[\"docker-openclaw-vllm\"]}}\n")
        );
        let output = invoke(&commit, &["docker-openclaw-nvidia"]);
        assert!(output.status.success());
        assert_eq!(
            String::from_utf8(output.stdout).unwrap(),
            format!(
                "{{\"commit\":\"{commit}\",\"case_ids\":[\"docker-openclaw-nvidia\",\"docker-openclaw-vllm\"]}}\n"
            )
        );
        assert!(!invoke("HEAD", &[]).status.success());
        assert!(!invoke(&"f".repeat(40), &[]).status.success());
        assert!(!invoke(&commit, &["missing"]).status.success());
        let output = invoke(&base, &[]);
        assert!(output.status.success());
        assert_eq!(
            String::from_utf8(output.stdout).unwrap(),
            format!("{{\"commit\":\"{base}\",\"case_ids\":[]}}\n")
        );
        let repeated = invoke(&base, &[]);
        assert!(repeated.status.success());
        assert_eq!(repeated.stdout, invoke(&base, &[]).stdout);

        let assert_selection = |from: &str, to: &str, ids: &str| {
            let output = invoke_between(from, to, &[]);
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            assert_eq!(
                String::from_utf8(output.stdout).unwrap(),
                format!("{{\"commit\":\"{to}\",\"case_ids\":[{ids}]}}\n")
            );
        };
        // Moving out of a mapped directory must still select its old owner.
        git(&["mv", "crates/nemoclaw-runtime/src/lib.rs", "unrelated.txt"]);
        git(&["commit", "-qm", "rename out fixture"]);
        let renamed_out = git(&["rev-parse", "HEAD"]);
        assert_selection(&commit, &renamed_out, "\"docker-openclaw-vllm\"");
        // Moving into a shared directory must select the new owners too.
        std::fs::create_dir_all(root.join("crates/nemoclaw-sdk/src")).unwrap();
        git(&["mv", "unrelated.txt", "crates/nemoclaw-sdk/src/lib.rs"]);
        git(&["commit", "-qm", "rename in fixture"]);
        let renamed_in = git(&["rev-parse", "HEAD"]);
        let both = "\"docker-openclaw-nvidia\",\"docker-openclaw-vllm\"";
        assert_selection(&renamed_out, &renamed_in, both);
        git(&["rm", "crates/nemoclaw-sdk/src/lib.rs"]);
        git(&["commit", "-qm", "deletion fixture"]);
        let deleted = git(&["rev-parse", "HEAD"]);
        assert_selection(&renamed_in, &deleted, both);
        assert_selection(&deleted, &deleted, "");
        assert_selection(&deleted, &deleted, "");
    }
}
