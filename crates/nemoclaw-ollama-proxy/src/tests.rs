// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use super::*;
use std::os::unix::fs::{PermissionsExt, symlink};

fn settings(upstream: &str) -> Settings {
    Settings {
        endpoint: "http://127.0.0.1:0/v1".into(),
        upstream: upstream.into(),
        model: "qwen3:4b".into(),
        digest: "a".repeat(64),
    }
}

#[test]
fn upstream_must_be_a_loopback_http_v1_address() {
    assert!(settings("http://127.0.0.1:11434/v1").upstream().is_ok());
    assert!(settings("http://[::1]:11434/v1").upstream().is_ok());
    for rejected in [
        "https://127.0.0.1:11434/v1",
        "http://10.0.0.1:11434/v1",
        "http://localhost:11434/v1",
        "http://127.0.0.1:11434/v1/",
        "http://127.0.0.1:11434/api",
        "http://127.0.0.1:11434/v1?x=1",
        "http://127.0.0.1:11434/v1#x",
        "http://user:pass@127.0.0.1:11434/v1",
        "http://127.0.0.1/v1",
    ] {
        assert_eq!(
            settings(rejected).upstream().unwrap_err(),
            INVALID,
            "{rejected}"
        );
    }
    let mut invalid = settings("http://127.0.0.1:11434/v1");
    invalid.digest = "A".repeat(64);
    assert!(invalid.upstream().is_err());
    invalid.digest = "a".repeat(64);
    invalid.model.clear();
    assert!(invalid.upstream().is_err());
}

#[test]
fn the_key_survives_restarts_and_is_never_regenerated() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("data");
    let key = load_key(&root).unwrap();
    assert!(lowercase_hex(&key, 64));
    assert_eq!(load_key(&root).unwrap(), key);
    let metadata = fs::metadata(root.join("inference-key")).unwrap();
    assert_eq!(metadata.permissions().mode() & 0o777, 0o600);
    assert_eq!(
        fs::metadata(&root).unwrap().permissions().mode() & 0o777,
        0o700
    );
    fs::remove_file(root.join("inference-key")).unwrap();
    assert!(
        load_key(&root)
            .unwrap_err()
            .0
            .contains("regeneration forbidden")
    );
}

#[test]
fn an_existing_volume_from_the_python_proxy_keeps_its_key() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path();
    let key = "0123456789abcdef".repeat(4);
    fs::write(root.join("inference-key"), &key).unwrap();
    fs::set_permissions(
        root.join("inference-key"),
        fs::Permissions::from_mode(0o600),
    )
    .unwrap();
    fs::write(root.join("initialized"), b"").unwrap();
    assert_eq!(load_key(root).unwrap(), key);
}

#[test]
fn unsafe_key_files_are_rejected() {
    let key = "0123456789abcdef".repeat(4);
    let prepare = || {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("inference-key");
        fs::write(&path, &key).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        (directory, path)
    };
    let (readable, path) = prepare();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
    assert!(load_key(readable.path()).is_err());

    let (linked, path) = prepare();
    fs::hard_link(&path, linked.path().join("second")).unwrap();
    assert!(load_key(linked.path()).is_err());

    let (short, path) = prepare();
    fs::write(&path, &key[..63]).unwrap();
    assert!(load_key(short.path()).is_err());

    let (uppercase, path) = prepare();
    fs::write(&path, key.to_uppercase()).unwrap();
    assert!(load_key(uppercase.path()).is_err());

    let (symlinked, path) = prepare();
    fs::rename(&path, symlinked.path().join("target")).unwrap();
    symlink(symlinked.path().join("target"), &path).unwrap();
    assert!(load_key(symlinked.path()).is_err());
}

fn proc_net(tcp: &[&str], tcp6: Option<&[&str]>) -> tempfile::TempDir {
    let directory = tempfile::tempdir().unwrap();
    let table = |rows: &[&str]| {
        let mut text = String::from("  sl  local_address rem_address   st\n");
        for (index, row) in rows.iter().enumerate() {
            text.push_str(&format!("   {index}: {row} 00000000:0000 0A\n"));
        }
        text
    };
    fs::write(directory.path().join("tcp"), table(tcp)).unwrap();
    if let Some(rows) = tcp6 {
        fs::write(directory.path().join("tcp6"), table(rows)).unwrap();
    }
    directory
}

fn word(bytes: [u8; 4]) -> String {
    format!("{:08X}", u32::from_ne_bytes(bytes))
}

#[test]
fn only_loopback_listeners_on_the_daemon_port_are_accepted() {
    let loopback = format!("{}:2CA2", word([127, 0, 0, 1]));
    let any = format!("{}:2CA2", word([0, 0, 0, 0]));
    let elsewhere = format!("{}:1F90", word([0, 0, 0, 0]));
    let ipv6_loopback = format!(
        "{}{}{}{}:2CA2",
        word([0; 4]),
        word([0; 4]),
        word([0; 4]),
        word([0, 0, 0, 1])
    );
    let mapped = format!(
        "{}{}{}{}:2CA2",
        word([0; 4]),
        word([0; 4]),
        word([0, 0, 0xff, 0xff]),
        word([127, 0, 0, 1])
    );
    let port = 0x2CA2;
    assert!(loopback_listener(proc_net(&[&loopback, &elsewhere], None).path(), port).is_ok());
    assert!(loopback_listener(proc_net(&[], Some(&[&ipv6_loopback])).path(), port).is_ok());
    assert!(loopback_listener(proc_net(&[], Some(&[&mapped])).path(), port).is_ok());
    assert!(
        loopback_listener(proc_net(&[&loopback, &any], None).path(), port)
            .unwrap_err()
            .0
            .contains("only on loopback")
    );
    assert_eq!(
        loopback_listener(proc_net(&[&elsewhere], Some(&[])).path(), port).unwrap_err(),
        LISTENER
    );
}

#[test]
fn credentials_compare_without_shortcuts() {
    assert!(same(b"Bearer abc", b"Bearer abc"));
    assert!(!same(b"Bearer abc", b"Bearer abd"));
    assert!(!same(b"Bearer abc", b"Bearer ab"));
}
