// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const requireCache: Record<string, unknown> = require.cache as any;

function installMockPrivilegedExec(privilegedExecPath: string): () => void {
  const priorPrivilegedExec = require.cache[privilegedExecPath];
  requireCache[privilegedExecPath] = {
    id: privilegedExecPath,
    filename: privilegedExecPath,
    loaded: true,
    exports: {
      // Routing is covered by privileged-exec tests; this suite exercises
      // config validation and write behavior without requiring real Docker.
      privilegedSandboxExecArgv: (_sandboxName: string, cmd: readonly string[]) => [...cmd],
    },
  } as any;

  return () => {
    if (priorPrivilegedExec) requireCache[privilegedExecPath] = priorPrivilegedExec;
    else delete requireCache[privilegedExecPath];
  };
}

describe("config set nested URL SSRF enforcement", () => {
  it("rejects nested object/array URL values that target private hosts", async () => {
    const sandboxConfigPath = require.resolve("../dist/lib/sandbox/config");
    const openshellPath = require.resolve("../dist/lib/adapters/openshell/client");
    const shieldsAuditPath = require.resolve("../dist/lib/shields/audit");
    const privilegedExecPath = require.resolve("../dist/lib/sandbox/privileged-exec");

    const priorSandboxConfig = require.cache[sandboxConfigPath];
    const priorOpenshell = require.cache[openshellPath];
    const priorShieldsAudit = require.cache[shieldsAuditPath];
    const restorePrivilegedExec = installMockPrivilegedExec(privilegedExecPath);

    const childProcess = require("node:child_process");
    const originalExecFileSync = childProcess.execFileSync;
    const execSpy = vi.fn();
    childProcess.execFileSync = execSpy;

    delete require.cache[sandboxConfigPath];
    requireCache[openshellPath] = {
      id: openshellPath,
      filename: openshellPath,
      loaded: true,
      exports: {
        captureOpenshellCommand: () => ({
          status: 0,
          output: JSON.stringify({
            inference: { endpoints: {} },
          }),
        }),
        runOpenshellCommand: () => ({ status: 0 }),
      },
    } as any;
    requireCache[shieldsAuditPath] = {
      id: shieldsAuditPath,
      filename: shieldsAuditPath,
      loaded: true,
      exports: { appendAuditEntry: () => {} },
    } as any;

    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: string | number | null) => {
      throw new Error(`process.exit:${code ?? 0}`);
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      const { configSet } = require("../dist/lib/sandbox/config");
      const nestedValue = JSON.stringify({
        primary: "https://api.nvidia.com/v1",
        fallback: ["https://example.com/v1", { internal: "http://localhost:8080/internal" }],
      });

      await expect(
        configSet("sandbox-ssrf-test", {
          key: "inference.endpoints",
          value: nestedValue,
        }),
      ).rejects.toThrow(/URL validation failed/);

      expect(errorSpy).not.toHaveBeenCalled();
      expect(execSpy).not.toHaveBeenCalled();
    } finally {
      exitSpy.mockRestore();
      errorSpy.mockRestore();
      logSpy.mockRestore();
      childProcess.execFileSync = originalExecFileSync;

      if (priorSandboxConfig) requireCache[sandboxConfigPath] = priorSandboxConfig;
      else delete requireCache[sandboxConfigPath];

      if (priorOpenshell) requireCache[openshellPath] = priorOpenshell;
      else delete requireCache[openshellPath];

      if (priorShieldsAudit) requireCache[shieldsAuditPath] = priorShieldsAudit;
      else delete requireCache[shieldsAuditPath];

      restorePrivilegedExec();
    }
  });

  it("validates the key before doing URL or DNS validation", async () => {
    const sandboxConfigPath = require.resolve("../dist/lib/sandbox/config");
    const openshellPath = require.resolve("../dist/lib/adapters/openshell/client");
    const shieldsAuditPath = require.resolve("../dist/lib/shields/audit");
    const privilegedExecPath = require.resolve("../dist/lib/sandbox/privileged-exec");

    const priorSandboxConfig = require.cache[sandboxConfigPath];
    const priorOpenshell = require.cache[openshellPath];
    const priorShieldsAudit = require.cache[shieldsAuditPath];
    const restorePrivilegedExec = installMockPrivilegedExec(privilegedExecPath);

    const childProcess = require("node:child_process");
    const dns = require("node:dns");
    const originalExecFileSync = childProcess.execFileSync;
    const originalLookup = dns.promises.lookup;
    const execSpy = vi.fn();
    const lookupSpy = vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]);
    childProcess.execFileSync = execSpy;
    dns.promises.lookup = lookupSpy;

    delete require.cache[sandboxConfigPath];
    requireCache[openshellPath] = {
      id: openshellPath,
      filename: openshellPath,
      loaded: true,
      exports: {
        captureOpenshellCommand: () => ({
          status: 0,
          output: JSON.stringify({
            inference: { endpoints: {} },
          }),
        }),
        runOpenshellCommand: () => ({ status: 0 }),
      },
    } as any;
    requireCache[shieldsAuditPath] = {
      id: shieldsAuditPath,
      filename: shieldsAuditPath,
      loaded: true,
      exports: { appendAuditEntry: () => {} },
    } as any;

    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: string | number | null) => {
      throw new Error(`process.exit:${code ?? 0}`);
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      const { configSet } = require("../dist/lib/sandbox/config");

      await expect(
        configSet("sandbox-ssrf-test", {
          key: "not.a.real.key",
          value: JSON.stringify({ primary: "http://example.com/v1" }),
        }),
      ).rejects.toThrow(/does not currently exist/);

      expect(lookupSpy).not.toHaveBeenCalled();
      expect(execSpy).not.toHaveBeenCalled();
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      exitSpy.mockRestore();
      errorSpy.mockRestore();
      logSpy.mockRestore();
      childProcess.execFileSync = originalExecFileSync;
      dns.promises.lookup = originalLookup;

      if (priorSandboxConfig) requireCache[sandboxConfigPath] = priorSandboxConfig;
      else delete requireCache[sandboxConfigPath];

      if (priorOpenshell) requireCache[openshellPath] = priorOpenshell;
      else delete requireCache[openshellPath];

      if (priorShieldsAudit) requireCache[shieldsAuditPath] = priorShieldsAudit;
      else delete requireCache[shieldsAuditPath];

      restorePrivilegedExec();
    }
  });

  it("accepts nested object/array URL values when all are public", async () => {
    const sandboxConfigPath = require.resolve("../dist/lib/sandbox/config");
    const openshellPath = require.resolve("../dist/lib/adapters/openshell/client");
    const shieldsAuditPath = require.resolve("../dist/lib/shields/audit");
    const privilegedExecPath = require.resolve("../dist/lib/sandbox/privileged-exec");

    const priorSandboxConfig = require.cache[sandboxConfigPath];
    const priorOpenshell = require.cache[openshellPath];
    const priorShieldsAudit = require.cache[shieldsAuditPath];
    const restorePrivilegedExec = installMockPrivilegedExec(privilegedExecPath);

    const childProcess = require("node:child_process");
    const originalExecFileSync = childProcess.execFileSync;
    const execSpy = vi.fn();
    childProcess.execFileSync = execSpy;

    delete require.cache[sandboxConfigPath];
    requireCache[openshellPath] = {
      id: openshellPath,
      filename: openshellPath,
      loaded: true,
      exports: {
        captureOpenshellCommand: () => ({
          status: 0,
          output: JSON.stringify({
            inference: { endpoints: {} },
          }),
        }),
        runOpenshellCommand: () => ({ status: 0 }),
      },
    } as any;
    requireCache[shieldsAuditPath] = {
      id: shieldsAuditPath,
      filename: shieldsAuditPath,
      loaded: true,
      exports: { appendAuditEntry: () => {} },
    } as any;

    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: string | number | null) => {
      throw new Error(`process.exit:${code ?? 0}`);
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      const { configSet } = require("../dist/lib/sandbox/config");
      const nestedValue = JSON.stringify({
        primary: "https://93.184.216.34/v1",
        fallback: ["http://93.184.216.35/v1", { backup: "https://93.184.216.36/v2" }],
      });

      await expect(
        configSet("sandbox-ssrf-test", {
          key: "inference.endpoints",
          value: nestedValue,
        }),
      ).resolves.toBeUndefined();

      expect(errorSpy).not.toHaveBeenCalled();
      expect(execSpy).toHaveBeenCalled();
    } finally {
      exitSpy.mockRestore();
      errorSpy.mockRestore();
      logSpy.mockRestore();
      childProcess.execFileSync = originalExecFileSync;

      if (priorSandboxConfig) requireCache[sandboxConfigPath] = priorSandboxConfig;
      else delete requireCache[sandboxConfigPath];

      if (priorOpenshell) requireCache[openshellPath] = priorOpenshell;
      else delete requireCache[openshellPath];

      if (priorShieldsAudit) requireCache[shieldsAuditPath] = priorShieldsAudit;
      else delete requireCache[shieldsAuditPath];

      restorePrivilegedExec();
    }
  });

  it("ignores nested non-http URL-like strings and does not crash", async () => {
    const sandboxConfigPath = require.resolve("../dist/lib/sandbox/config");
    const openshellPath = require.resolve("../dist/lib/adapters/openshell/client");
    const shieldsAuditPath = require.resolve("../dist/lib/shields/audit");
    const privilegedExecPath = require.resolve("../dist/lib/sandbox/privileged-exec");

    const priorSandboxConfig = require.cache[sandboxConfigPath];
    const priorOpenshell = require.cache[openshellPath];
    const priorShieldsAudit = require.cache[shieldsAuditPath];
    const restorePrivilegedExec = installMockPrivilegedExec(privilegedExecPath);

    const childProcess = require("node:child_process");
    const originalExecFileSync = childProcess.execFileSync;
    const execSpy = vi.fn();
    childProcess.execFileSync = execSpy;

    delete require.cache[sandboxConfigPath];
    requireCache[openshellPath] = {
      id: openshellPath,
      filename: openshellPath,
      loaded: true,
      exports: {
        captureOpenshellCommand: () => ({
          status: 0,
          output: JSON.stringify({
            inference: { endpoints: {} },
          }),
        }),
        runOpenshellCommand: () => ({ status: 0 }),
      },
    } as any;
    requireCache[shieldsAuditPath] = {
      id: shieldsAuditPath,
      filename: shieldsAuditPath,
      loaded: true,
      exports: { appendAuditEntry: () => {} },
    } as any;

    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: string | number | null) => {
      throw new Error(`process.exit:${code ?? 0}`);
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      const { configSet } = require("../dist/lib/sandbox/config");
      const nestedValue = JSON.stringify({
        ftpUrl: "ftp://files.example.com",
        plainText: "not-a-url",
        mixed: ["mailto:user@example.com", "   ftp://also.example.com"],
      });

      await expect(
        configSet("sandbox-ssrf-test", {
          key: "inference.endpoints",
          value: nestedValue,
        }),
      ).resolves.toBeUndefined();

      expect(errorSpy).not.toHaveBeenCalled();
      expect(execSpy).toHaveBeenCalled();
    } finally {
      exitSpy.mockRestore();
      errorSpy.mockRestore();
      logSpy.mockRestore();
      childProcess.execFileSync = originalExecFileSync;

      if (priorSandboxConfig) requireCache[sandboxConfigPath] = priorSandboxConfig;
      else delete requireCache[sandboxConfigPath];

      if (priorOpenshell) requireCache[openshellPath] = priorOpenshell;
      else delete requireCache[openshellPath];

      if (priorShieldsAudit) requireCache[shieldsAuditPath] = priorShieldsAudit;
      else delete requireCache[shieldsAuditPath];

      restorePrivilegedExec();
    }
  });

  it("recognizes mixed-case http and https schemes in nested values", async () => {
    const sandboxConfigPath = require.resolve("../dist/lib/sandbox/config");
    const openshellPath = require.resolve("../dist/lib/adapters/openshell/client");
    const shieldsAuditPath = require.resolve("../dist/lib/shields/audit");
    const privilegedExecPath = require.resolve("../dist/lib/sandbox/privileged-exec");

    const priorSandboxConfig = require.cache[sandboxConfigPath];
    const priorOpenshell = require.cache[openshellPath];
    const priorShieldsAudit = require.cache[shieldsAuditPath];
    const restorePrivilegedExec = installMockPrivilegedExec(privilegedExecPath);

    const childProcess = require("node:child_process");
    const originalExecFileSync = childProcess.execFileSync;
    const execSpy = vi.fn();
    childProcess.execFileSync = execSpy;

    delete require.cache[sandboxConfigPath];
    requireCache[openshellPath] = {
      id: openshellPath,
      filename: openshellPath,
      loaded: true,
      exports: {
        captureOpenshellCommand: () => ({
          status: 0,
          output: JSON.stringify({
            inference: { endpoints: {} },
          }),
        }),
        runOpenshellCommand: () => ({ status: 0 }),
      },
    } as any;
    requireCache[shieldsAuditPath] = {
      id: shieldsAuditPath,
      filename: shieldsAuditPath,
      loaded: true,
      exports: { appendAuditEntry: () => {} },
    } as any;

    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: string | number | null) => {
      throw new Error(`process.exit:${code ?? 0}`);
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      const { configSet } = require("../dist/lib/sandbox/config");
      const nestedValue = JSON.stringify({
        primary: "HTTP://93.184.216.34/v1",
        fallback: ["HtTpS://93.184.216.35/v2", { backup: "hTtP://93.184.216.36/v3" }],
      });

      await expect(
        configSet("sandbox-ssrf-test", {
          key: "inference.endpoints",
          value: nestedValue,
        }),
      ).resolves.toBeUndefined();

      expect(errorSpy).not.toHaveBeenCalled();
      expect(execSpy).toHaveBeenCalled();
    } finally {
      exitSpy.mockRestore();
      errorSpy.mockRestore();
      logSpy.mockRestore();
      childProcess.execFileSync = originalExecFileSync;

      if (priorSandboxConfig) requireCache[sandboxConfigPath] = priorSandboxConfig;
      else delete requireCache[sandboxConfigPath];

      if (priorOpenshell) requireCache[openshellPath] = priorOpenshell;
      else delete requireCache[openshellPath];

      if (priorShieldsAudit) requireCache[shieldsAuditPath] = priorShieldsAudit;
      else delete requireCache[shieldsAuditPath];

      restorePrivilegedExec();
    }
  });

  it("redacts credentials, query strings, and fragments in validation errors", async () => {
    const sandboxConfigPath = require.resolve("../dist/lib/sandbox/config");
    const openshellPath = require.resolve("../dist/lib/adapters/openshell/client");
    const shieldsAuditPath = require.resolve("../dist/lib/shields/audit");
    const privilegedExecPath = require.resolve("../dist/lib/sandbox/privileged-exec");

    const priorSandboxConfig = require.cache[sandboxConfigPath];
    const priorOpenshell = require.cache[openshellPath];
    const priorShieldsAudit = require.cache[shieldsAuditPath];
    const restorePrivilegedExec = installMockPrivilegedExec(privilegedExecPath);

    const childProcess = require("node:child_process");
    const originalExecFileSync = childProcess.execFileSync;
    const execSpy = vi.fn();
    childProcess.execFileSync = execSpy;

    delete require.cache[sandboxConfigPath];
    requireCache[openshellPath] = {
      id: openshellPath,
      filename: openshellPath,
      loaded: true,
      exports: {
        captureOpenshellCommand: () => ({
          status: 0,
          output: JSON.stringify({
            inference: { endpoints: {} },
          }),
        }),
        runOpenshellCommand: () => ({ status: 0 }),
      },
    } as any;
    requireCache[shieldsAuditPath] = {
      id: shieldsAuditPath,
      filename: shieldsAuditPath,
      loaded: true,
      exports: { appendAuditEntry: () => {} },
    } as any;

    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: string | number | null) => {
      throw new Error(`process.exit:${code ?? 0}`);
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      const { configSet } = require("../dist/lib/sandbox/config");
      const nestedValue = JSON.stringify({
        primary: "http://user:pass@127.0.0.1:8080/private/path?token=secret#frag",
      });

      let thrown = "";
      try {
        await configSet("sandbox-ssrf-test", {
          key: "inference.endpoints",
          value: nestedValue,
        });
      } catch (error) {
        thrown = error instanceof Error ? error.message : String(error);
      }

      expect(thrown).toContain("URL validation failed for http://127.0.0.1:8080/private/path");
      expect(thrown).not.toContain("user:pass");
      expect(thrown).not.toContain("token=secret");
      expect(thrown).not.toContain("#frag");
      const consoleOutput = [...errorSpy.mock.calls, ...logSpy.mock.calls]
        .flat()
        .map((entry) => String(entry))
        .join("\n");
      expect(consoleOutput).not.toContain("user:pass");
      expect(consoleOutput).not.toContain("token=secret");
      expect(consoleOutput).not.toContain("#frag");
      expect(execSpy).not.toHaveBeenCalled();
    } finally {
      exitSpy.mockRestore();
      errorSpy.mockRestore();
      logSpy.mockRestore();
      childProcess.execFileSync = originalExecFileSync;

      if (priorSandboxConfig) requireCache[sandboxConfigPath] = priorSandboxConfig;
      else delete requireCache[sandboxConfigPath];

      if (priorOpenshell) requireCache[openshellPath] = priorOpenshell;
      else delete requireCache[openshellPath];

      if (priorShieldsAudit) requireCache[shieldsAuditPath] = priorShieldsAudit;
      else delete requireCache[shieldsAuditPath];

      restorePrivilegedExec();
    }
  });
});
