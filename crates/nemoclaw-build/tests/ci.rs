// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Step selection and installation of the pinned CI tools.

use nemoclaw_build::ci::{self, Step};
use std::io::{Cursor, Write};

#[test]
fn unknown_steps_and_platforms_are_rejected_before_any_work() {
    assert_eq!(Step::parse("lifecycle"), Some(Step::Lifecycle));
    assert_eq!(Step::parse("python"), None);
    assert!(ci::nextest_target("plan9_amd64").is_err());
}

#[test]
fn live_docker_is_an_explicit_step_outside_the_default_run() {
    assert_eq!(Step::parse("live-docker"), Some(Step::LiveDocker));
    assert!(!Step::ALL.contains(&Step::LiveDocker));
    assert_eq!(Step::parse("live-kind"), Some(Step::LiveKind));
    assert!(!Step::ALL.contains(&Step::LiveKind));
}

#[cfg(target_os = "linux")]
#[test]
fn live_kind_requires_its_bundle_before_downloading_tools_or_creating_a_cluster() {
    use std::{fs, os::unix::fs::PermissionsExt, process::Command};
    let root = tempfile::tempdir().unwrap();
    let bin = root.path().join("bin");
    fs::create_dir(&bin).unwrap();
    for (name, script) in [
        ("protoc", "#!/bin/sh\nprintf 'libprotoc 36.1\\n'\n"),
        (
            "cargo",
            "#!/bin/sh\nif [ \"$1 $2\" = 'nextest --version' ]; then printf 'cargo-nextest 0.9.144\\n'; exit 0; fi\nexit 71\n",
        ),
        (
            "docker",
            "#!/bin/sh\nprintf accessed > cluster-accessed\nexit 72\n",
        ),
    ] {
        let path = bin.join(name);
        fs::write(&path, script).unwrap();
        fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
    }
    fs::write(
        root.path().join("versions.json"),
        serde_json::json!({
            "rust":"1.98.1", "protobuf":"36.1", "nextest":"0.9.144",
            "opentofu":"1.12.6", "dockerProvider":"4.6.0", "helmProvider":"3.3.0",
            "platforms":{}, "images":{"kindNode":"kindest/node@sha256:fixture"}
        })
        .to_string(),
    )
    .unwrap();
    let result = Command::new(env!("CARGO_BIN_EXE_nemoclaw-build"))
        .args(["ci", "live-kind"])
        .current_dir(root.path())
        .env("CARGO", bin.join("cargo"))
        .env("PROTOC", bin.join("protoc"))
        .env("PATH", &bin)
        .env("TEST_PLATFORM", "linux_amd64")
        .env_remove("GITHUB_ENV")
        .env_remove("GITHUB_PATH")
        .output()
        .unwrap();
    assert!(!result.status.success());
    let error = String::from_utf8_lossy(&result.stderr);
    assert!(
        error.contains("build the bundle first: cargo ci bundle"),
        "{error}"
    );
    assert!(!root.path().join(".build/downloads").exists());
    assert!(!root.path().join("cluster-accessed").exists());
}

// `cargo ci` runs this tool through `cargo run`, which describes the tool's own
// package in the environment and, because the tool has a build script, sets
// OUT_DIR. Build scripts such as ring's rerun when CARGO_MANIFEST_DIR or
// OUT_DIR changes, so passing either on would rebuild them.
#[cfg(target_os = "linux")]
#[test]
fn cargo_steps_do_not_inherit_the_package_description_from_cargo_run() {
    use std::{fs, os::unix::fs::PermissionsExt, process::Command};
    let root = tempfile::tempdir().unwrap();
    let bin = root.path().join("bin");
    fs::create_dir(&bin).unwrap();
    for (name, script) in [
        ("protoc", "#!/bin/sh\nprintf 'libprotoc 36.1\\n'\n"),
        (
            "cargo",
            "#!/bin/sh\nif [ \"$1 $2\" = 'nextest --version' ]; then printf 'cargo-nextest 0.9.144\\n'; exit 0; fi\nexport -p > cargo-environment\n",
        ),
    ] {
        let path = bin.join(name);
        fs::write(&path, script).unwrap();
        fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
    }
    fs::write(
        root.path().join("versions.json"),
        serde_json::json!({
            "rust":"1.98.1", "protobuf":"36.1", "nextest":"0.9.144",
            "opentofu":"1.12.6", "dockerProvider":"4.6.0", "helmProvider":"3.3.0",
            "platforms":{}
        })
        .to_string(),
    )
    .unwrap();
    let result = Command::new(env!("CARGO_BIN_EXE_nemoclaw-build"))
        .args(["ci", "fmt"])
        .current_dir(root.path())
        .env("CARGO", bin.join("cargo"))
        .env("PROTOC", bin.join("protoc"))
        .env("PATH", &bin)
        .env("TEST_PLATFORM", "linux_amd64")
        .env("CARGO_MANIFEST_DIR", "/workspace/crates/nemoclaw-build")
        .env(
            "CARGO_MANIFEST_PATH",
            "/workspace/crates/nemoclaw-build/Cargo.toml",
        )
        .env("CARGO_PKG_NAME", "nemoclaw-build")
        .env(
            "OUT_DIR",
            "/workspace/target/debug/build/nemoclaw-build-0/out",
        )
        .env("CARGO_HOME", "/cargo-home")
        .env_remove("GITHUB_ENV")
        .env_remove("GITHUB_PATH")
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    let environment = fs::read_to_string(root.path().join("cargo-environment")).unwrap();
    let names: Vec<_> = environment
        .lines()
        .filter_map(|line| line.strip_prefix("export ")?.split('=').next())
        .collect();
    for removed in [
        "CARGO_MANIFEST_DIR",
        "CARGO_MANIFEST_PATH",
        "CARGO_PKG_NAME",
        "OUT_DIR",
    ] {
        assert!(!names.contains(&removed), "cargo received {removed}");
    }
    assert!(names.contains(&"CARGO_HOME"), "cargo lost CARGO_HOME");
}

#[test]
fn gateway_documents_are_fresh_and_avoid_ports_and_subnets_in_use() {
    use ci::live::{GatewayInputs, free_subnet, gateway_document, uuid};
    let first = uuid().unwrap();
    let second = uuid().unwrap();
    assert_ne!(first, second);
    for id in [&first, &second] {
        let parts: Vec<_> = id.split('-').map(str::len).collect();
        assert_eq!(parts, [8, 4, 4, 4, 12], "{id}");
        assert!(
            id.chars()
                .all(|c| c == '-' || c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
        );
        assert_eq!(&id[14..15], "4", "version 4 UUID: {id}");
    }

    let used = ["172.30.200.0/24".to_owned(), "172.30.201.0/24".to_owned()];
    let chosen = free_subnet(&used, &[]).unwrap();
    assert_eq!(chosen, "172.30.202.0/24");
    assert_eq!(
        free_subnet(&used, std::slice::from_ref(&chosen)).unwrap(),
        "172.30.203.0/24"
    );

    let document = gateway_document(&GatewayInputs {
        name: "live-gateway-1",
        uid: &first,
        port: 17950,
        subnet: &chosen,
        image: "nc-live@sha256:abc",
        harness: "nvidia.fabric.pi",
        settings: None,
    });
    let value: serde_json::Value = serde_saphyr::from_str(&document).unwrap();
    assert!(
        value["spec"]["sandboxes"]["assistant"]["harness"]
            .get("settings")
            .is_none()
    );
    let with_settings = gateway_document(&GatewayInputs {
        name: "live-dummy",
        uid: &first,
        port: 17951,
        subnet: &chosen,
        image: "nc-live@sha256:abc",
        harness: "org.nemoclaw.dummy",
        settings: serde_json::json!({"reply": "dummy-reply"}).as_object(),
    });
    let with_settings: serde_json::Value = serde_saphyr::from_str(&with_settings).unwrap();
    assert_eq!(
        with_settings["spec"]["sandboxes"]["assistant"]["harness"]["settings"],
        serde_json::json!({"reply": "dummy-reply"})
    );
    assert_eq!(value["metadata"]["uid"], first.as_str());
    assert_eq!(value["spec"]["gateway"]["management"], "managed");
    assert_eq!(
        value["spec"]["gateway"]["endpoint"],
        "http://127.0.0.1:17950"
    );
    assert_eq!(value["spec"]["gateway"]["networkCIDR"], chosen.as_str());
    assert_eq!(
        value["spec"]["sandboxes"]["assistant"]["image"]["ref"],
        "nc-live@sha256:abc"
    );
    assert_eq!(
        value["spec"]["sandboxes"]["assistant"]["harness"]["kind"],
        "nvidia.fabric.pi"
    );
    assert!(value["spec"].get("services").is_none());
}

/// The live-docker gateway tests read this document, so it must be one the
/// SDK accepts; a field-by-field check missed a stale shape before.
#[cfg(feature = "sdk")]
#[test]
fn gateway_documents_parse_as_current_configuration() {
    use ci::live::{GatewayInputs, gateway_document, uuid};
    let uid = uuid().unwrap();
    let document = gateway_document(&GatewayInputs {
        name: "live-gateway-1",
        uid: &uid,
        port: 17950,
        subnet: "172.30.202.0/24",
        image: &format!("nc-live@sha256:{}", "a".repeat(64)),
        harness: "nvidia.fabric.pi",
        settings: None,
    });
    let parsed = nemoclaw_sdk::config::Document::parse(document.as_bytes()).unwrap();
    assert_eq!(
        parsed.spec.gateway.runtime().provider,
        nemoclaw_sdk::config::ComputeDriver::Docker
    );
}

/// The interface live test's document: OpenClaw's dashboard and Hermes's API
/// server and dashboard, with a model endpoint on the gateway network's host
/// address and a key the test supplies. Hermes's policy lets browser chat open
/// a terminal.
#[cfg(feature = "sdk")]
#[test]
fn the_interfaces_document_enables_each_p0_interface() {
    use ci::live::{INTERFACES_MODEL_KEY, InterfacesInputs, interfaces_document, uuid};
    let uid = uuid().unwrap();
    let image = |name: &str| format!("nc-live-{name}@sha256:{}", "a".repeat(64));
    let document = interfaces_document(&InterfacesInputs {
        name: "live-interfaces",
        uid: &uid,
        port: 17951,
        subnet: "172.30.203.0/24",
        openclaw: &image("openclaw"),
        hermes: &image("hermes"),
        model_port: 18431,
    });
    let parsed = nemoclaw_sdk::config::Document::parse(document.as_bytes()).unwrap();
    let value = serde_json::to_value(&parsed).unwrap();
    let provider = &value["spec"]["inferenceProviders"]["model"];
    assert_eq!(provider["endpoint"], "http://172.30.203.1:18431/v1");
    assert_eq!(provider["credential"]["env"], INTERFACES_MODEL_KEY);
    let sandboxes = &value["spec"]["sandboxes"];
    assert_eq!(
        sandboxes["claw"]["harness"]["settings"]["interfaces"],
        serde_json::json!({"dashboard": {"port": 18789}})
    );
    assert_eq!(
        sandboxes["hermes"]["harness"]["settings"]["interfaces"],
        serde_json::json!({"api": {"port": 8642}, "dashboard": {"port": 9119}})
    );
    let writable =
        sandboxes["hermes"]["network"]["policy"]["explicit"]["filesystem_policy"]["read_write"]
            .as_array()
            .unwrap();
    for path in ["/dev/pts", "/sandbox"] {
        assert!(
            writable.iter().any(|granted| granted == path),
            "{writable:?}"
        );
    }
}

fn zip(entries: &[(&str, &[u8])]) -> Vec<u8> {
    let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
    for (name, bytes) in entries {
        if name.ends_with('/') {
            zip.add_directory(*name, zip::write::SimpleFileOptions::default())
                .unwrap();
        } else {
            zip.start_file(*name, zip::write::SimpleFileOptions::default())
                .unwrap();
            zip.write_all(bytes).unwrap();
        }
    }
    zip.finish().unwrap().into_inner()
}

#[test]
fn protoc_archive_is_installed_with_its_includes_and_an_executable_compiler() {
    let directory = tempfile::tempdir().unwrap();
    let archive = zip(&[
        ("bin/", b""),
        ("bin/protoc", b"compiler"),
        ("include/google/protobuf/any.proto", b"syntax"),
        ("readme.txt", b"notice"),
    ]);
    let binary = ci::install_protoc(&archive, directory.path(), false).unwrap();
    assert_eq!(binary, directory.path().join("bin/protoc"));
    assert_eq!(std::fs::read(&binary).unwrap(), b"compiler");
    assert!(
        directory
            .path()
            .join("include/google/protobuf/any.proto")
            .is_file()
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(&binary).unwrap().permissions().mode() & 0o111,
            0o111
        );
    }
}

#[test]
fn archives_cannot_write_outside_the_tool_directory_or_omit_the_compiler() {
    let directory = tempfile::tempdir().unwrap();
    let escape = directory.path().join("escape");
    for archive in [
        zip(&[("bin/protoc", b"x"), ("../escape", b"x")]),
        zip(&[("include/a.proto", b"x")]),
    ] {
        assert!(ci::install_protoc(&archive, &directory.path().join("tool"), false).is_err());
    }
    assert!(!escape.exists());
}

fn tar_gz(entries: &[(&str, &[u8])]) -> Vec<u8> {
    let mut tar = tar::Builder::new(flate2::write::GzEncoder::new(
        Vec::new(),
        flate2::Compression::default(),
    ));
    for (name, bytes) in entries {
        let mut header = tar::Header::new_gnu();
        // Write the raw name so tests can model hostile paths the builder rejects.
        header.as_old_mut().name[..name.len()].copy_from_slice(name.as_bytes());
        header.set_size(bytes.len() as u64);
        header.set_mode(0o755);
        header.set_entry_type(tar::EntryType::Regular);
        header.set_cksum();
        tar.append(&header, *bytes).unwrap();
    }
    tar.into_inner().unwrap().finish().unwrap()
}

#[test]
fn nextest_archive_installs_only_its_single_executable() {
    let directory = tempfile::tempdir().unwrap();
    let binary = ci::install_nextest(
        &tar_gz(&[("cargo-nextest", b"runner")]),
        directory.path(),
        false,
    )
    .unwrap();
    assert_eq!(binary, directory.path().join("cargo-nextest"));
    assert_eq!(std::fs::read(&binary).unwrap(), b"runner");
    for archive in [
        tar_gz(&[("cargo-nextest", b"runner"), ("extra", b"x")]),
        tar_gz(&[("../cargo-nextest", b"runner")]),
        tar_gz(&[]),
    ] {
        assert!(ci::install_nextest(&archive, &directory.path().join("other"), false).is_err());
    }
}

#[test]
fn openshell_archive_installs_only_its_single_executable() {
    let directory = tempfile::tempdir().unwrap();
    let binary =
        ci::install_openshell(&tar_gz(&[("openshell", b"cli")]), directory.path()).unwrap();
    assert_eq!(binary, directory.path().join("openshell"));
    assert_eq!(std::fs::read(&binary).unwrap(), b"cli");
    for archive in [
        tar_gz(&[("openshell", b"cli"), ("openshell-gateway", b"x")]),
        tar_gz(&[("bin/openshell", b"cli")]),
        tar_gz(&[]),
    ] {
        assert!(ci::install_openshell(&archive, &directory.path().join("other")).is_err());
    }
}

/// The live suites run the OpenShell CLI at the SDK's pinned version.
#[test]
fn the_pinned_openshell_cli_matches_the_openshell_version() {
    let pins: serde_json::Value =
        serde_json::from_str(include_str!("../../../versions.json")).unwrap();
    let version = pins["openshell"].as_str().unwrap();
    for platform in ["linux_arm64", "linux_amd64"] {
        let url = pins["platforms"][platform]["openshell"]["url"]
            .as_str()
            .unwrap();
        assert!(
            url.starts_with(&format!(
                "https://github.com/NVIDIA/OpenShell/releases/download/v{version}/openshell-"
            )),
            "{platform}: {url}"
        );
    }
}

const JUNIT: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="nextest-run" tests="4" failures="1" errors="0" uuid="4a7e64c9-afaa-4115-a4cb-08e38ea6bf43" timestamp="2026-10-09T00:20:53.957+00:00" time="12.500">
    <testsuite name="nemoclaw-e2e::integration" tests="3" disabled="0" errors="0" failures="1">
        <testcase name="deployment::slow_scenario" classname="nemoclaw-e2e::integration" timestamp="2026-10-09T00:20:54.000+00:00" time="9.250">
        </testcase>
        <testcase name="deployment::quick &amp; &quot;quoted&quot;" classname="nemoclaw-e2e::integration" timestamp="2026-10-09T00:20:54.000+00:00" time="0.750">
            <failure type="test failure">failed</failure>
        </testcase>
        <testcase name="service_storage::applies" classname="nemoclaw-e2e::integration" timestamp="2026-10-09T00:20:54.000+00:00" time="2.000"/>
    </testsuite>
    <testsuite name="nemoclaw-sdk" tests="1" disabled="0" errors="0" failures="0">
        <testcase name="state::reads" classname="nemoclaw-sdk" timestamp="2026-10-09T00:20:54.000+00:00" time="0.500"/>
    </testsuite>
</testsuites>
"#;

#[test]
fn timing_reports_show_wall_time_and_where_test_time_goes() {
    let run = ci::timing::Run::parse(JUNIT).unwrap();
    assert_eq!(run.wall_seconds, 12.5);
    assert_eq!(run.tests.len(), 4);
    assert_eq!(run.tests[1].name, r#"deployment::quick & "quoted""#);
    assert!(run.tests[1].failed);

    let report = run.report("lifecycle", 2);
    // The headline names the profile, its test count, wall time, and summed time.
    assert!(
        report.contains("lifecycle: 4 tests, 12.5 s wall, 12.5 s summed"),
        "{report}"
    );
    // Groups are a binary and a test module, slowest first.
    let groups = report.find("| nemoclaw-e2e::integration | deployment | 2 | 10.0 s | 9.2 s |");
    let storage =
        report.find("| nemoclaw-e2e::integration | service_storage | 1 | 2.0 s | 2.0 s |");
    assert!(
        groups.is_some() && storage.is_some() && groups < storage,
        "{report}"
    );
    // The remaining modules are summed on one row.
    assert!(
        report.contains("| 1 other modules | | | 0.5 s | |"),
        "{report}"
    );
    // Only the slowest tests are listed, slowest first.
    assert!(
        report.contains("| 9.2 s | nemoclaw-e2e::integration deployment::slow_scenario |"),
        "{report}"
    );
    assert!(
        report.contains("| 2.0 s | nemoclaw-e2e::integration service_storage::applies |"),
        "{report}"
    );
    assert!(
        !report.contains("| 0.5 s | nemoclaw-sdk state::reads |"),
        "{report}"
    );

    assert!(ci::timing::Run::parse("<testsuites>").is_err());
}

#[test]
fn budgets_name_each_step_over_its_wall_time_and_each_test_over_its_limit() {
    let budgets = ci::timing::Budgets::parse(
        "lifecycle:\n  wall_seconds: 10\n  test_seconds: 5\ntest:\n  wall_seconds: 60\n  test_seconds: 2\n",
    )
    .unwrap();
    let run = ci::timing::Run::parse(JUNIT).unwrap();
    let lifecycle = budgets.get("lifecycle").unwrap();
    assert_eq!(
        run.over(lifecycle),
        [
            "12.5 s wall exceeds the 10 s budget".to_owned(),
            "nemoclaw-e2e::integration deployment::slow_scenario took 9.2 s; the limit is 5 s"
                .to_owned(),
        ]
    );
    let test = budgets.get("test").unwrap();
    assert_eq!(
        run.over(test),
        [
            "nemoclaw-e2e::integration deployment::slow_scenario took 9.2 s; the limit is 2 s"
                .to_owned(),
        ]
    );
    assert!(budgets.get("live-kind").is_none());
    assert!(ci::timing::Budgets::parse("test:\n  wall_seconds: -1\n").is_err());
    // The repository's budgets parse and cover every step that writes a JUnit
    // report, so each such step is enforced on the Linux runners.
    let repository =
        ci::timing::Budgets::parse(include_str!("../../../.config/test-budgets.yaml")).unwrap();
    for step in Step::ALL
        .into_iter()
        .chain([Step::Archive, Step::LiveDocker, Step::LiveKind])
        .filter(|step| step.junit().is_some())
    {
        assert!(
            repository.get(step.name()).is_some(),
            "{} has no budget in .config/test-budgets.yaml",
            step.name()
        );
    }
    // Each provider's contract binary has a budget across the lifecycle suite.
    for binary in [
        "nemoclaw-provider::contract",
        "openshell-provider::contract",
        "fabric-provider::contract",
    ] {
        assert!(
            repository.binary(binary).is_some(),
            "{binary} has no budget in .config/test-budgets.yaml"
        );
    }
}

// What nextest 0.9 writes when it stops a test at its profile's slow-timeout.
const TIMED_OUT_JUNIT: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="nextest-run" tests="2" skipped="0" failures="1" errors="0" uuid="c63ea36d-14ff-45b3-a2b1-68b75ae7caf4" timestamp="2026-10-11T03:38:03.026-07:00" time="24.012">
    <testsuite name="nemoclaw-sdk" tests="2" skipped="0" errors="0" failures="1">
        <testcase name="state::reads" classname="nemoclaw-sdk" timestamp="2026-10-11T03:38:03.030-07:00" time="0.012"/>
        <testcase name="state::hangs" classname="nemoclaw-sdk" timestamp="2026-10-11T03:38:03.030-07:00" time="24.006">
            <failure type="test timeout"/>
            <system-out>
running 1 test
</system-out>
            <system-err></system-err>
        </testcase>
    </testsuite>
</testsuites>
"#;

#[test]
fn a_test_nextest_stops_is_named_with_its_time_and_limit() {
    let run = ci::timing::Run::parse(TIMED_OUT_JUNIT).unwrap();
    assert!(run.tests[1].failed);
    let budget = ci::timing::Budgets::parse("test:\n  wall_seconds: 45\n  test_seconds: 8\n")
        .unwrap()
        .get("test")
        .unwrap();
    assert_eq!(
        run.over(budget),
        ["nemoclaw-sdk state::hangs took 24.0 s; the limit is 8 s".to_owned()]
    );
}

/// Seconds in a nextest duration that the profiles write as whole seconds.
fn nextest_seconds(duration: &str) -> u64 {
    duration
        .strip_suffix('s')
        .and_then(|seconds| seconds.parse().ok())
        .unwrap_or_else(|| {
            panic!("write the nextest duration {duration:?} in whole seconds, as \"8s\"")
        })
}

/// Check that the nextest `slow-timeout` set by `setting` reports a test as
/// slow after `limit`, the per-test limit of `budget`, and stops it within
/// three times that limit.
fn assert_stops_near_limit(setting: &str, timeout: &toml::Value, budget: &str, limit: u64) {
    let period = nextest_seconds(timeout["period"].as_str().unwrap());
    let terminate_after = timeout
        .get("terminate-after")
        .and_then(toml::Value::as_integer)
        .unwrap_or_else(|| panic!("{setting} never stops a test"));
    assert_eq!(
        period, limit,
        "{setting} reports a test as slow after {period} s, but {budget} allows {limit} s per test"
    );
    assert!(
        (1..=3).contains(&terminate_after),
        "{setting} stops a test after {} s, more than three times the {limit} s limit of {budget}",
        period * terminate_after.unsigned_abs()
    );
}

// Each nextest profile reports a test as slow at its step's per-test limit and
// stops it at a small multiple of that limit: the margin for the platforms and
// local runs that only report budgets. A budgeted test binary's override does
// the same with the binary's limit. Changing a limit in one file and not the
// other fails here.
#[test]
fn each_nextest_profile_stops_a_test_near_its_per_test_limit() {
    let budgets =
        ci::timing::Budgets::parse(include_str!("../../../.config/test-budgets.yaml")).unwrap();
    let nextest: toml::Table = include_str!("../../../.config/nextest.toml")
        .parse()
        .unwrap();
    let profiles = nextest["profile"].as_table().unwrap();
    for step in Step::ALL
        .into_iter()
        .chain([Step::Archive, Step::LiveDocker, Step::LiveKind])
    {
        let Some((profile, _)) = step.junit() else {
            continue;
        };
        let limit = budgets.get(step.name()).unwrap().test_seconds;
        // A profile without its own timeout inherits its parent's.
        let mut name = profile;
        let timeout = loop {
            let table = profiles[name].as_table().unwrap();
            if let Some(timeout) = table.get("slow-timeout") {
                break timeout;
            }
            name = table
                .get("inherits")
                .and_then(toml::Value::as_str)
                .unwrap_or_else(|| panic!("the {profile} nextest profile sets no slow-timeout"));
        };
        assert_stops_near_limit(
            &format!("the {profile} nextest profile"),
            timeout,
            &format!("the {} step", step.name()),
            limit,
        );
    }

    // The budgeted binaries are the providers' contract tests, which only the
    // lifecycle profile runs.
    let (lifecycle, _) = Step::Lifecycle.junit().unwrap();
    let overrides: Vec<(&str, &toml::Value)> = profiles[lifecycle]
        .get("overrides")
        .and_then(toml::Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|entry| Some((entry.get("filter")?.as_str()?, entry.get("slow-timeout")?)))
        .collect();
    let mut budgeted = Vec::new();
    for (binary, budget) in budgets.binaries() {
        let filter = format!("binary_id(={binary})");
        let timeout = overrides
            .iter()
            .find(|(candidate, _)| *candidate == filter)
            .map(|(_, timeout)| *timeout)
            .unwrap_or_else(|| {
                panic!("the {lifecycle} nextest profile has no slow-timeout override with filter {filter:?}")
            });
        assert_stops_near_limit(
            &format!("the {lifecycle} nextest override for {binary}"),
            timeout,
            binary,
            budget.test_seconds,
        );
        budgeted.push(filter);
    }
    for (filter, _) in &overrides {
        assert!(
            budgeted.iter().any(|budgeted| budgeted == filter),
            "the {lifecycle} nextest override with filter {filter:?} has no binary budget in .config/test-budgets.yaml"
        );
    }
}

const RERUN_JUNIT: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="nextest-run" tests="1" failures="0" errors="0" uuid="5b8f75da-b026-4226-b5dc-19f49fa7c054" timestamp="2026-10-09T00:30:00.000+00:00" time="3.000">
    <testsuite name="nemoclaw-sdk::integration" tests="1" disabled="0" errors="0" failures="0">
        <testcase name="deployment::rerun" classname="nemoclaw-sdk::integration" timestamp="2026-10-09T00:30:00.000+00:00" time="2.500"/>
    </testsuite>
</testsuites>
"#;

#[test]
fn junit_reports_of_consecutive_runs_join_into_one_report_of_their_summed_time() {
    let joined = ci::timing::join_consecutive(&[JUNIT.to_owned(), RERUN_JUNIT.to_owned()]).unwrap();
    let run = ci::timing::Run::parse(&joined).unwrap();
    assert_eq!(run.wall_seconds, 15.5);
    assert_eq!(run.tests.len(), 5);
    assert!(run.tests[1].failed);
    assert_eq!(run.tests[4].name, "deployment::rerun");
    assert_eq!(run.tests[4].seconds, 2.5);

    let single = ci::timing::join_consecutive(&[RERUN_JUNIT.to_owned()]).unwrap();
    assert_eq!(ci::timing::Run::parse(&single).unwrap().tests.len(), 1);
    assert!(ci::timing::join_consecutive(&[]).is_err());
    assert!(ci::timing::join_consecutive(&[JUNIT.to_owned(), "<testsuites>".to_owned()]).is_err());
}

#[test]
fn a_partitioned_suite_is_reported_whole_from_the_latest_attempt_of_each_partition() {
    let directory = tempfile::tempdir().unwrap();
    for (artifact, xml) in [
        // Shard 1 was rerun: its second attempt replaces the first.
        ("lifecycle-linux_amd64-1-1", JUNIT),
        ("lifecycle-linux_amd64-1-2", RERUN_JUNIT),
        ("lifecycle-linux_amd64-2-1", JUNIT),
        // Other platforms and artifacts are not this suite's partitions.
        ("lifecycle-linux_arm64-3-1", JUNIT),
        ("lifecycle-inputs-linux_amd64-abc-1", JUNIT),
    ] {
        let artifact = directory.path().join(artifact);
        std::fs::create_dir(&artifact).unwrap();
        std::fs::write(artifact.join("lifecycle.xml"), xml).unwrap();
    }

    let budgets =
        ci::timing::Budgets::parse("lifecycle:\n  wall_seconds: 300\n  test_seconds: 90\n")
            .unwrap();
    let report =
        ci::timing::partitioned_report(directory.path(), "linux_amd64", &[1, 2, 3], 3, &budgets)
            .unwrap()
            .report;
    // Partitions run in parallel, so the suite's wall time is its slowest partition's.
    assert!(
        report.contains(
            "### lifecycle on linux_amd64, 3 partitions: 5 tests, 12.5 s wall, 15.0 s summed"
        ),
        "{report}"
    );
    assert!(report.contains("| 1 | 2 | 1 | 3.0 s | 2.5 s |"), "{report}");
    assert!(
        report.contains("| 2 | 1 | 4 | 12.5 s | 12.5 s |"),
        "{report}"
    );
    // A partition that uploaded no report is named, so the totals cannot mislead.
    assert!(report.contains("| 3 | | | | no JUnit report |"), "{report}");
    assert!(
        report.contains("| 9.2 s | nemoclaw-e2e::integration deployment::slow_scenario |"),
        "{report}"
    );
    assert!(
        report.contains("| 2.5 s | nemoclaw-sdk::integration deployment::rerun |"),
        "{report}"
    );

    std::fs::write(
        directory
            .path()
            .join("lifecycle-linux_amd64-2-1/lifecycle.xml"),
        "<testsuites>",
    )
    .unwrap();
    assert!(
        ci::timing::partitioned_report(directory.path(), "linux_amd64", &[1, 2], 3, &budgets)
            .unwrap_err()
            .contains("lifecycle-linux_amd64-2-1")
    );
}

const CONTRACT_JUNIT_1: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="nextest-run" tests="2" failures="0" errors="0" uuid="6c9a86eb-c137-4337-86ed-2a5a0b6c1d65" timestamp="2026-10-09T00:40:00.000+00:00" time="7.000">
    <testsuite name="nemoclaw-provider::contract" tests="1" disabled="0" errors="0" failures="0">
        <testcase name="service::applies" classname="nemoclaw-provider::contract" timestamp="2026-10-09T00:40:00.000+00:00" time="6.000"/>
    </testsuite>
    <testsuite name="openshell-provider::contract" tests="1" disabled="0" errors="0" failures="0">
        <testcase name="sandbox::reads" classname="openshell-provider::contract" timestamp="2026-10-09T00:40:00.000+00:00" time="2.000"/>
    </testsuite>
</testsuites>
"#;

const CONTRACT_JUNIT_2: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="nextest-run" tests="2" failures="0" errors="0" uuid="7d0b97fc-d248-4448-97fe-3b6b1c7d2e76" timestamp="2026-10-09T00:40:00.000+00:00" time="6.000">
    <testsuite name="nemoclaw-provider::contract" tests="1" disabled="0" errors="0" failures="0">
        <testcase name="service::destroys" classname="nemoclaw-provider::contract" timestamp="2026-10-09T00:40:00.000+00:00" time="5.000"/>
    </testsuite>
    <testsuite name="nemoclaw-e2e::integration" tests="1" disabled="0" errors="0" failures="0">
        <testcase name="deployment::applies" classname="nemoclaw-e2e::integration" timestamp="2026-10-09T00:40:00.000+00:00" time="5.500"/>
    </testsuite>
</testsuites>
"#;

#[test]
fn binary_budgets_bound_each_binary_summed_across_partitions_and_each_of_its_tests() {
    let budgets = ci::timing::Budgets::parse(
        "lifecycle:\n  wall_seconds: 300\n  test_seconds: 90\nbinaries:\n  nemoclaw-provider::contract:\n    summed_seconds: 10\n    test_seconds: 6\n  openshell-provider::contract:\n    summed_seconds: 10\n    test_seconds: 1\n  fabric-provider::contract:\n    summed_seconds: 30\n    test_seconds: 20\n",
    )
    .unwrap();
    // Binary budgets sit beside the step budgets without becoming a step.
    assert_eq!(budgets.get("lifecycle").unwrap().wall_seconds, 300);
    assert!(budgets.get("binaries").is_none());
    assert!(
        ci::timing::Budgets::parse(
            "binaries:\n  nemoclaw-provider::contract:\n    wall_seconds: 10\n    test_seconds: 6\n"
        )
        .is_err()
    );

    let directory = tempfile::tempdir().unwrap();
    for (artifact, xml) in [
        ("lifecycle-linux_amd64-1-1", CONTRACT_JUNIT_1),
        ("lifecycle-linux_amd64-2-1", CONTRACT_JUNIT_2),
    ] {
        let artifact = directory.path().join(artifact);
        std::fs::create_dir(&artifact).unwrap();
        std::fs::write(artifact.join("lifecycle.xml"), xml).unwrap();
    }
    let timing =
        ci::timing::partitioned_report(directory.path(), "linux_amd64", &[1, 2], 3, &budgets)
            .unwrap();
    // A binary's tests count wherever its partitions ran them; a test exactly
    // at its limit is within it.
    assert_eq!(
        timing.over,
        [
            "nemoclaw-provider::contract: 11.0 s summed exceeds the 10 s budget".to_owned(),
            "openshell-provider::contract sandbox::reads took 2.0 s; the limit is 1 s".to_owned(),
        ]
    );
    let report = &timing.report;
    assert!(
        report.contains("| nemoclaw-provider::contract | 2 | 11.0 s | 10 s | 6.0 s | 6 s |"),
        "{report}"
    );
    assert!(
        report.contains("| openshell-provider::contract | 1 | 2.0 s | 10 s | 2.0 s | 1 s |"),
        "{report}"
    );
    // A budgeted binary without tests in the reports is shown, not skipped.
    assert!(
        report.contains("| fabric-provider::contract | 0 | 0.0 s | 30 s | | 20 s |"),
        "{report}"
    );
    // Without binary budgets, the report has no budget table and nothing is over.
    let unbudgeted =
        ci::timing::Budgets::parse("lifecycle:\n  wall_seconds: 300\n  test_seconds: 90\n")
            .unwrap();
    let timing =
        ci::timing::partitioned_report(directory.path(), "linux_amd64", &[1, 2], 3, &unbudgeted)
            .unwrap();
    assert!(timing.over.is_empty());
    assert!(
        !timing
            .report
            .contains("| Binary | Tests | Summed | Budget |"),
        "{}",
        timing.report
    );
}
