// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! A release lists the versions and digests that a deployment of it uses.

use serde_json::{Value, json};
use std::{fs, path::Path, process::Command};

const VERSIONS: &str = include_str!("../../../versions.json");

fn inventory(hermes: &str) -> Vec<u8> {
    serde_json::to_vec(&json!([
        {
            "name": "hermes",
            "repository": "ghcr.io/nvidia/nemoclaw/v1/hermes",
            "index_digest": format!("sha256:{}", hermes.repeat(64)),
            "manifests": {"manifests": []},
        },
        {
            "name": "vllm",
            "repository": "ghcr.io/nvidia/nemoclaw/v1/vllm",
            "index_digest": format!("sha256:{}", "b".repeat(64)),
            "manifests": {"manifests": []},
        },
    ]))
    .unwrap()
}

fn release_pins(directory: &Path, inventory: &[u8], tag: &str) -> std::process::Output {
    fs::write(directory.join("versions.json"), VERSIONS).unwrap();
    fs::write(directory.join("inventory.json"), inventory).unwrap();
    Command::new(env!("CARGO_BIN_EXE_nemoclaw-build"))
        .arg("release-pins")
        .arg("--versions")
        .arg(directory.join("versions.json"))
        .arg("--inventory")
        .arg(directory.join("inventory.json"))
        .args(["--tag", tag])
        .output()
        .unwrap()
}

#[test]
fn a_release_pins_what_its_deployments_use_and_no_build_tools() {
    const TAG: &str = "v0.1.0-rc.1";
    let root = tempfile::tempdir().unwrap();
    let output = release_pins(root.path(), &inventory("a"), TAG);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let pins: Value = serde_json::from_slice(&output.stdout).unwrap();
    let versions: Value = serde_json::from_str(VERSIONS).unwrap();
    assert_eq!(pins["release"], TAG);
    let components = pins["components"].as_object().unwrap();
    for (name, tool) in [
        ("opentofu", "tofu"),
        ("dockerProvider", "dockerProvider"),
        ("helmProvider", "helmProvider"),
    ] {
        let archives: serde_json::Map<String, Value> = versions["platforms"]
            .as_object()
            .unwrap()
            .iter()
            .filter_map(|(platform, tools)| Some((platform.clone(), tools.get(tool)?.clone())))
            .collect();
        assert!(!archives.is_empty(), "{name}");
        assert_eq!(
            components[name],
            json!({"version": versions[name], "archives": archives}),
            "{name}"
        );
    }
    for name in ["gateway", "supervisor", "sandboxRuntime"] {
        assert_eq!(
            components[name],
            json!({"version": versions["openshell"], "image": versions["images"][name]}),
            "{name}"
        );
    }
    assert_eq!(
        components["gatewayChart"],
        json!({"version": versions["openshell"], "chart": versions["images"]["gatewayChart"]})
    );
    assert_eq!(
        components["developmentIssuer"],
        json!({"image": versions["images"]["developmentIssuer"]})
    );
    let fabric = &versions["imageSources"]["fabric"]["fabric.tar.gz"];
    let revision = fabric["url"].as_str().unwrap().rsplit('/').next().unwrap();
    assert_eq!(
        components["fabric"],
        json!({"version": revision, "source": fabric})
    );
    for (name, digest) in [("hermes", "a"), ("vllm", "b")] {
        assert_eq!(
            components[name],
            json!({
                "version": TAG,
                "image": format!("ghcr.io/nvidia/nemoclaw/v1/{name}@sha256:{}", digest.repeat(64)),
            }),
            "{name}"
        );
    }
    // Rust, protoc, nextest, kind, and the OpenShell CLI only build and test NemoClaw.
    let mut names: Vec<&str> = components.keys().map(String::as_str).collect();
    names.sort_unstable();
    assert_eq!(
        names,
        [
            "developmentIssuer",
            "dockerProvider",
            "fabric",
            "gateway",
            "gatewayChart",
            "helmProvider",
            "hermes",
            "opentofu",
            "sandboxRuntime",
            "supervisor",
            "vllm",
        ]
    );
}

#[cfg(unix)]
#[test]
fn a_final_release_requires_the_pins_of_its_tag_and_staged_images() {
    use sha2::Digest;
    use std::os::unix::fs::PermissionsExt;
    const TAG: &str = "v0.1.0";
    let workflow: Value =
        serde_saphyr::from_str(include_str!("../../../.github/workflows/release.yml")).unwrap();
    let script = workflow["jobs"]["assess"]["steps"]
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["name"] == "Require the version pins of the tag and its images")
        .unwrap()["run"]
        .as_str()
        .unwrap();
    let staged = inventory("a");
    let generated = tempfile::tempdir().unwrap();
    let pins = release_pins(generated.path(), &staged, TAG);
    assert!(pins.status.success());
    let checksum = |bytes: &[u8]| {
        sha2::Sha256::digest(bytes)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    };
    let changed = release_pins(generated.path(), &inventory("c"), TAG);
    for (version_pins, inventory_checksum, allowed) in [
        (pins.stdout.clone(), checksum(&staged), true),
        // The draft's pins name another digest than the images staging recorded.
        (changed.stdout, checksum(&staged), false),
        // The inventory must be the one staging recorded.
        (pins.stdout.clone(), checksum(b"other"), false),
    ] {
        let root = tempfile::tempdir().unwrap();
        let fixture = root.path().join("fixture");
        let bin = root.path().join("bin");
        fs::create_dir(&fixture).unwrap();
        fs::create_dir(&bin).unwrap();
        fs::write(fixture.join("versions.json"), VERSIONS).unwrap();
        fs::write(fixture.join("inventory.json"), &staged).unwrap();
        fs::write(fixture.join("version-pins.json"), &version_pins).unwrap();
        let mut tools = vec![
            (
                "gh",
                "#!/bin/sh\ntest \"$1 $2 $3\" = \"release download $TAG\" || exit 2\nwhile [ $# -gt 0 ]; do\n  case \"$1\" in --pattern) pattern=$2 ;; --output) out=$2 ;; esac\n  shift\ndone\nexec /bin/cp \"$FIXTURE/$pattern\" \"$out\"\n",
            ),
            (
                "git",
                "#!/bin/sh\ntest \"$1 $2\" = \"show $CANDIDATE_REVISION:versions.json\" || exit 2\nexec /bin/cat \"$FIXTURE/versions.json\"\n",
            ),
            (
                "cargo",
                "#!/bin/sh\nwhile [ \"$1\" != -- ]; do shift; done\nshift\nexec \"$CONTROLLER_BIN\" \"$@\"\n",
            ),
        ];
        // The Ubuntu runner has sha256sum; macOS has shasum instead.
        if !["/usr/bin/sha256sum", "/bin/sha256sum"]
            .iter()
            .any(|path| Path::new(path).exists())
        {
            tools.push((
                "sha256sum",
                "#!/bin/sh\nexec /usr/bin/shasum -a 256 \"$@\"\n",
            ));
        }
        for (name, script) in tools {
            let path = bin.join(name);
            fs::write(&path, script).unwrap();
            fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
        }
        let output = Command::new("/bin/bash")
            .args(["-euo", "pipefail", "-c", script])
            .env_clear()
            .env("PATH", format!("{}:/usr/bin:/bin", bin.display()))
            .env("FIXTURE", &fixture)
            .env("RUNNER_TEMP", root.path())
            .env("GITHUB_REPOSITORY", "fixture/repository")
            .env("CONTROLLER_BIN", env!("CARGO_BIN_EXE_nemoclaw-build"))
            .env("TAG", TAG)
            .env("CANDIDATE_REVISION", "a".repeat(40))
            .env("INVENTORY_SHA256", &inventory_checksum)
            .output()
            .unwrap();
        assert_eq!(
            output.status.success(),
            allowed,
            "{}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }
}
