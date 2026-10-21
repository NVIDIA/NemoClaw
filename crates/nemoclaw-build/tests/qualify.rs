// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! What `cargo images qualify` checks in an agent image: its assembly in every
//! image, and the reference runtime's lifecycle in the reference image.

use nemoclaw_build::images::{check_assembly, lifecycle_arguments};
use serde_json::json;

const FABRIC: &str = "a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1";
const REQUIREMENTS: &str = "b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2";
const CATALOG: &str = "c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3";

/// Facts as the image reports them, for an image that meets the contract.
fn facts() -> String {
    let provenance = json!({"harness": "agent", "source_sha256": FABRIC,
        "requirements_sha256": REQUIREMENTS, "local_sources": {"catalog.py": CATALOG}});
    let runtime = json!({"environment": {"TMPDIR": "/sandbox/tmp"}});
    format!(
        "=== provenance\n{provenance}\n=== runtime\n{runtime}\n=== hashes\n\
         {FABRIC}  fabric.tar.gz\n{REQUIREMENTS}  requirements.txt\n{CATALOG}  local/catalog.py\n\
         === copies\nsame catalog.py\n=== identity\n10001 10001\n=== sandbox\n\
         10001 755 directory /sandbox\n10001 755 directory /sandbox/tmp\n10001 644 regular file /sandbox/.profile\n\
         === installers\n=== toolchains\n=== control\nexecutable\n"
    )
}

#[test]
fn an_image_that_meets_the_contract_has_no_problems() {
    assert_eq!(check_assembly(&facts()), Vec::<String>::new());
}

#[test]
fn each_assembly_problem_is_named() {
    for (from, to, problem) in [
        (
            "=== control\nexecutable",
            "=== control\nmissing",
            "fabric-agent-ctl",
        ),
        (
            "=== installers\n",
            "=== installers\n/opt/fabric/bin/pip\n",
            "package installer",
        ),
        (
            "=== toolchains\n",
            "=== toolchains\n/usr/bin/gcc\n",
            "build toolchain",
        ),
        ("10001 10001", "0 0", "10001:10001"),
        (
            "10001 755 directory /sandbox\n",
            "0 755 directory /sandbox\n",
            "/sandbox",
        ),
        ("10001 755 directory /sandbox/tmp\n", "", "/sandbox/tmp"),
        (
            "10001 644 regular file",
            "10001 600 regular file",
            "/sandbox/.profile",
        ),
        (
            "10001 755 directory /sandbox/tmp",
            "10001 750 directory /sandbox/tmp",
            "/sandbox/tmp",
        ),
        (
            &format!("{FABRIC}  fabric.tar.gz"),
            &format!("{REQUIREMENTS}  fabric.tar.gz"),
            "fabric.tar.gz",
        ),
        (&format!("{CATALOG}  local/catalog.py\n"), "", "catalog.py"),
        ("same catalog.py", "differs catalog.py", "catalog.py"),
    ] {
        let changed = facts().replace(from, to);
        assert_ne!(changed, facts(), "{from}");
        let problems = check_assembly(&changed);
        assert!(
            problems.iter().any(|found| found.contains(problem)),
            "{from} -> {problems:?}"
        );
    }
    assert!(!check_assembly("not facts").is_empty());
}

/// The reference runtime runs as an OpenShell sandbox would run it: offline,
/// read-only, with only its sandbox storage writable, serving through Fabric's
/// `fabric-agent-ctl`. Nothing is mounted: Fabric's adapters are Fabric's to test.
#[test]
fn the_reference_lifecycle_runs_offline_read_only_in_sandbox_storage() {
    let arguments = lifecycle_arguments("name", "sha256:image");
    for required in [
        "--network=none",
        "--read-only",
        "--runtime=runc",
        "--detach",
    ] {
        assert!(
            arguments.iter().any(|argument| argument == required),
            "{required}"
        );
    }
    for (flag, value) in [
        ("-e", "HOME=/sandbox"),
        ("--workdir", "/sandbox"),
        ("--entrypoint", "/opt/fabric/bin/fabric-agent-ctl"),
        ("--tmpfs", "/sandbox:rw,uid=10001,gid=10001,mode=0700"),
    ] {
        assert!(
            arguments
                .windows(2)
                .any(|pair| pair[0] == flag && pair[1] == value),
            "{flag} {value}"
        );
    }
    assert!(
        !arguments
            .iter()
            .any(|argument| argument == "--mount" || argument == "-v")
    );
    assert_eq!(&arguments[arguments.len() - 2..], ["sha256:image", "serve"]);
}
