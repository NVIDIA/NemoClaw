// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
#![cfg(feature = "sdk")]
use std::{fs, path::Path, process::Command};

const REVISION: &str = "0123456789abcdef0123456789abcdef01234567";

fn fixture() -> tempfile::TempDir {
    let root = tempfile::tempdir().unwrap();
    fs::create_dir_all(root.path().join("fern")).unwrap();
    fs::create_dir_all(root.path().join("docs")).unwrap();
    fs::create_dir_all(root.path().join("examples")).unwrap();
    fs::write(
        root.path().join("examples/config.yaml"),
        "kind: Deployment\n",
    )
    .unwrap();
    fs::write(
        root.path().join("fern/pages.json"),
        r#"{
      "sections": [{"title": "Guides", "pages": [
        {"title": "Start", "source": "docs/start.md", "slug": "start"},
        {"title": "State", "source": "docs/state.md", "slug": "state"}
      ]}]
    }"#,
    )
    .unwrap();
    fs::write(
        root.path().join("docs/start.md"),
        r#"<!-- SPDX-License-Identifier: Apache-2.0 -->

# Start

Support is **TBD**.
Use [state](state.md#keep-data), [example](../examples/config.yaml), and [examples](../examples/).
The [reference][state] has the same destination.

[state]: state.md#keep-data

```sh
echo '[leave this](missing.md)' '{literal}'
```

Keep {braces} literal in prose.
"#,
    )
    .unwrap();
    fs::write(
        root.path().join("docs/state.md"),
        "# State\n\n## Keep Data\n\nKeep it.\n",
    )
    .unwrap();
    root
}

fn generate(root: &Path, check: bool) -> std::process::Output {
    let mut command = Command::new(env!("CARGO_BIN_EXE_nemoclaw-build"));
    command
        .current_dir(root)
        .args(["docs", "--revision", REVISION]);
    if check {
        command.arg("--check");
    }
    command.output().unwrap()
}

fn assert_success(result: std::process::Output) {
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
}

#[test]
fn publishes_repository_markdown_as_fern_routes_without_changing_sources() {
    let root = fixture();
    let source = fs::read(root.path().join("docs/start.md")).unwrap();
    assert_success(generate(root.path(), false));
    let page = fs::read_to_string(root.path().join("fern/_generated/pages/start.mdx")).unwrap();
    assert!(page.contains("/nemoclaw/v1/state#keep-data"));
    assert!(page.contains(&format!(
        "https://github.com/NVIDIA/NemoClaw/blob/{REVISION}/examples/config.yaml"
    )));
    assert!(page.contains(&format!(
        "https://github.com/NVIDIA/NemoClaw/tree/{REVISION}/examples"
    )));
    assert!(page.contains("**TBD**"));
    assert!(page.contains("echo '[leave this](missing.md)' '{literal}'"));
    assert!(page.contains("&#123;braces&#125;"));
    assert!(page.contains("{/* SPDX-License-Identifier: Apache-2.0 */}"));
    assert!(!page.contains("# Start\n"), "Fern supplies the page title");
    assert_eq!(fs::read(root.path().join("docs/start.md")).unwrap(), source);
    let nav: serde_json::Value = serde_saphyr::from_str(
        &fs::read_to_string(root.path().join("fern/_generated/navigation.yml")).unwrap(),
    )
    .unwrap();
    assert_eq!(
        nav["navigation"][0]["contents"][0]["path"],
        "./pages/start.mdx"
    );
    assert_success(generate(root.path(), true));
}

#[test]
fn check_rejects_missing_changed_and_obsolete_outputs_without_writing() {
    let root = fixture();
    assert!(!generate(root.path(), true).status.success());
    assert!(!root.path().join("fern/_generated").exists());
    assert_success(generate(root.path(), false));
    let generated = root.path().join("fern/_generated/pages/start.mdx");
    fs::write(&generated, "stale\n").unwrap();
    assert!(!generate(root.path(), true).status.success());
    assert_eq!(fs::read_to_string(&generated).unwrap(), "stale\n");
    assert_success(generate(root.path(), false));
    let obsolete = root.path().join("fern/_generated/pages/obsolete.mdx");
    fs::write(&obsolete, "obsolete").unwrap();
    assert!(!generate(root.path(), true).status.success());
    assert_success(generate(root.path(), false));
    assert!(!obsolete.exists());
}

#[test]
fn preserves_links_to_named_anchors_after_a_heading_rename() {
    let root = fixture();
    fs::write(
        root.path().join("docs/state.md"),
        "# State\n\n<a name=\"keep-data\"></a>\n\n## Retain Deployment Data\n\nKeep it.\n",
    )
    .unwrap();
    assert_success(generate(root.path(), false));
    let pages = root.path().join("fern/_generated/pages");
    let start = fs::read_to_string(pages.join("start.mdx")).unwrap();
    let state = fs::read_to_string(pages.join("state.mdx")).unwrap();
    assert!(start.contains("/nemoclaw/v1/state#keep-data"));
    assert!(state.contains("<a name=\"keep-data\"></a>"));
    assert!(state.contains("## Retain Deployment Data"));
}

#[test]
fn missing_files_and_anchors_fail_before_replacing_the_previous_output() {
    for destination in ["absent.md", "state.md#missing", "#missing"] {
        let root = fixture();
        assert_success(generate(root.path(), false));
        let output = root.path().join("fern/_generated/pages/start.mdx");
        let previous = fs::read(&output).unwrap();
        fs::write(
            root.path().join("docs/start.md"),
            format!("# Start\n\n[Broken]({destination})\n"),
        )
        .unwrap();
        let result = generate(root.path(), false);
        assert!(!result.status.success(), "accepted {destination}");
        assert!(String::from_utf8_lossy(&result.stderr).contains(destination));
        assert_eq!(fs::read(&output).unwrap(), previous);
    }
}

#[test]
fn refuses_ambiguous_routes_and_non_immutable_source_revisions() {
    let root = fixture();
    let path = root.path().join("fern/pages.json");
    let config = fs::read_to_string(&path)
        .unwrap()
        .replace("\"slug\": \"state\"", "\"slug\": \"start\"");
    fs::write(path, config).unwrap();
    assert!(!generate(root.path(), false).status.success());
    let result = Command::new(env!("CARGO_BIN_EXE_nemoclaw-build"))
        .current_dir(root.path())
        .args(["docs", "--revision", "v1"])
        .output()
        .unwrap();
    assert!(!result.status.success());
    assert!(String::from_utf8_lossy(&result.stderr).contains("40"));
}

#[test]
fn malformed_yaml_examples_stop_documentation_generation() {
    let root = fixture();
    fs::write(
        root.path().join("docs/start.md"),
        "# Start\n\n```yaml\n- name: provider\nauth:\n  method: api-key\n```\n",
    )
    .unwrap();
    let result = generate(root.path(), false);
    assert!(
        !result.status.success(),
        "invalid mixed sequence and mapping must fail"
    );
    assert!(String::from_utf8_lossy(&result.stderr).contains("YAML"));
}

#[test]
fn publishes_changelog_entries_with_links_to_guides_and_dated_fern_routes() {
    let root = fixture();
    let dir = root.path().join("docs/changelog");
    fs::create_dir(&dir).unwrap();
    fs::write(
        dir.join("overview.md"),
        "# Release Notes\n\n[First release](2026-02-03.md)\n",
    )
    .unwrap();
    fs::write(
        dir.join("2026-02-03.md"),
        "## v0.1.0\n\nRefer to [state](../state.md#keep-data).\n",
    )
    .unwrap();
    let manifest = root.path().join("fern/pages.json");
    let mut pages: serde_json::Value =
        serde_json::from_slice(&fs::read(&manifest).unwrap()).unwrap();
    pages["sections"][0]["pages"]
        .as_array_mut()
        .unwrap()
        .push(serde_json::json!({
            "title": "Release Notes", "source": "docs/changelog/overview.md",
            "slug": "release-notes", "changelog": true
        }));
    fs::write(manifest, serde_json::to_vec(&pages).unwrap()).unwrap();

    assert_success(generate(root.path(), false));
    let output = root.path().join("fern/_generated");
    let nav: serde_json::Value =
        serde_saphyr::from_str(&fs::read_to_string(output.join("navigation.yml")).unwrap())
            .unwrap();
    let folder = nav["navigation"][0]["contents"][2]["changelog"]
        .as_str()
        .unwrap();
    let published = output.join(folder);
    assert!(
        fs::read_to_string(published.join("2026-02-03.mdx"))
            .unwrap()
            .contains("/nemoclaw/v1/state#keep-data")
    );
    assert!(
        fs::read_to_string(published.join("overview.mdx"))
            .unwrap()
            .contains("/nemoclaw/v1/release-notes/2026/2/3")
    );
    assert_success(generate(root.path(), true));
}

#[test]
fn renders_the_pinned_shared_guide_without_a_v1_source_copy() {
    let root = fixture();
    let root = root.path();
    let git = |args: &[&str]| {
        let output = Command::new("git")
            .current_dir(root)
            .args([
                "-c",
                "user.name=Docs Test",
                "-c",
                "user.email=docs@example.org",
                "-c",
                "commit.gpgsign=false",
            ])
            .args(args)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8(output.stdout).unwrap()
    };
    let guide = root.join("docs/shared.mdx");
    let body = "---\ntitle: Shared\n---\n\n<Note>Read [a guide](related).</Note>\n\n`[example](related)`\n";
    fs::write(&guide, body).unwrap();
    git(&["init", "--quiet"]);
    git(&["add", "docs/shared.mdx"]);
    git(&["commit", "--quiet", "-m", "Shared guide"]);
    let pin = git(&["rev-parse", "HEAD"]);
    fs::write(
        root.join("fern/main-source.json"),
        serde_json::json!({"revision": pin.trim()}).to_string(),
    )
    .unwrap();
    fs::remove_file(guide).unwrap();
    fs::write(
        root.join("fern/pages.json"),
        serde_json::json!({"sections": [{"title":"Resources", "pages":[{
            "title":"Shared", "slug":"resources/shared", "source":"docs/shared.mdx",
            "from-main":true
        }]}]})
        .to_string(),
    )
    .unwrap();

    assert_success(generate(root, false));
    let output = root.join("fern/_generated");
    let nav: serde_json::Value =
        serde_saphyr::from_str(&fs::read_to_string(output.join("navigation.yml")).unwrap())
            .unwrap();
    let entry = &nav["navigation"][0]["contents"][0];
    assert_eq!(entry["slug"], "resources/shared");
    let rendered = fs::read_to_string(output.join(entry["path"].as_str().unwrap())).unwrap();
    assert_eq!(
        rendered,
        body.replacen(
            "](related)",
            &format!(
                "](https://github.com/NVIDIA/NemoClaw/blob/{}/docs/related.mdx)",
                pin.trim()
            ),
            1
        )
    );
    assert_success(generate(root, true));
}
