// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const FIXED_HELPER_PATHS = {
  AWK_BINARY: ["/usr/bin/awk", "awk"],
  CHMOD_BINARY: ["/usr/bin/chmod", "chmod"],
  CHOWN_BINARY: ["/usr/bin/chown", "chown"],
  CMP_BINARY: ["/usr/bin/cmp", "cmp"],
  CURL_BINARY: ["/usr/bin/curl", "curl"],
  ENV_BINARY: ["/usr/bin/env", "env"],
  GETENT_BINARY: ["/usr/bin/getent", "getent"],
  GIT_BINARY: ["/usr/bin/git", "git"],
  GREP_BINARY: ["/usr/bin/grep", "grep"],
  HEAD_BINARY: ["/usr/bin/head", "head"],
  ID_BINARY: ["/usr/bin/id", "id"],
  INSTALL_BINARY: ["/usr/bin/install", "install"],
  JQ_BINARY: ["/usr/bin/jq", "jq"],
  MKDIR_BINARY: ["/usr/bin/mkdir", "mkdir"],
  MKTEMP_BINARY: ["/usr/bin/mktemp", "mktemp"],
  MV_BINARY: ["/usr/bin/mv", "mv"],
  READLINK_BINARY: ["/usr/bin/readlink", "readlink"],
  REALPATH_BINARY: ["/usr/bin/realpath", "realpath"],
  RM_BINARY: ["/usr/bin/rm", "rm"],
  SED_BINARY: ["/usr/bin/sed", "sed"],
  SHA256SUM_BINARY: ["/usr/bin/sha256sum", "sha256sum"],
  SORT_BINARY: ["/usr/bin/sort", "sort"],
  STAT_BINARY: ["/usr/bin/stat", "stat"],
  SUDO_BINARY: ["/usr/bin/sudo", "sudo"],
  SYNC_BINARY: ["/usr/bin/sync", "sync"],
  SYSTEMCTL_BINARY: ["/usr/bin/systemctl", "systemctl"],
  TEE_BINARY: ["/usr/bin/tee", "tee"],
  TRUE_BINARY: ["/usr/bin/true", "true"],
  TR_BINARY: ["/usr/bin/tr", "tr"],
  USERADD_BINARY: ["/usr/sbin/useradd", "useradd"],
} as const;

export const NATIVE_FIXTURE_HELPERS: Partial<Record<keyof typeof FIXED_HELPER_PATHS, string>> = {
  AWK_BINARY: "/usr/bin/awk",
  CHMOD_BINARY: "/bin/chmod",
  CHOWN_BINARY: "/usr/sbin/chown",
  CMP_BINARY: "/usr/bin/cmp",
  ENV_BINARY: "/usr/bin/env",
  GREP_BINARY: "/usr/bin/grep",
  HEAD_BINARY: "/usr/bin/head",
  INSTALL_BINARY: "/usr/bin/install",
  MKDIR_BINARY: "/bin/mkdir",
  MV_BINARY: "/bin/mv",
  READLINK_BINARY: "/usr/bin/readlink",
  RM_BINARY: "/bin/rm",
  SED_BINARY: "/usr/bin/sed",
  SORT_BINARY: "/usr/bin/sort",
  SYNC_BINARY: "/bin/sync",
  TEE_BINARY: "/usr/bin/tee",
  TRUE_BINARY: "/usr/bin/true",
  TR_BINARY: "/usr/bin/tr",
};

export function executable(directory: string, name: string, source: string): void {
  fs.writeFileSync(path.join(directory, name), source, { mode: 0o755 });
}

export function shellLiteral(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function fileSha256(file: string): string {
  return `sha256:${createHash("sha256").update(fs.readFileSync(file)).digest("hex")}`;
}

export function replaceExactlyOnce(source: string, expected: string, replacement: string): string {
  const first = source.indexOf(expected);
  if (first < 0 || source.indexOf(expected, first + expected.length) >= 0) {
    throw new Error(`fixture could not replace exactly one ${expected}`);
  }
  return `${source.slice(0, first)}${replacement}${source.slice(first + expected.length)}`;
}

export function replaceExactlyTwice(source: string, expected: string, replacement: string): string {
  const parts = source.split(expected);
  if (parts.length !== 3) {
    throw new Error(`fixture could not replace exactly two ${expected}`);
  }
  return parts.join(replacement);
}
