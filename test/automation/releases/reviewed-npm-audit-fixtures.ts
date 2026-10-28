// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import type { parseAuditConfig } from "../../../scripts/audit-reviewed-npm-graph.mts";

export type LockedGraphFixture<T> = Readonly<{
  graph: T;
  lock: Buffer;
  manifest: Buffer;
}>;

type ReviewedLockedGraph = ReturnType<typeof parseAuditConfig>["lockedGraphs"][number];

export function openClawReplacementGraphFixture(
  repoRoot: string,
): LockedGraphFixture<ReviewedLockedGraph> {
  // Keep the transition proof after production policy adopts the replacement.
  const graph = {
    id: "openclaw-runtime",
    label: "OpenClaw 2026.9.2 locked runtime graph",
    packageSpec: "openclaw@2026.9.2",
    integrity:
      "sha512-M6C7UsnX815nv26qBJFYGe6aGzv+ftZLRzV6S9oRXUtXg2Yn67eVntpssT94kgkquKVSeUxerUg0j1ONp4WYQg==",
    tarballUrl: "https://registry.npmjs.org/openclaw/-/openclaw-2026.9.2.tgz",
    directory: "agents/openclaw/openclaw-runtime",
    lockSha256: "b44c7f475fe36a378ebc078dbf068bd225f8470002834ce1308872049213b633",
    replacement: {
      label: "OpenClaw 2026.9.5 locked runtime graph",
      packageSpec: "openclaw@2026.9.5",
      integrity:
        "sha512-TCO/ImVLh5HkF4tdfo7iriIa7kT6iYkIr/jR5ZOkePGFGhUx5Oe7DE716Y1DzzG2teRAVDdCjgJDu1A24Yta7w==",
      tarballUrl: "https://registry.npmjs.org/openclaw/-/openclaw-2026.9.5.tgz",
      lockSha256: "b73ebd8bb5e15cfcf080a21beaca0dce50cbca903988b20be74d49c9498baeb7",
    },
  } satisfies ReviewedLockedGraph;
  const encodedLock = fs
    .readFileSync(
      path.join(repoRoot, "test/fixtures/openclaw-2026.9.5-package-lock.json.gz.base64"),
      "utf8",
    )
    .replaceAll(/\s/g, "");
  const lock = gunzipSync(Buffer.from(encodedLock, "base64"));
  const parsedLock = JSON.parse(lock.toString("utf8")) as {
    packages: { "": Record<string, unknown> };
  };
  if (createHash("sha256").update(lock).digest("hex") !== graph.replacement.lockSha256) {
    throw new Error("OpenClaw transition fixture does not match the reviewed replacement lock");
  }
  return {
    graph,
    lock,
    manifest: Buffer.from(`${JSON.stringify(parsedLock.packages[""], null, 2)}\n`),
  };
}

export function wechatReplacementGraphFixture(repoRoot: string): LockedGraphFixture<{
  readonly directory: "agents/openclaw/wechat-runtime";
  readonly id: "wechat-runtime";
  readonly inputValidation: "wechat-runtime";
  readonly installMode: "legacy-peer-deps";
  readonly integrity: string;
  readonly label: string;
  readonly lockSha256: string;
  readonly packageSpec: string;
  readonly replacement: {
    readonly integrity: string;
    readonly label: string;
    readonly lockSha256: string;
    readonly packageSpec: string;
    readonly tarballUrl: string;
  };
  readonly severityThreshold: "low";
  readonly signatureAudit: "retry-download-failures";
  readonly tarballUrl: string;
}> {
  const lockValue = JSON.parse(
    fs.readFileSync(
      path.join(repoRoot, "agents/openclaw/wechat-runtime/package-lock.json"),
      "utf8",
    ),
  );
  lockValue.packages["node_modules/@tencent-weixin/openclaw-weixin"].peerDependenciesMeta = {
    openclaw: { optional: true },
  };
  const lock = Buffer.from(JSON.stringify(lockValue));
  const integrity =
    "sha512-SfaYehR1Cwq2VV5HxJBp9sVilMms420VfZlMbF4YjRbWomr5+GxfXp9HkeU6y5TbnOc4Ysq0qPw1yBvJwbenBA==";
  return {
    graph: {
      directory: "agents/openclaw/wechat-runtime",
      id: "wechat-runtime",
      inputValidation: "wechat-runtime",
      installMode: "legacy-peer-deps",
      integrity: "sha512-previous",
      label: "WeChat previous fixture",
      lockSha256: "a".repeat(64),
      packageSpec: "@tencent-weixin/openclaw-weixin@2.4.2",
      replacement: {
        integrity,
        label: "WeChat fixture",
        lockSha256: createHash("sha256").update(lock).digest("hex"),
        packageSpec: "@tencent-weixin/openclaw-weixin@2.4.9",
        tarballUrl:
          "https://registry.npmjs.org/@tencent-weixin/openclaw-weixin/-/openclaw-weixin-2.4.9.tgz",
      },
      severityThreshold: "low",
      signatureAudit: "retry-download-failures",
      tarballUrl:
        "https://registry.npmjs.org/@tencent-weixin/openclaw-weixin/-/openclaw-weixin-2.4.2.tgz",
    },
    lock,
    manifest: fs.readFileSync(path.join(repoRoot, "agents/openclaw/wechat-runtime/package.json")),
  };
}
