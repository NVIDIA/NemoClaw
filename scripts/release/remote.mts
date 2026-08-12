// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

export function isCanonicalNemoClawRemote(remote: string): boolean {
  if (/^git@github[.]com:NVIDIA\/NemoClaw(?:[.]git)?\/?$/iu.test(remote)) {
    return true;
  }
  try {
    const url = new URL(remote);
    const protocolAllowed =
      url.protocol === "https:" || (url.protocol === "ssh:" && url.username === "git");
    const repository = url.pathname
      .replace(/\/$/u, "")
      .replace(/[.]git$/iu, "")
      .toLowerCase();
    return (
      protocolAllowed &&
      url.hostname.toLowerCase() === "github.com" &&
      repository === "/nvidia/nemoclaw"
    );
  } catch {
    return false;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.stdout.write(
    isCanonicalNemoClawRemote(process.argv[2] ?? "") ? "canonical" : "noncanonical",
  );
}
