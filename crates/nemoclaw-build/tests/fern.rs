// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Fern publication guards: immutable sources, isolated previews, and
//! release identity checks that run before any tool or token is used.

use nemoclaw_build::fern::{
    Release, adapt_main_snippets, preview_comment, preview_ids_to_delete, preview_url,
    published_preview, validate_revision,
};
use serde_json::json;
use std::fs;

#[test]
fn main_docs_pin_must_be_immutable() {
    for revision in ["main", "origin/main", "abcd", "../outside", &"A".repeat(40)] {
        assert!(validate_revision(revision).is_err(), "{revision}");
    }
    assert!(validate_revision(&"a".repeat(40)).is_ok());
}

#[test]
fn main_import_adapts_absolute_snippets_without_editing_other_content() {
    let source = "<Markdown src=\"/../docs/_build/StarterPrompt.generated.mdx\" />\n[legacy](/nemoclaw/latest/home)\n";
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("docs/index.mdx");
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(&path, source).unwrap();
    fs::write(root.path().join("docs/other.md"), source).unwrap();
    adapt_main_snippets(root.path()).unwrap();
    assert_eq!(
        fs::read_to_string(&path).unwrap(),
        source.replace("/../docs/", "/_main/docs/")
    );
    assert_eq!(
        fs::read_to_string(root.path().join("docs/other.md")).unwrap(),
        source
    );
}

#[test]
fn preview_ids_cannot_replace_main_previews() {
    for identifier in [
        "pr-1",
        "main",
        "nemoclaw-v1-",
        "nemoclaw-v1/other",
        "nemoclaw-v1-PR",
    ] {
        assert!(preview_url(identifier).is_err(), "{identifier}");
    }
    assert_eq!(
        preview_url("nemoclaw-v1-pr-12").unwrap(),
        "https://nvidia-preview-nemoclaw-v1-pr-12.docs.buildwithfern.com/nemoclaw"
    );
    assert!(preview_url("nemoclaw-v1").is_ok());
}

#[test]
fn preview_requires_success_and_its_own_url() {
    let expected = preview_url("nemoclaw-v1-pr-1").unwrap();
    let reported = format!("Published docs to {expected}/v1/overview\n");
    assert_eq!(
        published_preview("nemoclaw-v1-pr-1", true, &reported).unwrap(),
        format!("{expected}/v1/overview")
    );
    // Fern colours its output; the URL ends at the escape sequence.
    let coloured = format!("Published docs to {expected}\u{1b}[0m\n");
    assert_eq!(
        published_preview("nemoclaw-v1-pr-1", true, &coloured).unwrap(),
        expected
    );
    assert!(published_preview("nemoclaw-v1-pr-1", false, &reported).is_err());
    for output in [
        String::new(),
        "Published docs to https://other.example/nemoclaw".to_owned(),
        format!("Published docs to {expected}-other"),
    ] {
        assert!(
            published_preview("nemoclaw-v1-pr-1", true, &output).is_err(),
            "{output}"
        );
    }
}

#[test]
fn public_release_requires_enablement_a_v1_tag_and_the_tagged_commit() {
    let release = |enabled: Option<&str>, kind: Option<&str>, tag: Option<&str>| Release {
        enabled: enabled.map(Into::into),
        ref_type: kind.map(Into::into),
        ref_name: tag.map(Into::into),
    };
    let ok = release(Some("true"), Some("tag"), Some("v1.0.0"));
    assert_eq!(ok.tag().unwrap(), "v1.0.0");
    assert!(
        release(None, Some("tag"), Some("v1.0.0"))
            .tag()
            .unwrap_err()
            .contains("FERN_V1_PUBLIC_ENABLED")
    );
    assert!(
        release(Some("false"), Some("tag"), Some("v1.0.0"))
            .tag()
            .is_err()
    );
    assert!(
        release(Some("true"), Some("branch"), Some("v1"))
            .tag()
            .is_err()
    );
    for tag in ["v2.0.0", "v1.0", "v1.0.0/x", "1.0.0"] {
        assert!(
            release(Some("true"), Some("tag"), Some(tag)).tag().is_err(),
            "{tag}"
        );
    }
    assert!(
        release(Some("true"), Some("tag"), Some("v1.2.3-rc.1"))
            .tag()
            .is_ok()
    );
}

#[test]
fn merged_v1_pull_requests_select_their_previews() {
    let pages = json!([
        [{"number": 12, "merged_at": "2026-10-01T00:00:00Z", "base": {"ref": "v1"}},
         {"number": 13, "merged_at": null, "base": {"ref": "v1"}}],
        [{"number": 14, "merged_at": "2026-10-01T00:00:00Z", "base": {"ref": "main"}}]
    ]);
    assert_eq!(
        preview_ids_to_delete(&pages).unwrap(),
        ["nemoclaw-v1-pr-12"]
    );
    assert!(
        preview_ids_to_delete(&json!([[{"number": "x", "merged_at": "t", "base": {"ref": "v1"}}]]))
            .is_err()
    );
}

#[test]
fn preview_comment_updates_the_bot_comment_or_creates_one() {
    let marker = "<!-- fern-preview-docs-v1 -->";
    let pages = json!([[
        {"id": 1, "user": {"login": "someone"}, "body": marker},
        {"id": 2, "user": {"login": "github-actions[bot]"}, "body": format!("old\n\n{marker}")}
    ]]);
    let (endpoint, method, body) = preview_comment("o/r", 7, "https://x", &pages).unwrap();
    assert_eq!(
        (endpoint.as_str(), method),
        ("repos/o/r/issues/comments/2", "PATCH")
    );
    assert!(body["body"].as_str().unwrap().contains("https://x"));
    assert!(body["body"].as_str().unwrap().ends_with(marker));
    let (endpoint, method, _) = preview_comment("o/r", 7, "https://x", &json!([[]])).unwrap();
    assert_eq!(
        (endpoint.as_str(), method),
        ("repos/o/r/issues/7/comments", "POST")
    );
}
