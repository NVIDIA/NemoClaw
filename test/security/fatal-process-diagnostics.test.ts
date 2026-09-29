// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const REPOSITORY_ROOT = path.join(import.meta.dirname, "../..");
const MESSAGING_BUILD_APPLIER = path.join(
  REPOSITORY_ROOT,
  "src/lib/messaging/applier/build/messaging-build-applier.mts",
);
const REVIEWED_NPM_AUDIT = path.join(REPOSITORY_ROOT, "scripts/audit-reviewed-npm-graph.mts");
const OPENCLAW_NPM_REMEDIATION = path.join(
  REPOSITORY_ROOT,
  "scripts/lib/openclaw-npm-remediation.mts",
);
const CREDENTIAL_CANARY = "OPENAI_API_KEY=process-boundary-canary-0123456789";

function encodedMessagingPlan(renderTarget: string | null): string {
  return Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      sandboxName: "alpha",
      agent: "openclaw",
      channels: [{ channelId: "test", active: true }],
      credentialBindings: [],
      agentRender: renderTarget
        ? [
            {
              channelId: "test",
              agent: "openclaw",
              target: renderTarget,
              kind: "json-fragment",
              value: { enabled: true },
            },
          ]
        : [],
      buildSteps: [],
    }),
  ).toString("base64");
}

describe("fatal process diagnostics", () => {
  it("omits messaging plan credentials from a build failure (#11673)", () => {
    const result = spawnSync(
      process.execPath,
      [MESSAGING_BUILD_APPLIER, "--agent", "openclaw", "--phase", "post-agent-install"],
      {
        cwd: REPOSITORY_ROOT,
        encoding: "utf8",
        env: {
          ...process.env,
          NEMOCLAW_MESSAGING_PLAN_B64: encodedMessagingPlan(CREDENTIAL_CANARY),
        },
      },
    );

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Messaging build applier rejected invalid or unsafe input.");
    expect(result.stderr).not.toContain(CREDENTIAL_CANARY);
  });

  it("omits inherited credentials printed by a failing messaging child (#11673)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-messaging-diagnostic-"));
    try {
      const openclaw = path.join(root, "openclaw");
      fs.writeFileSync(
        openclaw,
        [
          "#!/bin/sh",
          'printf "%s\\n" "$NEMOCLAW_FATAL_DIAGNOSTIC_CANARY"',
          'printf "%s\\n" "$NEMOCLAW_FATAL_DIAGNOSTIC_CANARY" >&2',
          "exit 1",
          "",
        ].join("\n"),
        { mode: 0o700 },
      );

      const result = spawnSync(
        process.execPath,
        [MESSAGING_BUILD_APPLIER, "--agent", "openclaw", "--phase", "post-agent-install"],
        {
          cwd: REPOSITORY_ROOT,
          encoding: "utf8",
          env: {
            ...process.env,
            NEMOCLAW_FATAL_DIAGNOSTIC_CANARY: CREDENTIAL_CANARY,
            NEMOCLAW_MESSAGING_PLAN_B64: encodedMessagingPlan(null),
            PATH: `${root}${path.delimiter}${process.env.PATH ?? ""}`,
          },
        },
      );

      expect(result.status).toBe(2);
      expect(result.stdout).toContain("+ openclaw doctor --fix --non-interactive");
      expect(result.stdout).not.toContain(CREDENTIAL_CANARY);
      expect(result.stderr).toContain("Messaging build applier command failed.");
      expect(result.stderr).not.toContain(CREDENTIAL_CANARY);
    } finally {
      fs.rmSync(root, { force: true, recursive: true });
    }
  });

  it("omits an environment-controlled path from an audit failure (#11673)", () => {
    const entrypoint = pathToFileURL(REVIEWED_NPM_AUDIT).href;
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        [
          `const entrypoint = ${JSON.stringify(REVIEWED_NPM_AUDIT)};`,
          'Object.defineProperty(process, "version", { value: "v22.23.2" });',
          "process.argv[1] = entrypoint;",
          `await import(${JSON.stringify(entrypoint)});`,
        ].join("\n"),
      ],
      {
        cwd: REPOSITORY_ROOT,
        encoding: "utf8",
        env: {
          ...process.env,
          NEMOCLAW_REVIEWED_NPM_AUDIT_REPORT_DIR: `../${CREDENTIAL_CANARY}`,
        },
      },
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Reviewed npm audit failed.");
    expect(result.stderr).not.toContain(CREDENTIAL_CANARY);
  });

  it("omits inherited credentials from an npm remediation failure (#11673)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-fatal-diagnostic-"));
    try {
      const executableDirectory = path.join(root, "bin");
      const tar = path.join(executableDirectory, "tar");
      fs.mkdirSync(executableDirectory, { mode: 0o700 });
      fs.writeFileSync(
        tar,
        ["#!/bin/sh", 'printf "%s\\n" "$NEMOCLAW_FATAL_DIAGNOSTIC_CANARY" >&2', "exit 1", ""].join(
          "\n",
        ),
        { mode: 0o700 },
      );

      const result = spawnSync(
        process.execPath,
        [
          OPENCLAW_NPM_REMEDIATION,
          "--archive",
          path.join(REPOSITORY_ROOT, "package.json"),
          "--package-spec",
          "openclaw@2026.7.1",
          "--working-directory",
          root,
        ],
        {
          cwd: REPOSITORY_ROOT,
          encoding: "utf8",
          env: {
            ...process.env,
            NEMOCLAW_FATAL_DIAGNOSTIC_CANARY: CREDENTIAL_CANARY,
            PATH: `${executableDirectory}${path.delimiter}${process.env.PATH ?? ""}`,
          },
        },
      );

      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("OpenClaw npm remediation command failed.");
      expect(result.stderr).not.toContain(CREDENTIAL_CANARY);
    } finally {
      fs.rmSync(root, { force: true, recursive: true });
    }
  });

  it("classifies missing remediation arguments without echoing their values (#11673)", () => {
    const result = spawnSync(process.execPath, [OPENCLAW_NPM_REMEDIATION], {
      cwd: REPOSITORY_ROOT,
      encoding: "utf8",
      env: process.env,
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("OpenClaw npm remediation is missing required arguments.");
    expect(result.stderr).not.toContain("--archive");
  });
});
