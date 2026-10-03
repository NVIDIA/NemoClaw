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
