// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { execTimeout, testTimeout } from "../../helpers/timeouts";

vi.setConfig({ testTimeout: testTimeout(15_000) });

const LAUNCH_READINESS_FIXTURE_POLICY = `version: 1
network_policies: {}
`;

function writeSandboxRegistry(home: string): void {
  fs.mkdirSync(path.join(home, ".nemoclaw"), { recursive: true });
  fs.writeFileSync(
    path.join(home, ".nemoclaw", "sandboxes.json"),
    JSON.stringify({
      sandboxes: {
        alpha: {
          name: "alpha",
          model: "test-model",
          provider: "nvidia-prod",
          gpuEnabled: false,
          policies: [],
        },
      },
      defaultSandbox: "alpha",
    }),
    { mode: 0o600 },
  );
}

function runWithEnv(args: readonly string[], env: NodeJS.ProcessEnv) {
  const result = spawnSync(process.execPath, [path.resolve("bin/nemoclaw.js"), ...args], {
    encoding: "utf8",
    timeout: execTimeout(),
    env: {
      ...process.env,
      NODE_OPTIONS: "",
      NEMOCLAW_HEALTH_POLL_COUNT: "1",
      NEMOCLAW_HEALTH_POLL_INTERVAL: "0",
      ...env,
    },
  });
  expect(result.error).toBeUndefined();
  return { code: result.status, out: result.stdout + result.stderr };
}

function buildStubOpenshell(
  home: string,
  logFile: string,
  sourceKind = "file",
  transferExit = 0,
): string {
  const localBin = path.join(home, "bin");
  fs.mkdirSync(localBin, { recursive: true });
  fs.writeFileSync(
    path.join(localBin, "openshell"),
    [
      "#!/usr/bin/env bash",
      `printf '%s\\n' "$*" >> ${JSON.stringify(logFile)}`,
      'case "$*" in',
      `  "policy get"*) printf '%b' ${JSON.stringify(LAUNCH_READINESS_FIXTURE_POLICY)}; exit 0 ;;`,
      '  "sandbox list"*) printf "alpha Ready\\n"; exit 0 ;;',
      '  "sandbox get alpha"*) printf "Name: alpha\\nPhase: Ready\\nPolicy:\\n"; exit 0 ;;',
      '  "gateway info -g nemoclaw"*) printf "Gateway: nemoclaw\\n"; exit 0 ;;',
      `  "sandbox exec --name alpha -g nemoclaw -- sh -c"*) printf ${JSON.stringify(sourceKind)}; exit 0 ;;`,
      `  "sandbox download -g nemoclaw alpha"*) artifact="\${!#}"; printf "downloaded" > "$artifact"; exit ${transferExit} ;;`,
      `  "sandbox upload -g nemoclaw alpha"*) exit ${transferExit} ;;`,
      "  *) exit 0 ;;",
      "esac",
    ].join("\n"),
    { mode: 0o755 },
  );
  return localBin;
}

describe("sandbox download/upload CLI wrappers", () => {
  it.each([
    ["upload", 7],
    ["download", 1],
  ] as const)(
    "preserves %s failure exit codes after asynchronous cleanup",
    (direction, expectedCode) => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-transfer-exit-"));
      try {
        writeSandboxRegistry(home);
        const localBin = buildStubOpenshell(home, path.join(home, "calls.log"), "file", 7);
        const result = runWithEnv(["alpha", direction, "/sandbox/file", path.join(home, "out")], {
          HOME: home,
          PATH: `${localBin}:${process.env.PATH || ""}`,
        });
        expect(result.code).toBe(expectedCode);
        expect(result.out).toContain("exit 7");
        expect(fs.existsSync(path.join(home, "out"))).toBe(false);
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    },
  );

  it("publishes a staged download to a host destination resolved against the caller cwd", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-sandbox-download-"));
    try {
      writeSandboxRegistry(home);
      const openshellLog = path.join(home, "openshell-calls.log");
      const localBin = buildStubOpenshell(home, openshellLog);
      const relativeHostDest = path.relative(process.cwd(), path.join(home, "out"));

      const result = runWithEnv(
        ["alpha", "download", "/sandbox/.openclaw/workspace/SOUL.md", relativeHostDest],
        {
          HOME: home,
          PATH: `${localBin}:${process.env.PATH || ""}`,
        },
      );
      expect(result.code).toBe(0);

      const calls = fs.readFileSync(openshellLog, "utf8");
      const expectedHostDest = path.resolve(process.cwd(), relativeHostDest);
      expect(calls).toMatch(
        /sandbox download -g nemoclaw alpha \/sandbox\/\.openclaw\/workspace\/SOUL\.md .*nemoclaw-download-.*\/artifact/,
      );
      expect(fs.readFileSync(expectedHostDest, "utf8")).toBe("downloaded");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("defaults the host destination to the caller cwd when omitted", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-sandbox-download-default-"));
    const artifactName = `nemoclaw-download-default-${path.basename(home)}`;
    const expectedHostDest = path.join(process.cwd(), artifactName);
    try {
      writeSandboxRegistry(home);
      const openshellLog = path.join(home, "openshell-calls.log");
      const localBin = buildStubOpenshell(home, openshellLog);

      const result = runWithEnv(["alpha", "download", `/sandbox/.openclaw/${artifactName}`], {
        HOME: home,
        PATH: `${localBin}:${process.env.PATH || ""}`,
      });
      expect(result.code).toBe(0);

      const calls = fs.readFileSync(openshellLog, "utf8");
      expect(calls).toContain(
        `sandbox download -g nemoclaw alpha /sandbox/.openclaw/${artifactName} `,
      );
      expect(calls).toMatch(/nemoclaw-download-.*\/artifact/);
      expect(fs.readFileSync(expectedHostDest, "utf8")).toBe("downloaded");
    } finally {
      fs.rmSync(expectedHostDest, { force: true });
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("uses exit status 2 when the sandbox source is absent", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-sandbox-missing-"));
    try {
      writeSandboxRegistry(home);
      const openshellLog = path.join(home, "openshell-calls.log");
      const localBin = buildStubOpenshell(home, openshellLog, "missing");

      const result = runWithEnv(["alpha", "download", "/sandbox/missing"], {
        HOME: home,
        PATH: `${localBin}:${process.env.PATH || ""}`,
      });

      expect(result.code).toBe(2);
      expect(result.out).toContain("no such path in the sandbox");
      expect(fs.readFileSync(openshellLog, "utf8")).not.toContain(
        "sandbox download -g nemoclaw alpha",
      );
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("forwards `<name> upload <host-path> [sandbox-dest]` to openshell with the host-path resolved against the caller cwd", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-sandbox-upload-"));
    try {
      writeSandboxRegistry(home);
      const openshellLog = path.join(home, "openshell-calls.log");
      const localBin = buildStubOpenshell(home, openshellLog);

      const result = runWithEnv(
        ["alpha", "upload", "./SOUL.md", "/sandbox/.openclaw/workspace/SOUL.md"],
        {
          HOME: home,
          PATH: `${localBin}:${process.env.PATH || ""}`,
        },
      );
      expect(result.code).toBe(0);

      const calls = fs.readFileSync(openshellLog, "utf8");
      const expectedHostPath = path.resolve(process.cwd(), "SOUL.md");
      expect(calls).toContain(
        `sandbox upload -g nemoclaw alpha ${expectedHostPath} /sandbox/.openclaw/workspace/SOUL.md`,
      );
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("defaults the sandbox destination to /sandbox/ when omitted and still resolves the host path against the caller cwd", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-sandbox-upload-default-"));
    try {
      writeSandboxRegistry(home);
      const openshellLog = path.join(home, "openshell-calls.log");
      const localBin = buildStubOpenshell(home, openshellLog);

      const result = runWithEnv(["alpha", "upload", "./x"], {
        HOME: home,
        PATH: `${localBin}:${process.env.PATH || ""}`,
      });
      expect(result.code).toBe(0);

      const calls = fs.readFileSync(openshellLog, "utf8");
      const expectedHostPath = path.resolve(process.cwd(), "x");
      expect(calls).toContain(`sandbox upload -g nemoclaw alpha ${expectedHostPath} /sandbox/`);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
