// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { hostedCredentialScanCommand } from "../live/inference-routing-credential-scan.ts";

const credential = "synthetic-hosted-credential-for-scan";

function executeProbe(leakIn = "none", emptyFiles = false, discoverCanary = true) {
  const command = hostedCredentialScanCommand(credential);
  const records = new Map<string, Buffer>([
    [
      "/fixture",
      Buffer.from(leakIn === "files" ? `prefix ${credential} suffix` : "only a placeholder"),
    ],
  ]);
  let output = "";
  const dependencies = {
    "node:crypto": crypto,
    "node:os": os,
    "node:path": path,
    "node:child_process": {
      execFileSync: (program: string) =>
        Buffer.from(
          program === "sh"
            ? [
                discoverCanary && records.has("/probe-control/canary")
                  ? "/probe-control/canary"
                  : "",
                emptyFiles ? "" : "/fixture",
              ]
                .filter(Boolean)
                .join("\n")
            : leakIn === program
              ? `prefix ${credential} suffix`
              : "ordinary observation",
        ),
    },
    "node:fs": {
      readFileSync: (file: string) => Buffer.from(records.get(file)!),
      mkdtempSync: () => "/probe-control",
      writeFileSync: (file: string, data: Buffer) => records.set(file, data),
      rmSync: () => records.delete("/probe-control/canary"),
    },
  };
  vm.runInNewContext(
    command[2]!,
    {
      require: (name: keyof typeof dependencies) => dependencies[name],
      Buffer,
      process: { argv: ["node", command[3]] },
      console: {
        log: (value: string) => {
          output = value;
        },
      },
    },
    { timeout: 5_000 },
  );
  return { command, output, evidence: JSON.parse(output), records };
}

describe("hosted credential isolation probe", () => {
  it.each([
    ["env", "environmentClean"],
    ["ps", "processesClean"],
    ["files", "sampledFilesClean"],
  ])("detects the selected credential in %s before artifact redaction", (source, field) => {
    const result = executeProbe(source);
    expect(result.evidence[field]).toBe(false);
    expect(result.command.join(" ")).not.toContain(credential);
    expect(result.output).not.toContain(credential);
  });

  it("accepts clean observations, detects its positive control and removes it", () => {
    const result = executeProbe();
    expect(result.evidence).toEqual({
      environmentClean: true,
      processesClean: true,
      sampledFilesClean: true,
      canaryDetected: true,
      sampledFileCount: 1,
    });
    expect(result.records.has("/probe-control/canary")).toBe(false);
  });

  it("does not call an empty filesystem sample clean", () => {
    expect(executeProbe("none", true).evidence.sampledFilesClean).toBe(false);
  });

  it("rejects a positive control omitted by file discovery", () => {
    const result = executeProbe("none", false, false);
    expect(result.evidence.canaryDetected).toBe(false);
    expect(result.records.has("/probe-control/canary")).toBe(false);
  });
});
