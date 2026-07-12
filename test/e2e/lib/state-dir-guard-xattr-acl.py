#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Seed and verify real extended attributes and POSIX ACLs for #6059 live E2E coverage.

Exercises the kernel's `system.posix_acl_access` xattr directly through
`os.setxattr`/`os.getxattr` using its documented binary wire format (the same
bytes `setfacl`/`getfacl` would produce), so this check does not depend on the
`acl` userspace package being installed in the sandbox image. That keeps the
proof entirely test-side: no production Dockerfile changes.

Subcommands:
  capability-probe --dir <scratch-dir>
      Detect whether the filesystem backing <scratch-dir> supports plain
      xattrs and POSIX ACL xattrs. Prints {"xattr": bool, "acl": bool}.

  seed --root <config-dir> --marker <token> --acl-extra-uid <uid>
      Create <root>/nested/state-file.txt with known content, a
      user.* marker xattr, and a POSIX ACL granting <uid> rwx while the
      file's own owner/group/other bits stay restrictive. Prints the file's
      inode and content sha256 so a later transition can prove the inode
      changed (fresh-inode copy-replace) while the content did not.

  verify --path <file> --acl-extra-uid <uid>
      Read back inode, owner, group, mode, content sha256, the marker xattr,
      and the raw ACL entries, plus the *effective* permission for
      <uid> after the kernel's mask clamp (entry perm & ACL_MASK perm) --
      the actual enforced access, not just the raw stored ACL bytes.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import struct
import sys

ACL_EA_VERSION = 2
ACL_XATTR_NAME = "system.posix_acl_access"
MARKER_XATTR_NAME = "user.nemoclaw_e2e_marker"

ACL_USER_OBJ = 0x01
ACL_USER = 0x02
ACL_GROUP_OBJ = 0x04
ACL_MASK = 0x10
ACL_OTHER = 0x20
ACL_UNDEFINED_ID = 0xFFFFFFFF


def _entry(tag: int, perm: int, entry_id: int = ACL_UNDEFINED_ID) -> bytes:
    return struct.pack("<HHI", tag, perm, entry_id)


def _encode_acl(
    owner_perm: int,
    group_perm: int,
    other_perm: int,
    extra_uid: int,
    extra_perm: int,
    mask_perm: int,
) -> bytes:
    """Build a minimal, kernel-valid `system.posix_acl_access` payload.

    Entry order is significant: `posix_acl_valid()` in the kernel requires
    USER_OBJ, USER* (ascending id), GROUP_OBJ, MASK, OTHER in exactly that
    order, or the kernel rejects the xattr write with EINVAL.
    """
    return b"".join(
        [
            struct.pack("<I", ACL_EA_VERSION),
            _entry(ACL_USER_OBJ, owner_perm),
            _entry(ACL_USER, extra_perm, extra_uid),
            _entry(ACL_GROUP_OBJ, group_perm),
            _entry(ACL_MASK, mask_perm),
            _entry(ACL_OTHER, other_perm),
        ]
    )


def _decode_acl(raw: bytes) -> dict:
    if len(raw) < 4:
        raise ValueError("ACL xattr payload is shorter than its version header")
    (version,) = struct.unpack_from("<I", raw, 0)
    entries = []
    offset = 4
    while offset + 8 <= len(raw):
        tag, perm, entry_id = struct.unpack_from("<HHI", raw, offset)
        entries.append({"tag": tag, "perm": perm, "id": entry_id})
        offset += 8
    return {"version": version, "entries": entries}


def _effective_perm_for_uid(decoded: dict, uid: int) -> "int | None":
    named = next(
        (e for e in decoded["entries"] if e["tag"] == ACL_USER and e["id"] == uid),
        None,
    )
    if named is None:
        return None
    mask = next((e for e in decoded["entries"] if e["tag"] == ACL_MASK), None)
    mask_perm = mask["perm"] if mask is not None else 0o7
    return named["perm"] & mask_perm


def _sha256_file(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def cmd_capability_probe(args: argparse.Namespace) -> int:
    probe_path = os.path.join(args.dir, ".nemoclaw-e2e-xattr-acl-probe")
    result = {"xattr": False, "acl": False}
    with open(probe_path, "wb") as stream:
        stream.write(b"probe")
    try:
        fd = os.open(probe_path, os.O_RDONLY)
        try:
            try:
                os.setxattr(fd, MARKER_XATTR_NAME, b"probe")
                result["xattr"] = os.getxattr(fd, MARKER_XATTR_NAME) == b"probe"
            except OSError:
                pass
            try:
                acl = _encode_acl(0o7, 0o0, 0o0, 65534, 0o7, 0o7)
                os.setxattr(fd, ACL_XATTR_NAME, acl)
                result["acl"] = len(os.getxattr(fd, ACL_XATTR_NAME)) > 0
            except OSError:
                pass
        finally:
            os.close(fd)
    finally:
        os.unlink(probe_path)
    print(json.dumps(result, sort_keys=True))
    return 0


def cmd_seed(args: argparse.Namespace) -> int:
    nested_dir = os.path.join(args.root, "nested")
    os.makedirs(nested_dir, exist_ok=True)
    target = os.path.join(nested_dir, "state-file.txt")
    content = f"nemoclaw-e2e-state-content-{args.marker}\n".encode("ascii")
    with open(target, "wb") as stream:
        stream.write(content)
    # Start from a deliberately permissive mode (0666) so a subsequent guard
    # transition that clamps to a narrower mode actually moves the ACL_MASK
    # entry, instead of the clamp being a no-op against an already-narrow mode.
    #
    # owner/group/mask/other perms are deliberately kept execute-bit-free
    # (0o6, never 0o7): the kernel resyncs a regular file's mode from the ACL
    # on setxattr (mode's owner field <- USER_OBJ perm, group field <- MASK
    # perm, other field <- OTHER perm), so any execute bit here would leak
    # into the file's mode and trip state-dir-guard.py's unlock rule that
    # re-adds group-execute when `old_mode & 0o111` -- a rule meant for
    # genuinely executable files, not this plain-text fixture. The named
    # ACL_USER entry (extra_perm) stays 0o7 so its clamp-by-mask behavior is
    # still exercised: effective access for that uid starts at 0o7 & 0o6.
    os.chmod(target, 0o666)
    fd = os.open(target, os.O_RDONLY)
    try:
        os.setxattr(fd, MARKER_XATTR_NAME, args.marker.encode("ascii"))
        acl = _encode_acl(
            owner_perm=0o6,
            group_perm=0o6,
            other_perm=0o6,
            extra_uid=args.acl_extra_uid,
            extra_perm=0o7,
            mask_perm=0o6,
        )
        os.setxattr(fd, ACL_XATTR_NAME, acl)
        st = os.fstat(fd)
    finally:
        os.close(fd)
    print(
        json.dumps(
            {"path": target, "inode": st.st_ino, "sha256": _sha256_file(target)},
            sort_keys=True,
        )
    )
    return 0


def cmd_verify(args: argparse.Namespace) -> int:
    st = os.stat(args.path, follow_symlinks=False)
    report = {
        "path": args.path,
        "inode": st.st_ino,
        "uid": st.st_uid,
        "gid": st.st_gid,
        "mode": oct(st.st_mode & 0o7777),
        "sha256": _sha256_file(args.path),
    }
    fd = os.open(args.path, os.O_RDONLY)
    try:
        try:
            report["marker"] = os.getxattr(fd, MARKER_XATTR_NAME).decode("ascii")
        except OSError as exc:
            report["marker"] = None
            report["markerError"] = exc.strerror or str(exc)
        try:
            raw = os.getxattr(fd, ACL_XATTR_NAME)
            decoded = _decode_acl(raw)
            report["aclEntries"] = decoded["entries"]
            report["effectivePermForExtraUid"] = _effective_perm_for_uid(
                decoded, args.acl_extra_uid
            )
        except OSError as exc:
            report["aclEntries"] = None
            report["effectivePermForExtraUid"] = None
            report["aclError"] = exc.strerror or str(exc)
    finally:
        os.close(fd)
    print(json.dumps(report, sort_keys=True))
    return 0


def main(argv: list) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    probe = subparsers.add_parser("capability-probe")
    probe.add_argument("--dir", required=True)
    probe.set_defaults(handler=cmd_capability_probe)

    seed = subparsers.add_parser("seed")
    seed.add_argument("--root", required=True)
    seed.add_argument("--marker", required=True)
    seed.add_argument("--acl-extra-uid", required=True, type=int)
    seed.set_defaults(handler=cmd_seed)

    verify = subparsers.add_parser("verify")
    verify.add_argument("--path", required=True)
    verify.add_argument("--acl-extra-uid", required=True, type=int)
    verify.set_defaults(handler=cmd_verify)

    args = parser.parse_args(argv)
    return args.handler(args)


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
