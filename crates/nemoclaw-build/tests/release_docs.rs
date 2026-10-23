// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Exercise the documentation workflow's publication guard without external writes.
#[test]
fn public_documentation_requires_the_bound_passing_public_release() {
    use serde_json::{Value, json};
    use sha2::{Digest, Sha256};
    use std::{fs, os::unix::fs::PermissionsExt, process::Command};
    let workflow: Value =
        serde_saphyr::from_str(include_str!("../../../.github/workflows/docs.yml")).unwrap();
    let script = workflow["jobs"]["public"]["steps"]
        .as_array()
        .unwrap()
        .iter()
        .find(|step| step["name"] == "Require a security-reviewed public release")
        .and_then(|step| step["run"].as_str())
        .unwrap_or("");
    for case in [
        "draft",
        "blocked",
        "missing",
        "substitution",
        "wrong-tag",
        "passed",
    ] {
        let root = tempfile::tempdir().unwrap();
        let fixture = root.path().join("fixture");
        fs::create_dir(&fixture).unwrap();
        let assessment = br#"{"status":"passed","publication_authorized":false}"#;
        fs::write(fixture.join("assessment.json"), assessment).unwrap();
        fs::write(fixture.join("inventory.json"), b"[]").unwrap();
        fs::write(fixture.join("sboms.json"), b"[]").unwrap();
        let hash = |bytes: &[u8]| nemoclaw_build::hex(&Sha256::digest(bytes));
        let gate = json!({"schema_version":1,"status":if case == "blocked" {"blocked"} else {"passed"},
            "publication_authorized":false,"release_tag":if case == "wrong-tag" {"v0.1.1"} else {"v0.1.0"},
            "controller_revision":"a".repeat(40),"inventory_sha256":hash(b"[]"),"sboms_sha256":hash(b"[]"),
            "assessment_sha256":hash(assessment),"policy":{"status":"passed","publication_authorized":false,"policy_sha256":"b".repeat(64)}});
        if case != "missing" {
            fs::write(
                fixture.join("gate.json"),
                serde_json::to_vec(&gate).unwrap(),
            )
            .unwrap();
        }
        if case == "substitution" {
            fs::write(fixture.join("assessment.json"), b"substituted").unwrap();
        }
        fs::write(fixture.join("release.json"), serde_json::to_vec(&json!({"tag_name":"v0.1.0", "draft":case=="draft","published_at":"2026-10-21T00:00:00Z"})).unwrap()).unwrap();
        let gh = root.path().join("gh");
        fs::write(&gh, r#"#!/bin/sh
set -eu
if [ "$1" = api ]; then cat "$FIXTURE/release.json"; exit 0; fi
while [ "$#" -gt 0 ]; do
  if [ "$1" = --dir ]; then shift; destination=$1; fi
  shift
done
cp "$FIXTURE"/gate.json "$FIXTURE"/assessment.json "$FIXTURE"/inventory.json "$FIXTURE"/sboms.json "$destination"/
"#).unwrap();
        fs::set_permissions(&gh, fs::Permissions::from_mode(0o700)).unwrap();
        let checksum = root.path().join("sha256sum");
        fs::write(&checksum, "#!/bin/sh\nexec shasum -a 256 \"$@\"\n").unwrap();
        fs::set_permissions(&checksum, fs::Permissions::from_mode(0o700)).unwrap();
        let result = Command::new("/bin/bash")
            .args(["-euo", "pipefail", "-c", script])
            .env_clear()
            .env(
                "PATH",
                format!(
                    "{}:{}",
                    root.path().display(),
                    std::env::var("PATH").unwrap()
                ),
            )
            .env("FIXTURE", &fixture)
            .env("RUNNER_TEMP", root.path())
            .env("GITHUB_REPOSITORY", "NVIDIA/NemoClaw")
            .env("TAG", "v0.1.0")
            .env("GH_TOKEN", "fixture-token")
            .output()
            .unwrap();
        assert_eq!(
            result.status.success(),
            case == "passed",
            "{case}: {}",
            String::from_utf8_lossy(&result.stderr)
        );
    }
}
