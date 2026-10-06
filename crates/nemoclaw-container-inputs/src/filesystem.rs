// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Descriptor-relative publication; no shell, symlink traversal, or health mutation.
#![cfg_attr(not(target_os = "linux"), allow(dead_code))]
use super::*;
use rustix::{
    fd::OwnedFd,
    fs::{self, Mode, OFlags},
    process::{Gid, Uid},
};
use std::{
    io::{Read, Write},
    path::Path,
};
type AclCheck = fn(&OwnedFd) -> Result<()>;
const UNSAFE: &str = "protected input filesystem binding is unsafe";
const IO: &str = "protected input filesystem operation failed";
fn acl(fd: &OwnedFd) -> Result<()> {
    #[cfg(target_os = "linux")]
    {
        for name in ["system.posix_acl_access", "system.posix_acl_default"] {
            let mut bytes = [0u8; 4096];
            match fs::fgetxattr(fd, name, &mut bytes[..]) {
                Err(rustix::io::Errno::NODATA) => {}
                Ok(0) => {}
                // Unsupported checks, extended access ACLs and default ACLs all fail closed.
                _ => return Err(UNSAFE),
            }
        }
        Ok(())
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = fd;
        Err("protected input ACL verification requires Linux")
    }
}
fn open(parent: &OwnedFd, name: &str, directory: bool) -> Result<Option<OwnedFd>> {
    let flags = OFlags::RDONLY
        | OFlags::NOFOLLOW
        | OFlags::CLOEXEC
        | OFlags::NONBLOCK
        | if directory {
            OFlags::DIRECTORY
        } else {
            OFlags::empty()
        };
    match fs::openat(parent, name, flags, Mode::empty()) {
        Ok(fd) => Ok(Some(fd)),
        Err(rustix::io::Errno::NOENT) => Ok(None),
        _ => Err(UNSAFE),
    }
}
fn owned(
    fd: &OwnedFd,
    request: &Request,
    directory: bool,
    device: fs::Dev,
    check: AclCheck,
) -> Result<fs::Stat> {
    let stat = fs::fstat(fd).map_err(|_| IO)?;
    if stat.st_dev != device
        || stat.st_uid != request.uid
        || stat.st_gid != request.gid
        || stat.st_mode & 0o7777 != if directory { 0o700 } else { 0o600 }
        || fs::FileType::from_raw_mode(stat.st_mode)
            != if directory {
                fs::FileType::Directory
            } else {
                fs::FileType::RegularFile
            }
        || (!directory && stat.st_nlink != 1)
    {
        return Err(UNSAFE);
    }
    check(fd)?;
    Ok(stat)
}
fn content(fd: OwnedFd, limit: usize) -> Result<Vec<u8>> {
    let before = fs::fstat(&fd).map_err(|_| IO)?;
    if before.st_size < 1 || before.st_size as u64 > limit as u64 {
        return Err(UNSAFE);
    }
    let mut file = std::fs::File::from(fd);
    let mut bytes = Vec::new();
    Read::by_ref(&mut file)
        .take(limit as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| IO)?;
    let after = fs::fstat(&file).map_err(|_| IO)?;
    if bytes.len() != before.st_size as usize
        || before.st_size != after.st_size
        || before.st_ino != after.st_ino
        || before.st_dev != after.st_dev
        || before.st_mtime != after.st_mtime
        || before.st_mtime_nsec != after.st_mtime_nsec
        || before.st_ctime != after.st_ctime
        || before.st_ctime_nsec != after.st_ctime_nsec
        || before.st_uid != after.st_uid
        || before.st_gid != after.st_gid
        || before.st_mode != after.st_mode
        || before.st_nlink != after.st_nlink
    {
        return Err(UNSAFE);
    }
    Ok(bytes)
}
pub(super) fn run(root_path: &Path, uid: u32, gid: u32) -> Result<()> {
    if uid == 0 || gid == 0 || uid > 999_999_999 || gid > 999_999_999 {
        return Err("protected input setup arguments are invalid");
    }
    let root = fs::open(
        root_path,
        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::empty(),
    )
    .map_err(|_| UNSAFE)?;
    let bootstrap = Request {
        uid,
        gid,
        completion: Completion {
            revision: String::new(),
            sandbox_id: String::new(),
        },
        files: vec![],
    };
    root_identity(&root, &bootstrap, acl)?;
    // No credential crosses the Docker attach boundary until ACL and root
    // ownership checks succeed. This constant handshake is not a diagnostic.
    let mut stdout = std::io::stdout();
    stdout.write_all(b"ready\n").map_err(|_| IO)?;
    stdout.flush().map_err(|_| IO)?;
    let mut bytes = Vec::new();
    std::io::stdin()
        .take(MAX_REQUEST_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| IO)?;
    let request = parse(&bytes)?;
    if request.uid != uid || request.gid != gid {
        return Err(UNSAFE);
    }
    publish(&root, &request, acl)
}
fn root_identity(root: &OwnedFd, request: &Request, check: AclCheck) -> Result<fs::Dev> {
    let stat = fs::fstat(root).map_err(|_| IO)?;
    check(root)?;
    if stat.st_uid == 0 && stat.st_gid == 0 && [0o700, 0o755].contains(&(stat.st_mode & 0o7777)) {
        // A fresh Docker NoCopy volume must be empty.
        // Never repair an insecure existing application tree by changing its root mode.
        let entries = fs::Dir::read_from(root).map_err(|_| IO)?;
        for (index, entry) in entries.enumerate() {
            if index > 256 {
                return Err(UNSAFE);
            }
            let entry = entry.map_err(|_| IO)?;
            let name = entry.file_name().to_str().map_err(|_| UNSAFE)?;
            if name == "." || name == ".." {
                continue;
            }
            return Err(UNSAFE);
        }
        fs::fchmod(root, Mode::from_raw_mode(0o700)).map_err(|_| IO)?;
        fs::fchown(
            root,
            Some(Uid::from_raw(request.uid)),
            Some(Gid::from_raw(request.gid)),
        )
        .map_err(|_| IO)?;
    }
    owned(root, request, true, stat.st_dev, check)?;
    Ok(stat.st_dev)
}
fn parent(
    root: &OwnedFd,
    path: &str,
    request: &Request,
    device: fs::Dev,
    create: bool,
    check: AclCheck,
) -> Result<(OwnedFd, String)> {
    let mut fd = fs::openat(
        root,
        ".",
        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::empty(),
    )
    .map_err(|_| IO)?;
    let mut parts = path.split('/').peekable();
    while let Some(part) = parts.next() {
        if parts.peek().is_none() {
            return Ok((fd, part.into()));
        }
        owned(&fd, request, true, device, check)?;
        let child = match open(&fd, part, true)? {
            Some(child) => child,
            None if create => {
                fs::mkdirat(&fd, part, Mode::from_raw_mode(0o700)).map_err(|_| IO)?;
                let child = open(&fd, part, true)?.ok_or(UNSAFE)?;
                check(&child)?;
                fs::fchown(
                    &child,
                    Some(Uid::from_raw(request.uid)),
                    Some(Gid::from_raw(request.gid)),
                )
                .map_err(|_| IO)?;
                fs::fchmod(&child, Mode::from_raw_mode(0o700)).map_err(|_| IO)?;
                fs::fsync(&fd).map_err(|_| IO)?;
                child
            }
            None => return Err(UNSAFE),
        };
        owned(&child, request, true, device, check)?;
        fd = child;
    }
    Err(UNSAFE)
}
fn atomic_file(
    parent: &OwnedFd,
    name: &str,
    bytes: &[u8],
    request: &Request,
    device: fs::Dev,
    check: AclCheck,
) -> Result<()> {
    owned(parent, request, true, device, check)?;
    if let Some(fd) = open(parent, name, false)? {
        owned(&fd, request, false, device, check)?;
    }
    let mut nonce = [0u8; 16];
    getrandom::fill(&mut nonce).map_err(|_| IO)?;
    let suffix: String = nonce.iter().map(|b| format!("{b:02x}")).collect();
    let stage = format!(".nemoclaw-inputs-write-{suffix}");
    let fd = fs::openat(
        parent,
        &stage,
        OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::from_raw_mode(0o600),
    )
    .map_err(|_| IO)?;
    let mut file = std::fs::File::from(fd);
    let result = (|| {
        let fd = fs::openat(
            parent,
            &stage,
            OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::empty(),
        )
        .map_err(|_| UNSAFE)?;
        let observed = fs::fstat(&fd).map_err(|_| IO)?;
        let expected = fs::fstat(&file).map_err(|_| IO)?;
        if observed.st_ino != expected.st_ino || observed.st_dev != expected.st_dev {
            return Err(UNSAFE);
        }
        check(&fd)?;
        file.write_all(bytes).map_err(|_| IO)?;
        fs::fchown(
            &file,
            Some(Uid::from_raw(request.uid)),
            Some(Gid::from_raw(request.gid)),
        )
        .map_err(|_| IO)?;
        fs::fchmod(&file, Mode::from_raw_mode(0o600)).map_err(|_| IO)?;
        fs::fsync(&file).map_err(|_| IO)?;
        owned(&fd, request, false, device, check)?;
        // The provider excludes a running application throughout incomplete delivery.
        // Recheck the destination at publication, without following a replaced leaf.
        if let Some(old) = open(parent, name, false)? {
            owned(&old, request, false, device, check)?;
        }
        fs::renameat(parent, &stage, parent, name).map_err(|_| IO)?;
        fs::fsync(parent).map_err(|_| IO)?;
        Ok(())
    })();
    if result.is_err() {
        // A failed write may remain only in the owned protected volume. Remove
        // our staging inode when its directory entry still binds that same file.
        if let Ok(actual) = fs::statat(parent, &stage, fs::AtFlags::SYMLINK_NOFOLLOW)
            && let Ok(expected) = fs::fstat(&file)
            && actual.st_ino == expected.st_ino
            && actual.st_dev == expected.st_dev
        {
            let _ = fs::unlinkat(parent, &stage, fs::AtFlags::empty());
        }
    }
    result
}
fn publish(root: &OwnedFd, request: &Request, check: AclCheck) -> Result<()> {
    request.validate()?;
    let device = root_identity(root, request, check)?;
    let completion = request.completion_bytes();
    let existing_marker = open(root, MARKER, false)?;
    let complete = if let Some(fd) = existing_marker {
        owned(&fd, request, false, device, check)?;
        if content(fd, 4096)? != completion {
            return Err(UNSAFE);
        }
        true
    } else {
        false
    };
    let mut files = Vec::new();
    for input in &request.files {
        let (parent, name) = parent(root, &input.path, request, device, !complete, check)?;
        if let Some(fd) = open(&parent, &name, false)? {
            owned(&fd, request, false, device, check)?;
            let bytes = content(
                fd,
                if input.role == Role::Credential {
                    MAX_CREDENTIAL_BYTES
                } else {
                    MAX_DESCRIPTOR_BYTES
                },
            )?;
            if complete && bytes != input.content.as_bytes() {
                return Err(UNSAFE);
            }
        } else if complete {
            return Err(UNSAFE);
        }
        files.push((parent, name, input.content.as_bytes()));
    }
    if !complete {
        for (parent, name, bytes) in files {
            atomic_file(&parent, &name, bytes, request, device, check)?;
        }
    }
    if !complete {
        atomic_file(root, MARKER, &completion, request, device, check)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    fn fixture() -> (tempfile::TempDir, OwnedFd, Request) {
        let directory = tempfile::tempdir().unwrap();
        let root = fs::open(
            directory.path(),
            OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::empty(),
        )
        .unwrap();
        let uid = rustix::process::getuid().as_raw();
        let gid = rustix::process::getgid().as_raw();
        if uid != 0 {
            fs::fchown(&root, Some(Uid::from_raw(uid)), Some(Gid::from_raw(gid))).unwrap();
            fs::fchmod(&root, Mode::from_raw_mode(0o700)).unwrap();
        }
        let request = Request {
            uid: if uid == 0 { 65532 } else { uid },
            gid: if gid == 0 { 65532 } else { gid },
            completion: Completion {
                revision: "a".repeat(64),
                sandbox_id: "none".into(),
            },
            files: vec![InputFile {
                path: "credentials/key".into(),
                role: Role::Credential,
                content: "test-only-token".into(),
            }],
        };
        (directory, root, request)
    }
    fn test_acl(fd: &OwnedFd) -> Result<()> {
        #[cfg(target_os = "linux")]
        {
            acl(fd)
        }
        // macOS proves only descriptor/path/mode behavior, never Linux ACL enforcement.
        #[cfg(not(target_os = "linux"))]
        {
            let _ = fd;
            Ok(())
        }
    }
    #[test]
    fn publication_sets_modes_and_preserves_identity_on_unchanged_retry() {
        let (directory, root, request) = fixture();
        publish(&root, &request, test_acl).unwrap();
        assert_eq!(
            std::fs::read(directory.path().join("credentials/key")).unwrap(),
            b"test-only-token"
        );
        for (path, mode) in [
            ("", 0o700),
            ("credentials", 0o700),
            ("credentials/key", 0o600),
            (MARKER, 0o600),
        ] {
            assert_eq!(
                std::fs::metadata(directory.path().join(path))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o7777,
                mode
            );
        }
        let before = std::fs::metadata(directory.path().join("credentials/key"))
            .unwrap()
            .modified()
            .unwrap();
        publish(&root, &request, test_acl).unwrap();
        assert_eq!(
            std::fs::metadata(directory.path().join("credentials/key"))
                .unwrap()
                .modified()
                .unwrap(),
            before
        );
    }
    #[test]
    fn unsafe_parent_never_writes_outside_the_owned_root() {
        let (directory, root, request) = fixture();
        let outside = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(outside.path(), directory.path().join("credentials")).unwrap();
        assert!(publish(&root, &request, test_acl).is_err());
        assert!(!outside.path().join("key").exists());
        assert!(!directory.path().join(MARKER).exists());
    }

    #[test]
    fn symlinks_hardlinks_and_permissive_leaves_are_rejected_before_publication() {
        for variant in ["symlink", "hardlink", "mode"] {
            let (directory, root, request) = fixture();
            publish(&root, &request, test_acl).unwrap();
            std::fs::remove_file(directory.path().join(MARKER)).unwrap();
            let key = directory.path().join("credentials/key");
            let outside = tempfile::NamedTempFile::new().unwrap();
            std::fs::write(outside.path(), b"unchanged-outside").unwrap();
            match variant {
                "symlink" => {
                    std::fs::remove_file(&key).unwrap();
                    std::os::unix::fs::symlink(outside.path(), &key).unwrap();
                }
                "hardlink" => {
                    std::fs::remove_file(&key).unwrap();
                    std::fs::hard_link(outside.path(), &key).unwrap();
                }
                _ => {
                    std::fs::set_permissions(&key, std::fs::Permissions::from_mode(0o644)).unwrap()
                }
            }
            assert!(publish(&root, &request, test_acl).is_err());
            assert_eq!(std::fs::read(outside.path()).unwrap(), b"unchanged-outside");
            assert!(!directory.path().join(MARKER).exists());
        }
    }
    #[test]
    fn complete_input_changes_fail_closed_and_partial_retry_preserves_other_data() {
        let (directory, root, mut request) = fixture();
        publish(&root, &request, test_acl).unwrap();
        std::fs::write(
            directory.path().join("application-state"),
            b"retained-state",
        )
        .unwrap();
        request.files[0].content = "different-test-token".into();
        assert!(publish(&root, &request, test_acl).is_err());
        assert_eq!(
            std::fs::read(directory.path().join("credentials/key")).unwrap(),
            b"test-only-token"
        );
        request.files[0].content = "test-only-token".into();
        std::fs::remove_file(directory.path().join(MARKER)).unwrap();
        publish(&root, &request, test_acl).unwrap();
        assert_eq!(
            std::fs::read(directory.path().join("application-state")).unwrap(),
            b"retained-state"
        );
    }
    #[cfg(target_os = "linux")]
    #[test]
    fn linux_access_and_default_acls_are_rejected_by_the_real_descriptor_check() {
        for name in ["system.posix_acl_access", "system.posix_acl_default"] {
            let (directory, root, request) = fixture();
            // Linux ACL xattr v2: owner, named user, group, mask, other.
            let mut bytes = 2u32.to_le_bytes().to_vec();
            for (tag, perm, id) in [
                (1u16, 7u16, u32::MAX),
                (2, 4, 12345),
                (4, 0, u32::MAX),
                (16, 4, u32::MAX),
                (32, 0, u32::MAX),
            ] {
                bytes.extend_from_slice(&tag.to_le_bytes());
                bytes.extend_from_slice(&perm.to_le_bytes());
                bytes.extend_from_slice(&id.to_le_bytes());
            }
            fs::fsetxattr(&root, name, &bytes, fs::XattrFlags::empty()).unwrap();
            assert!(publish(&root, &request, acl).is_err());
            assert!(!directory.path().join("credentials").exists());
            assert!(!directory.path().join(MARKER).exists());
        }
    }
}
