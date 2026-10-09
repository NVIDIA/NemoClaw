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
    });
    let value: serde_json::Value = serde_saphyr::from_str(&document).unwrap();
    assert_eq!(value["metadata"]["uid"], first.as_str());
    assert_eq!(value["spec"]["gateway"]["management"], "managed");
    assert_eq!(
        value["spec"]["gateway"]["endpoint"],
        "http://127.0.0.1:17950"
    );
    assert_eq!(value["spec"]["gateway"]["networkCIDR"], chosen.as_str());
    assert_eq!(
        value["spec"]["sandboxes"][0]["image"]["ref"],
        "nc-live@sha256:abc"
    );
    assert_eq!(
        value["spec"]["sandboxes"][0]["harness"]["kind"],
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
    });
    let parsed = nemoclaw_sdk::config::Document::parse(document.as_bytes()).unwrap();
    assert_eq!(
        parsed.spec.gateway.runtime().provider,
        nemoclaw_sdk::config::ComputeDriver::Docker
    );
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

const JUNIT: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="nextest-run" tests="4" failures="1" errors="0" uuid="u" timestamp="2026-10-09T00:20:53.957+00:00" time="12.500">
    <testsuite name="nemoclaw-e2e::integration" tests="3" disabled="0" errors="0" failures="1">
        <testcase name="deployment::slow_scenario" classname="nemoclaw-e2e::integration" timestamp="t" time="9.250">
        </testcase>
        <testcase name="deployment::quick &amp; &quot;quoted&quot;" classname="nemoclaw-e2e::integration" timestamp="t" time="0.750">
            <failure type="test failure">failed</failure>
        </testcase>
        <testcase name="service_storage::applies" classname="nemoclaw-e2e::integration" timestamp="t" time="2.000"/>
    </testsuite>
    <testsuite name="nemoclaw-sdk" tests="1" disabled="0" errors="0" failures="0">
        <testcase name="state::reads" classname="nemoclaw-sdk" timestamp="t" time="0.500"/>
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
