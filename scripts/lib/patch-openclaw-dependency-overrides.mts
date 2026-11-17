// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  readJsonObject,
  rewriteRegularFile,
  requireRealDirectory,
} from "./bundled-npm-package.mts";

const reviewed: Record<string, { source: string; patched: string }> = {
  "2026.9.2": {
    source: "acdb8061914ff2def245c4ff5eda935f9dfce49240f5cf90627154774c369927",
    patched: "596388ea92bd7bb6f12f5098d7b567eb227956ec3e7a1ba3219e8e80f892f76f",
  },
  "2026.9.5": {
    source: "24ae87692e1c74de43c14ec2048514740925bfae0a28ff63e761bbfa4bdac3cc",
    patched: "6202dda1b8d6df4f1ee3b915266c174e77bf1685bcb61fc9489f66ff3d15af5d",
  },
  "2026.9.7": {
    source: "05295f0e957caa77be963a7ab56541805e4f3d58d6ef9749fab8846cc8aba720",
    patched: "18f179a46415dbe3a9749982ad504cd82da5949b3e1f95c4436a8be83e29e3bc",
  },
  "2026.10.5": {
    source: "c95a6b7be1fa13956265abbff9bc9895064bf6677123c88314ef4dc20410bda3",
    patched: "888953ffb621f73f897e34ca0a8fc06b89de8a3bbde3df38ec596238f1445f39",
  },
};

/** OpenClaw copies these overrides into each official plugin's managed npm project. */
export function patchOpenClawManagedPluginOverrides(packageDirectory: string): void {
  requireRealDirectory(packageDirectory, "OpenClaw managed override owner");
  const manifest = readJsonObject(
    join(packageDirectory, "package.json"),
    "OpenClaw override owner",
  );
  const version = String(manifest.version);
  const identity = reviewed[version];
  if (manifest.name !== "openclaw" || !identity)
    throw new Error("OpenClaw managed override owner identity has drifted");
  rewriteRegularFile(
    join(packageDirectory, "pnpm-workspace.yaml"),
    "OpenClaw managed overrides",
    (original) => {
      const digest = (text: string) => createHash("sha256").update(text).digest("hex");
      if (digest(original) === identity.patched) return original;
      const prior105 =
        version === "2026.10.5" &&
        digest(original) === "c48734878ccb1de613af3307aa42f26cb8d6add6ca1e2dc95a2761ff671e20bb";
      if (digest(original) !== identity.source && !prior105)
        throw new Error("OpenClaw managed override source integrity mismatch");
      let patched = original;
      if (version === "2026.10.5" && !prior105) {
        patched = patched
          .replace(
            "overrides:\n",
            'overrides:\n  "@azure/msal-node": 7.1.0\n  body-parser: 2.4.0\n  undici: 8.12.3\n  zod: 4.6.6\n',
          )
          .replace("  qs: 6.16.0\n", "  qs: 6.16.1\n");
      } else if (version !== "2026.10.5") {
        patched = patched.replace("overrides:\n", "overrides:\n  undici: 8.12.2\n");
      }
      patched = patched
        .replace("  axios: 1.19.0\n", "  axios: 1.20.0\n")
        .replace(/  fast-uri: 4\.(?:1\.4|2\.1)\n/u, "  fast-uri: 4.2.3\n")
        .replace("  follow-redirects: 1.16.0\n", "  follow-redirects: 1.16.1\n")
        .replace(/>undici": 8\.10\.2\n/u, '>undici": 8.12.2\n');
      if (digest(patched) !== identity.patched)
        throw new Error("OpenClaw managed override replacement integrity mismatch");
      return patched;
    },
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 3)
    throw new Error("Expected the installed OpenClaw package directory");
  patchOpenClawManagedPluginOverrides(process.argv[2]!);
}
