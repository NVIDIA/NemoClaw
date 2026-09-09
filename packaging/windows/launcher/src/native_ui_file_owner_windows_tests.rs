// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::*;
use std::os::windows::fs::MetadataExt;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

static NEXT_FIXTURE: AtomicU64 = AtomicU64::new(0);
const STREAM: &str = "stream-0123456789abcdef";

#[link(name = "kernel32")]
unsafe extern "system" {
    fn MoveFileExW(existing: *const u16, target: *const u16, flags: u32) -> i32;
}

fn wide_path(path: &Path) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    path.as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

struct Fixture {
    owner: Option<Owner>,
    base: PathBuf,
    root: PathBuf,
    secret: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let drive = std::env::var("SystemDrive").unwrap();
        assert!(drive.len() == 2 && drive.ends_with(':'));
        let base = PathBuf::from(format!(
            "{drive}\\NemoClawUiOwnerQualification-{}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            NEXT_FIXTURE.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir(&base).unwrap();
        let root = base.join("relay");
        let owner = Owner::new(root.as_os_str()).unwrap();
        let control = base.join("host-only");
        std::fs::create_dir(&control).unwrap();
        let secret = control.join("native-windows.json");
        std::fs::write(&secret, b"host-only configuration marker").unwrap();
        Self {
            owner: Some(owner),
            base,
            root,
            secret,
        }
    }

    fn owner(&mut self) -> &mut Owner {
        self.owner.as_mut().unwrap()
    }

    fn assert_secret(&self) {
        assert_eq!(
            std::fs::read(&self.secret).unwrap(),
            b"host-only configuration marker"
        );
    }
}

fn remove_fixture(path: &Path) {
    let Ok(metadata) = std::fs::symlink_metadata(path) else {
        return;
    };
    if metadata.file_attributes() & REPARSE != 0 {
        let _ = if metadata.is_dir() {
            std::fs::remove_dir(path)
        } else {
            std::fs::remove_file(path)
        };
    } else if metadata.is_dir() {
        for child in std::fs::read_dir(path).unwrap() {
            remove_fixture(&child.unwrap().path());
        }
        std::fs::remove_dir(path).unwrap();
    } else {
        std::fs::remove_file(path).unwrap();
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        drop(self.owner.take());
        // Only freshly created qualification fixtures; never follow a junction
        // and never address user-agent state or application configuration.
        remove_fixture(&self.base);
    }
}

fn junction(link: &Path, target: &Path) {
    let system = std::env::var("SystemRoot").unwrap();
    let result = std::process::Command::new(Path::new(&system).join("System32\\cmd.exe"))
        .args(["/d", "/c", "mklink", "/J"])
        .arg(link)
        .arg(target)
        .creation_flags(0x0800_0000)
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "The real NTFS junction fixture must be available"
    );
}

#[test]
fn relay_round_trip_uses_atomic_files_and_supports_empty_frames() {
    let mut fixture = Fixture::new();
    let owner = fixture.owner();
    assert_eq!(owner.command("read\tready").unwrap(), "MISS");
    assert_eq!(owner.command(&format!("mkdir\t{STREAM}")).unwrap(), "OK");
    assert_eq!(owner.command(&format!("list\t{STREAM}")).unwrap(), "OK\t");
    assert_eq!(
        owner
            .command(&format!("write\t{STREAM}/open\t{}", encode(b"relay-token")))
            .unwrap(),
        "OK"
    );
    assert_eq!(
        owner.command(&format!("read\t{STREAM}/open")).unwrap(),
        format!("OK\t{}", encode(b"relay-token"))
    );
    assert_eq!(
        owner
            .command(&format!("write\t{STREAM}/host-close\t"))
            .unwrap(),
        "OK"
    );
    assert_eq!(
        owner
            .command(&format!("read\t{STREAM}/host-close"))
            .unwrap(),
        "OK\t"
    );
    assert_eq!(
        owner.command(&format!("list\t{STREAM}")).unwrap(),
        "OK\thost-close,open"
    );
    assert_eq!(
        owner.command(&format!("unlink\t{STREAM}/open")).unwrap(),
        "OK"
    );
    assert_eq!(
        owner.command(&format!("read\t{STREAM}/open")).unwrap(),
        "MISS"
    );
    assert_eq!(owner.command(&format!("release\t{STREAM}")).unwrap(), "OK");
    assert!(
        owner
            .command(&format!("read\t{STREAM}/host-close"))
            .is_err()
    );
    fixture.assert_secret();
}

#[test]
fn only_one_host_owner_can_open_a_relay_root() {
    let mut fixture = Fixture::new();
    assert!(Owner::new(fixture.root.as_os_str()).is_err());
    drop(fixture.owner.take());
    fixture.owner = Some(Owner::new(fixture.root.as_os_str()).unwrap());
}

fn assert_rejects_reopened_permissions(arguments: &[&str]) {
    let mut fixture = Fixture::new();
    drop(fixture.owner.take());
    let system = std::env::var("SystemRoot").unwrap();
    let result = std::process::Command::new(Path::new(&system).join("System32\\icacls.exe"))
        .arg(&fixture.root)
        .args(arguments)
        .creation_flags(0x0800_0000)
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "The owned permission fixture must be available"
    );
    assert!(matches!(
        Owner::new(fixture.root.as_os_str()),
        Err("private-permissions")
    ));
    fixture.assert_secret();
}

#[test]
fn relay_reuse_rejects_an_extra_everyone_read_grant() {
    assert_rejects_reopened_permissions(&["/grant", "*S-1-1-0:(OI)(CI)(R)"]);
}

#[test]
fn relay_reuse_rejects_unprotected_inherited_permissions() {
    assert_rejects_reopened_permissions(&["/inheritance:e"]);
}

#[test]
fn stream_limit_counts_live_handles_and_release_permits_new_connections() {
    let mut fixture = Fixture::new();
    for index in 0..128 {
        fixture
            .owner()
            .mkdir(&format!("stream-{index:016x}"))
            .unwrap();
    }
    assert!(fixture.owner().mkdir("stream-0000000000000080").is_err());
    fixture
        .owner()
        .command("release\tstream-0000000000000000")
        .unwrap();
    fixture.owner().mkdir("stream-0000000000000080").unwrap();
}

#[test]
fn live_root_ancestors_and_streams_cannot_be_replaced() {
    let mut fixture = Fixture::new();
    fixture.owner().mkdir(STREAM).unwrap();
    assert!(std::fs::rename(&fixture.root, fixture.base.join("replaced-root")).is_err());
    assert!(
        std::fs::rename(
            fixture.root.join(STREAM),
            fixture.root.join("replaced-stream")
        )
        .is_err()
    );
    assert!(std::fs::rename(&fixture.base, fixture.base.with_extension("moved")).is_err());
    fixture.assert_secret();
}

#[test]
fn existing_ntfs_junctions_cannot_redirect_root_or_stream_creation() {
    let mut fixture = Fixture::new();
    let linked_stream = fixture.root.join(STREAM);
    junction(&linked_stream, fixture.secret.parent().unwrap());
    assert!(fixture.owner().mkdir(STREAM).is_err());
    let linked_ancestor = fixture.base.join("linked-parent");
    junction(&linked_ancestor, fixture.secret.parent().unwrap());
    assert!(Owner::new(linked_ancestor.join("relay").as_os_str()).is_err());
    assert!(!fixture.secret.parent().unwrap().join("relay").exists());
    fixture.assert_secret();
}

#[test]
fn file_symlinks_cannot_redirect_reads_writes_or_unlinks() {
    let mut fixture = Fixture::new();
    fixture.owner().mkdir(STREAM).unwrap();
    let relative = format!("{STREAM}/sandbox-0000000001.bin");
    let link = fixture.root.join(STREAM).join("sandbox-0000000001.bin");
    std::os::windows::fs::symlink_file(&fixture.secret, &link).unwrap();
    assert!(fixture.owner().read(&relative).is_err());
    assert!(
        fixture
            .owner()
            .write(&relative, b"must not replace host configuration")
            .is_err()
    );
    assert!(fixture.owner().unlink(&relative).is_err());
    assert!(fixture.owner().list(STREAM).is_err());
    fixture.assert_secret();
}

#[test]
fn hard_links_and_oversized_frames_are_rejected() {
    let mut fixture = Fixture::new();
    fixture.owner().mkdir(STREAM).unwrap();
    let linked = fixture.root.join(STREAM).join("sandbox-0000000001.bin");
    std::fs::hard_link(&fixture.secret, &linked).unwrap();
    assert!(
        fixture
            .owner()
            .read(&format!("{STREAM}/sandbox-0000000001.bin"))
            .is_err()
    );
    assert!(
        fixture
            .owner()
            .unlink(&format!("{STREAM}/sandbox-0000000001.bin"))
            .is_err()
    );
    let oversized = fixture.root.join(STREAM).join("sandbox-0000000002.bin");
    std::fs::write(&oversized, vec![42; MAX_CHUNK + 1]).unwrap();
    assert!(
        fixture
            .owner()
            .read(&format!("{STREAM}/sandbox-0000000002.bin"))
            .is_err()
    );
    fixture.assert_secret();
}

#[test]
fn an_external_full_path_rename_is_rejected_without_weakening_directory_guards() {
    let mut fixture = Fixture::new();
    fixture.owner().mkdir(STREAM).unwrap();
    let temporary = fixture.root.join(STREAM).join("candidate-frame.tmp");
    let target = fixture.root.join(STREAM).join("sandbox-0000000001.bin");
    std::fs::write(&temporary, b"complete frame").unwrap();
    // This is the Win32 operation used by ordinary Node/Python full-path
    // rename. Its target-directory write-open conflicts with the held guard.
    // The contained publisher therefore uses exclusive create/flush/close.
    assert_eq!(
        unsafe {
            MoveFileExW(
                wide_path(&temporary).as_ptr(),
                wide_path(&target).as_ptr(),
                1,
            )
        },
        0
    );
    assert!(temporary.exists());
    assert!(!target.exists());
    fixture.assert_secret();
}

#[test]
fn an_external_writer_is_missed_until_its_complete_frame_is_closed() {
    let mut fixture = Fixture::new();
    fixture.owner().mkdir(STREAM).unwrap();
    let relative = format!("{STREAM}/sandbox-0000000001.bin");
    let target = fixture.root.join(STREAM).join("sandbox-0000000001.bin");
    let mut writer = std::fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&target)
        .unwrap();
    writer.write_all(b"complete ").unwrap();
    assert_eq!(fixture.owner().read(&relative).unwrap(), None);
    writer.write_all(b"frame").unwrap();
    writer.sync_all().unwrap();
    assert_eq!(fixture.owner().read(&relative).unwrap(), None);
    drop(writer);
    assert_eq!(
        fixture.owner().read(&relative).unwrap(),
        Some(b"complete frame".to_vec())
    );
    fixture.assert_secret();
}

#[test]
fn external_node_style_readers_see_complete_publication_before_writer_handle_drop() {
    let mut fixture = Fixture::new();
    fixture.owner().mkdir(STREAM).unwrap();
    let relative = format!("{STREAM}/host-0000000001.bin");
    let target = fixture.root.join(STREAM).join("host-0000000001.bin");
    fixture
        .owner()
        .write_then(&relative, b"complete published frame", move || {
            // Run after atomic publication while the original write/delete handle
            // is definitely still open, rather than sampling a tiny race window.
            std::thread::spawn(move || {
                for _ in 0..100 {
                    if std::fs::read(&target).map_err(|_| "external-read")?
                        != b"complete published frame"
                    {
                        return Err("partial-read");
                    }
                }
                Ok(())
            })
            .join()
            .map_err(|_| "reader-thread")?
        })
        .unwrap();
    fixture.assert_secret();
}
