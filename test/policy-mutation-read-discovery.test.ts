// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  auditOpenShellPolicyMutationReads,
  discoverPolicyReadSites,
} from "../scripts/checks/openshell-policy-mutation-read";

describe("OpenShell policy mutation read discovery", () => {
  it("discovers builder and direct policy reads in new production files", () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-policy-read-discovery-"));
    const mutationPath = path.join(repoRoot, "src", "lib", "new-policy-mutation.ts");
    const diagnosticPath = path.join(repoRoot, "nemoclaw", "src", "new-policy-diagnostic.ts");
    fs.mkdirSync(path.dirname(mutationPath), { recursive: true });
    fs.mkdirSync(path.dirname(diagnosticPath), { recursive: true });
    fs.writeFileSync(mutationPath, "runCapture(buildPolicyGetCommand(sandboxName));\n");
    fs.writeFileSync(
      diagnosticPath,
      'runCmd(["openshell", "policy", "get", "--full", sandboxName]);\n',
    );

    try {
      expect(discoverPolicyReadSites(repoRoot)).toEqual([
        { relativePath: "nemoclaw/src/new-policy-diagnostic.ts", readCalls: 1 },
        { relativePath: "src/lib/new-policy-mutation.ts", readCalls: 1 },
      ]);
      expect(auditOpenShellPolicyMutationReads(repoRoot)).toEqual(
        expect.arrayContaining([
          expect.stringContaining("new-policy-diagnostic.ts: found 1 unaccounted policy read"),
          expect.stringContaining("new-policy-mutation.ts: found 1 unaccounted policy read"),
        ]),
      );
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});
