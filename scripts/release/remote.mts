// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

export function isCanonicalNemoClawRemote(remote: string): boolean {
  return /^https:\/\/github[.]com\/NVIDIA\/NemoClaw(?:[.]git)?$/u.test(remote);
}

export function isLocalReleaseFixtureRemote(remote: string): boolean {
  if (path.isAbsolute(remote)) return true;
  try {
    const url = new URL(remote);
    return url.protocol === "file:" && url.hostname === "" && path.isAbsolute(url.pathname);
  } catch {
    return false;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const remote = process.argv[2] ?? "";
  process.stdout.write(
    isCanonicalNemoClawRemote(remote)
      ? "canonical"
      : isLocalReleaseFixtureRemote(remote)
        ? "local-fixture"
        : "noncanonical",
  );
}
