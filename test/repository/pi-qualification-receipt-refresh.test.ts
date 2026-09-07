// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { checkPiQualificationReceiptRefresh } from "../../scripts/checks/pi-qualification-receipt-refresh.mts";

const SOURCE_REVISION = "a".repeat(40);
const RECEIPTS = [
  { path: "ci/pi-amd64.json", platform: "linux/amd64" as const },
  { path: "ci/pi-arm64.json", platform: "linux/arm64" as const },
];

function receipt(platform: string, cohort = "ghrun-123-1"): string {
  const digest = `sha256:${(platform === "linux/amd64" ? "b" : "c").repeat(64)}`;
  return `${JSON.stringify(
    {
      contractVersion: 1,
      agent: "pi",
      platform,
      image: "ghcr.io/nvidia/nemoclaw/pi-sandbox",
      digest,
      reference: `ghcr.io/nvidia/nemoclaw/pi-sandbox@${digest}`,
      source: {
        repository: "NVIDIA/NemoClaw",
        revision: SOURCE_REVISION,
        release: "v0.1.0",
        cohort,
      },
      startupProfileContractVersion: 1,
      capabilityContractVersion: 1,
    },
    null,
    2,
  )}\n`;
}

function receiptDigest(contents: string): string {
  return createHash("sha256").update(contents).digest("hex");
}

describe("Pi qualification receipt refresh", () => {
  let rootDir: string;
  let acceptedDigests: Set<string>;

  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-pi-receipt-refresh-"));
    fs.mkdirSync(path.join(rootDir, "agents/pi"), { recursive: true });
    fs.mkdirSync(path.join(rootDir, "ci"), { recursive: true });
    fs.writeFileSync(
      path.join(rootDir, "agents/pi/Dockerfile"),
      "FROM scratch\nCOPY protected/app /app\n",
    );
    fs.writeFileSync(
      path.join(rootDir, "agents/pi/Dockerfile.base"),
      "FROM scratch\nCOPY protected/base /base\n",
    );
    const amd64Contents = receipt(RECEIPTS[0].platform);
    const arm64Contents = receipt(RECEIPTS[1].platform);
    fs.writeFileSync(path.join(rootDir, RECEIPTS[0].path), amd64Contents);
    fs.writeFileSync(path.join(rootDir, RECEIPTS[1].path), arm64Contents);
    acceptedDigests = new Set([receiptDigest(amd64Contents), receiptDigest(arm64Contents)]);
  });

  afterEach(() => fs.rmSync(rootDir, { force: true, recursive: true }));

  function run(
    changedPaths: readonly string[],
    options: {
      accepted?: ReadonlySet<string>;
      headRevision?: string;
      sourceParity?: boolean;
    } = {},
  ): void {
    checkPiQualificationReceiptRefresh({
      acceptedDigests: options.accepted ?? acceptedDigests,
      baseBranch: "main",
      git: (args) =>
        args[0] === "merge-base"
          ? { status: 0, stdout: "base\n" }
          : args.includes("--name-only")
            ? { status: 0, stdout: `${changedPaths.join("\0")}\0` }
            : args.includes("--quiet")
              ? args[3] === (options.headRevision ?? "HEAD")
                ? { status: options.sourceParity === false ? 1 : 0, stdout: "" }
                : (() => {
                    throw new Error(`Unexpected comparison revision: ${args[3]}`);
                  })()
              : (() => {
                  throw new Error(`Unexpected git arguments: ${args.join(" ")}`);
                })(),
      receipts: RECEIPTS,
      rootDir,
      headRevision: options.headRevision ?? "HEAD",
    });
  }

  it.each([
    ["copied source", "protected/app/config.json"],
    ["Pi Dockerfile", "agents/pi/Dockerfile"],
    ["Pi base Dockerfile", "agents/pi/Dockerfile.base"],
    ["Docker ignore rules", ".dockerignore"],
  ])("requires both architecture receipts after a %s change", (_kind, changedPath) => {
    expect(() => run([changedPath])).toThrow(
      "Pi image inputs changed without refreshing both qualification receipts",
    );
  });

  it("rejects a partial architecture receipt refresh", () => {
    expect(() => run(["protected/base/config.json", RECEIPTS[0].path])).toThrow(RECEIPTS[1].path);
  });

  it.each(RECEIPTS)("rejects deletion of the $platform qualification receipt", (candidate) => {
    fs.unlinkSync(path.join(rootDir, candidate.path));

    expect(() =>
      run(["protected/app/config.json", ...RECEIPTS.map(({ path: receiptPath }) => receiptPath)]),
    ).toThrow(`Pi image inputs changed but qualification receipt is missing: ${candidate.path}`);
  });

  it("accepts refreshed receipts when image sources match the receipt revision", () => {
    expect(() =>
      run(["protected/app/config.json", ...RECEIPTS.map(({ path: receiptPath }) => receiptPath)]),
    ).not.toThrow();
  });

  it("compares receipt parity against the exact PR head instead of a synthetic merge", () => {
    const headRevision = "d".repeat(40);
    expect(() =>
      run(["protected/app/config.json", ...RECEIPTS.map(({ path }) => path)], {
        headRevision,
      }),
    ).not.toThrow();
  });

  it("does not require receipts for unrelated changes", () => {
    expect(() => run(["docs/reference/pi.mdx"])).not.toThrow();
  });

  it("rejects receipts whose source predates a protected input change", () => {
    expect(() =>
      run(["protected/app/config.json", ...RECEIPTS.map(({ path: receiptPath }) => receiptPath)], {
        sourceParity: false,
      }),
    ).toThrow(`Pi image inputs changed after receipt source revision ${SOURCE_REVISION}`);
  });

  it("rejects receipts from different publication cohorts", () => {
    const arm64Contents = receipt("linux/arm64", "ghrun-456-1");
    fs.writeFileSync(path.join(rootDir, RECEIPTS[1].path), arm64Contents);
    acceptedDigests.add(receiptDigest(arm64Contents));
    expect(() =>
      run(["protected/app/config.json", ...RECEIPTS.map(({ path: receiptPath }) => receiptPath)]),
    ).toThrow("Pi qualification receipts must identify one source, release, and cohort");
  });

  it("rejects a receipt for the wrong platform", () => {
    const arm64Contents = receipt("linux/amd64");
    fs.writeFileSync(path.join(rootDir, RECEIPTS[1].path), arm64Contents);
    acceptedDigests.add(receiptDigest(arm64Contents));
    expect(() =>
      run(["protected/app/config.json", ...RECEIPTS.map(({ path: receiptPath }) => receiptPath)]),
    ).toThrow('contract.platform must be "linux/arm64"');
  });

  it("rejects receipt contents absent from candidate authority", () => {
    expect(() =>
      run(["protected/app/config.json", ...RECEIPTS.map(({ path: receiptPath }) => receiptPath)], {
        accepted: new Set(),
      }),
    ).toThrow("is not present in the Pi candidate receipt authority");
  });

  it("rejects an authority-only change that grants an extra receipt", () => {
    acceptedDigests.add("d".repeat(64));

    expect(() => run(["src/lib/agent/candidate-authority.ts"])).toThrow(
      "Pi candidate receipt authority must exactly match both published receipts",
    );
  });

  it("rejects a receipt-only change whose published receipts do not match authority", () => {
    const changedContents = receipt("linux/amd64", "ghrun-789-1");
    fs.writeFileSync(path.join(rootDir, RECEIPTS[0].path), changedContents);

    expect(() => run([RECEIPTS[0].path])).toThrow(
      `${RECEIPTS[0].path} is not present in the Pi candidate receipt authority`,
    );
  });

  it("names a malformed qualification receipt", () => {
    const malformed = "{not-json\n";
    fs.writeFileSync(path.join(rootDir, RECEIPTS[1].path), malformed);
    acceptedDigests.add(receiptDigest(malformed));
    acceptedDigests.delete(receiptDigest(receipt(RECEIPTS[1].platform)));

    expect(() => run([RECEIPTS[1].path])).toThrow(
      `Invalid Pi qualification receipt ${RECEIPTS[1].path}`,
    );
  });

  it("explains how to recover a missing comparison base", () => {
    expect(() =>
      checkPiQualificationReceiptRefresh({
        baseBranch: "main",
        git: () => ({ status: 1, stderr: "not a valid object", stdout: "" }),
        rootDir,
      }),
    ).toThrow(
      "Could not resolve the Pi receipt comparison base against origin/main. Fetch origin/main with sufficient history before retrying. Git reported: not a valid object",
    );
  });
});
