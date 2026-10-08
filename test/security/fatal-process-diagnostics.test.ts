// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  fatalMessagingBuildDiagnostic,
  OfficialPluginRemediationError,
} from "../../src/lib/messaging/applier/build/messaging-build-applier.mts";
import { OpenClawNpmRemediationCommandError } from "../../scripts/lib/openclaw-npm-remediation.mts";

import { createSlackRemediationFixture } from "../support/slack-remediation-fixture";

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

function writeNpmFailureHook(root: string, unavailable: boolean): string {
  const hookPath = path.join(root, "npm-remediation-failure-hook.mjs");
  fs.writeFileSync(
    hookPath,
    [
      'import childProcess from "node:child_process";',
      'import { syncBuiltinESMExports } from "node:module";',
      "const originalSpawnSync = childProcess.spawnSync;",
      "childProcess.spawnSync = function (command, args, options) {",
      '  if (!Array.isArray(args) || !args.some((arg) => String(arg).includes("proxy-addr@2.0.8"))) {',
      "    return originalSpawnSync.call(this, command, args, options);",
      "  }",
      `  if (${unavailable}) {`,
      '    const error = Object.assign(new Error(process.env.NEMOCLAW_FATAL_DIAGNOSTIC_CANARY), { code: "ENOENT" });',
      "    return { error, output: [null, null, null], pid: undefined, signal: null, status: null, stderr: null, stdout: null };",
      "  }",
      '  const output = Buffer.from(process.env.NEMOCLAW_FATAL_DIAGNOSTIC_CANARY ?? "");',
      "  return { error: undefined, output: [null, output, output], pid: process.pid, signal: null, status: 1, stderr: output, stdout: output };",
      "};",
      "syncBuiltinESMExports();",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  return hookPath;
}

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
  it("reports remediation timeouts without exposing child details", () => {
    const timeout = Object.assign(new Error(CREDENTIAL_CANARY), { code: "ETIMEDOUT" });
    const remediationError = new OpenClawNpmRemediationCommandError(
      timeout,
      15 * 60_000,
      "fetch replacement",
    );
    const diagnostic = fatalMessagingBuildDiagnostic(
      new OfficialPluginRemediationError("slack", remediationError),
    );

    expect(diagnostic).toBe(
      "Official OpenClaw plugin 'slack' remediation operation 'fetch replacement' timed out after 15 minutes.",
    );
    expect(diagnostic).not.toContain(CREDENTIAL_CANARY);
  });

  it.each([
    {
      failure: "tar failure",
      executable: "tar",
      npmFailure: undefined,
      diagnostic: "Official OpenClaw plugin 'slack' remediation operation 'list archive' failed.",
    },
    {
      failure: "unavailable tar",
      executable: "unused-tar",
      npmFailure: undefined,
      diagnostic:
        "Official OpenClaw plugin 'slack' remediation operation 'list archive' could not start a required command.",
    },
    {
      failure: "npm failure",
      executable: undefined,
      npmFailure: "exit",
      diagnostic:
        "Official OpenClaw plugin 'slack' remediation operation 'fetch replacement' failed.",
    },
    {
      failure: "unavailable npm",
      executable: undefined,
      npmFailure: "unavailable",
      diagnostic:
        "Official OpenClaw plugin 'slack' remediation operation 'fetch replacement' could not start a required command.",
    },
  ])(
    "identifies Slack remediation $failure without exposing child output",
    async ({ executable, npmFailure, diagnostic }) => {
      const fixture = await createSlackRemediationFixture();
      try {
        executable &&
          fs.writeFileSync(
            path.join(fixture.bin, executable),
            [
              "#!/bin/sh",
              'printf "%s\\n" "$NEMOCLAW_FATAL_DIAGNOSTIC_CANARY"',
              'printf "%s\\n" "$NEMOCLAW_FATAL_DIAGNOSTIC_CANARY" >&2',
              "exit 1",
              "",
            ].join("\n"),
            { mode: 0o700 },
          );
        const hookPath = npmFailure
          ? writeNpmFailureHook(fixture.root, npmFailure === "unavailable")
          : undefined;
        const result = spawnSync(
          process.execPath,
          [
            ...(hookPath ? ["--import", pathToFileURL(hookPath).href] : []),
            MESSAGING_BUILD_APPLIER,
            "--agent",
            "openclaw",
            "--phase",
            "agent-install",
          ],
          {
            cwd: REPOSITORY_ROOT,
            encoding: "utf8",
            env: {
              ...fixture.env,
              PATH: fixture.bin,
              NEMOCLAW_REVIEWED_NPM_ARCHIVE_DIR: npmFailure
                ? undefined
                : fixture.env.NEMOCLAW_REVIEWED_NPM_ARCHIVE_DIR,
              NEMOCLAW_REVIEWED_NPM_EXECUTABLE: npmFailure
                ? path.join(fixture.bin, "npm")
                : undefined,
              NEMOCLAW_FATAL_DIAGNOSTIC_CANARY: CREDENTIAL_CANARY,
            },
            timeout: 10_000,
          },
        );
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(2);
        expect(result.stderr).toContain(diagnostic);
        expect(result.stderr).not.toContain(CREDENTIAL_CANARY);
        expect(result.stderr).not.toContain(fixture.root);
        expect(result.stdout).not.toContain(CREDENTIAL_CANARY);
        expect(result.stdout).not.toContain(fixture.root);
        expect(fs.readFileSync(path.join(fixture.proxyAddrDirectory, "index.js"), "utf8")).toBe(
          "vulnerable fixture\n",
        );
        expect(
          JSON.parse(fs.readFileSync(path.join(fixture.proxyAddrDirectory, "package.json"), "utf8"))
            .version,
        ).toBe("2.0.7");
        expect(fs.readdirSync(fixture.env.TMPDIR)).toEqual([]);
      } finally {
        fs.rmSync(fixture.root, { recursive: true, force: true });
      }
    },
  );

  it("identifies Slack archive extraction failures without exposing child output", async () => {
    const fixture = await createSlackRemediationFixture();
    try {
      fs.writeFileSync(
        path.join(fixture.bin, "tar"),
        [
          "#!/bin/sh",
          'case "${1:-}" in',
          '  -tzf) printf "%s\\n" "package/package.json" ;;',
          '  -tvzf) printf "%s\\n" "-rw-r--r-- 0/0 1 2026-01-01 00:00 package/package.json" ;;',
          `  -xzf) printf "%s\\n" "$NEMOCLAW_FATAL_DIAGNOSTIC_CANARY" >&2; exit 1 ;;`,
          "  *) exit 1 ;;",
          "esac",
          "",
        ].join("\n"),
        { mode: 0o700 },
      );
      const result = spawnSync(
        process.execPath,
        [MESSAGING_BUILD_APPLIER, "--agent", "openclaw", "--phase", "agent-install"],
        {
          cwd: REPOSITORY_ROOT,
          encoding: "utf8",
          env: {
            ...fixture.env,
            NEMOCLAW_FATAL_DIAGNOSTIC_CANARY: CREDENTIAL_CANARY,
          },
          timeout: 10_000,
        },
      );

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(2);
      expect(result.stderr).toContain(
        "Official OpenClaw plugin 'slack' remediation operation 'extract archive' failed.",
      );
      expect(result.stderr).not.toContain(CREDENTIAL_CANARY);
      expect(result.stderr).not.toContain(fixture.root);
      expect(fs.readdirSync(fixture.env.TMPDIR)).toEqual([]);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it.each([
    {
      failure: "unavailable tar",
      directory: "work",
      diagnostic:
        "OpenClaw npm remediation operation 'list archive' could not start a required command.",
    },
    {
      failure: "inaccessible working directory",
      directory: "blocked/work",
      diagnostic: "OpenClaw npm remediation could not access its working files.",
    },
  ])("distinguishes $failure at the remediation entrypoint", ({ directory, diagnostic }) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-remediation-diagnostic-"));
    try {
      const bin = path.join(root, "bin");
      fs.mkdirSync(bin);
      fs.writeFileSync(path.join(root, "blocked"), CREDENTIAL_CANARY);
      const result = spawnSync(
        process.execPath,
        [
          OPENCLAW_NPM_REMEDIATION,
          "--archive",
          path.join(REPOSITORY_ROOT, "package.json"),
          "--package-spec",
          "@openclaw/slack@2026.9.2",
          "--working-directory",
          path.join(root, directory),
        ],
        {
          cwd: REPOSITORY_ROOT,
          encoding: "utf8",
          env: { PATH: bin, HOME: root },
          timeout: 10_000,
        },
      );
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(diagnostic);
      expect(result.stderr).not.toContain(CREDENTIAL_CANARY);
      expect(result.stderr).not.toContain(root);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

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
      expect(result.stderr).toContain("OpenClaw npm remediation operation 'list archive' failed.");
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
