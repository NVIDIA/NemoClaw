#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CONTRACTS = {
  "2026.9.5": {
    file: "plugin-generation-artifact-CjuoUs0e.mjs",
    sha256: "37a97a0b9e3e1765cd81449c6f72cd7da34e90d59bb9fecd6bbcedb45c083a4c",
    dependencyVersion: "0.13.1",
  },
  "2026.9.7": {
    file: "plugin-generation-artifact-B__8bgF_.mjs",
    sha256: "e1a168a33d43ec95d7f2dbd43449b7d39413fd5aabf293e53d2e7e650ae28fc9",
    dependencyVersion: "0.21.1",
  },
  "2026.10.5": {
    file: "plugin-generation-source-lookup-Dg6DuWgm.mjs",
    sha256: "f5d2a7a135361cd39680344842b825c9f9db2e1524417c3c1297a53ce7913ff8",
    dependencyVersion: "0.25.0",
  },
} as const;
const MARKER = "// nemoclaw: resolve each Linux source root with the native filesystem API";
const VERIFICATION_MARKER = "// nemoclaw: resolve canonical Linux verification paths freshly";
const VERIFICATION_HELPER = `${VERIFICATION_MARKER}
function freshCanonicalPluginSource(source) {
\tif (process.platform === "linux") {
\t\ttry { if (fs.realpathSync.native(source) === source) return source; } catch {}
\t}
\treturn fs.realpathSync(source);
}
`;
const VERIFICATION_FRAGMENTS = [
  [
    "function verifyPluginSourceInputs(inputs, sources) {",
    VERIFICATION_HELPER + "function verifyPluginSourceInputs(inputs, sources) {",
  ],
  [
    "if (fs.realpathSync(source) !== source || identity !== input.identity ||",
    "if (freshCanonicalPluginSource(source) !== source || identity !== input.identity ||",
  ],
  [
    "for (const { source, input } of sources) {\n\t\t\tconst canonical = fs.realpathSync(source);",
    "for (const { source, input } of sources) {\n\t\t\tconst canonical = freshCanonicalPluginSource(source);",
  ],
] as const;

export function patchPluginSourceVerification(source: string): string {
  const patched = source.includes(VERIFICATION_MARKER);
  if (patched && source.split(VERIFICATION_MARKER).length !== 2)
    throw new Error("Incomplete OpenClaw source verification patch");
  for (const [before, after] of VERIFICATION_FRAGMENTS) {
    const expected = patched ? after : before;
    if (
      source.split(expected).length !== 2 ||
      (patched && source.replace(expected, "").includes(before))
    ) {
      throw new Error("Unrecognized OpenClaw source verification boundary");
    }
  }
  return patched
    ? source
    : VERIFICATION_FRAGMENTS.reduce(
        (result, [before, after]) => result.replace(before, () => after),
        source,
      );
}

function sourceContract(version: string) {
  if (!Object.hasOwn(CONTRACTS, version))
    throw new Error("Unsupported OpenClaw plugin source root version");
  return CONTRACTS[version as keyof typeof CONTRACTS];
}

function sourceFragments(version: string) {
  sourceContract(version);
  const before =
    version === "2026.9.5"
      ? "function readPluginSourceBytes(source, boundary) {\n\tconst opened = openRootFileSync({"
      : "function withPluginSourceFile(source, boundary, read) {\n\tconst opened = openRootFileSync$1({";
  const [declaration, opening] = before.split("\n");
  const after = `${declaration}
\t${MARKER}
\tlet rootRealPath;
\tif (process.platform === "linux") {
\t\ttry { rootRealPath = fs.realpathSync.native(path.resolve(boundary)); } catch {}
\t}
${opening}
\t\trootRealPath,`;
  return { before, after };
}

export function patchPluginSourceRoot(source: string, version = "2026.10.5"): string {
  const { before, after } = sourceFragments(version);
  if (source.includes(MARKER)) {
    if (
      source.split(MARKER).length !== 2 ||
      source.split(after).length !== 2 ||
      source.replace(after, "").includes(before)
    ) {
      throw new Error("Incomplete OpenClaw plugin source root patch");
    }
    return source;
  }
  if (source.split(before).length !== 2)
    throw new Error("Unrecognized OpenClaw plugin source root boundary");
  return source.replace(before, () => after);
}

export function patchOpenClawPluginSourceRoot(dist: string, audit = false): void {
  const realDist = fs.realpathSync(dist);
  const root = path.dirname(realDist);
  const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
  const contract = sourceContract(version);
  const entry = createRequire(path.join(root, "package.json")).resolve(
    "@openclaw/fs-safe/advanced",
  );
  const dependency = JSON.parse(
    fs.readFileSync(path.join(path.dirname(path.dirname(entry)), "package.json"), "utf8"),
  );
  if (
    dependency.name !== "@openclaw/fs-safe" ||
    dependency.version !== contract.dependencyVersion
  ) {
    throw new Error("Unsupported OpenClaw filesystem admission dependency");
  }
  if (version === "2026.10.5") {
    // The second member of this family is a facade, not another implementation.
    const facade = fs.readFileSync(
      path.join(realDist, "plugin-generation-source-lookup-LM75CqdW.mjs"),
    );
    if (
      createHash("sha256").update(facade).digest("hex") !==
      "12dd0e53296c02dc5201ee6c5efdec0f9f85e4dd7460fb568df3af612547ffc0"
    ) {
      throw new Error("OpenClaw plugin source lookup facade changed");
    }
  }
  const file = path.join(realDist, contract.file);
  const source = fs.readFileSync(file, "utf8");
  const rooted = patchPluginSourceRoot(source, version);
  const patched = version === "2026.10.5" ? patchPluginSourceVerification(rooted) : rooted;
  // Invert only this complete patch before verifying the reviewed native bytes.
  // Keep every root/leaf/descriptor check in the existing guarded-open API.
  const { before, after } = sourceFragments(version);
  const withoutVerification =
    version === "2026.10.5" && source.includes(VERIFICATION_MARKER)
      ? VERIFICATION_FRAGMENTS.reduce(
          (result, [original, replacement]) => result.replace(replacement, () => original),
          source,
        )
      : source;
  const original = withoutVerification.includes(MARKER)
    ? withoutVerification.replace(after, before)
    : withoutVerification;
  if (createHash("sha256").update(original).digest("hex") !== contract.sha256) {
    throw new Error("OpenClaw plugin source lookup bytes changed");
  }
  if (audit && source !== patched) throw new Error("Missing OpenClaw plugin source root patch");
  if (!audit && source !== patched) fs.writeFileSync(file, patched);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const audit = args[0] === "--audit";
  const dist = args[audit ? 1 : 0];
  if (!dist || args.length !== (audit ? 2 : 1))
    throw new Error("Usage: patch-openclaw-plugin-source-root.mts [--audit] <dist>");
  patchOpenClawPluginSourceRoot(dist, audit);
}
