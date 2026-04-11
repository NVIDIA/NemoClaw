// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import assert from "node:assert/strict";
import { execSync, execFileSync } from "node:child_process";
import { writeFileSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { resolveOpenshell } = require("../bin/lib/resolve-openshell");
const { getServiceSandboxEnv } = require("../bin/nemoclaw.js");

describe("service environment", () => {
  describe("resolveOpenshell logic", () => {
    it("returns command -v result when absolute path", () => {
      expect(resolveOpenshell({ commandVResult: "/usr/bin/openshell" })).toBe("/usr/bin/openshell");
    });

    it("rejects non-absolute command -v result (alias)", () => {
      expect(resolveOpenshell({ commandVResult: "openshell", checkExecutable: () => false })).toBe(
        null,
      );
    });

    it("rejects alias definition from command -v", () => {
      expect(
        resolveOpenshell({
          commandVResult: "alias openshell='echo pwned'",
          checkExecutable: () => false,
        }),
      ).toBe(null);
    });

    it("falls back to ~/.local/bin when command -v fails", () => {
      expect(
        resolveOpenshell({
          commandVResult: null,
          checkExecutable: (p) => p === "/fakehome/.local/bin/openshell",
          home: "/fakehome",
        }),
      ).toBe("/fakehome/.local/bin/openshell");
    });

    it("falls back to /usr/local/bin", () => {
      expect(
        resolveOpenshell({
          commandVResult: null,
          checkExecutable: (p) => p === "/usr/local/bin/openshell",
        }),
      ).toBe("/usr/local/bin/openshell");
    });

    it("falls back to /usr/bin", () => {
      expect(
        resolveOpenshell({
          commandVResult: null,
          checkExecutable: (p) => p === "/usr/bin/openshell",
        }),
      ).toBe("/usr/bin/openshell");
    });

    it("prefers ~/.local/bin over /usr/local/bin", () => {
      expect(
        resolveOpenshell({
          commandVResult: null,
          checkExecutable: (p) =>
            p === "/fakehome/.local/bin/openshell" || p === "/usr/local/bin/openshell",
          home: "/fakehome",
        }),
      ).toBe("/fakehome/.local/bin/openshell");
    });

    it("returns null when openshell not found anywhere", () => {
      expect(
        resolveOpenshell({
          commandVResult: null,
          checkExecutable: () => false,
        }),
      ).toBe(null);
    });
  });

  describe("SANDBOX_NAME defaulting", () => {
    it("nemoclaw service commands reuse the default sandbox name", () => {
      const envPrefix = getServiceSandboxEnv(() => ({
        sandboxes: [{ name: "the-crucible" }],
        defaultSandbox: "the-crucible",
      }));
      assert.equal(envPrefix, 'SANDBOX_NAME="the-crucible" ');
    });

    it("nemoclaw service commands skip invalid sandbox names", () => {
      const envPrefix = getServiceSandboxEnv(() => ({
        sandboxes: [{ name: "bad name" }],
        defaultSandbox: "bad name",
      }));
      assert.equal(envPrefix, "");
    });

    it("start-services.sh preserves existing SANDBOX_NAME", () => {
      const result = execSync(
        'bash -c \'SANDBOX_NAME="${NEMOCLAW_SANDBOX:-${SANDBOX_NAME:-default}}"; export SANDBOX_NAME; bash -c "echo \\$SANDBOX_NAME"\'',
        {
          encoding: "utf-8",
          env: { ...process.env, NEMOCLAW_SANDBOX: "", SANDBOX_NAME: "my-box" },
        },
      ).trim();
      expect(result).toBe("my-box");
    });

    it("start-services.sh uses NEMOCLAW_SANDBOX over SANDBOX_NAME", () => {
      const result = execSync(
        'bash -c \'SANDBOX_NAME="${NEMOCLAW_SANDBOX:-${SANDBOX_NAME:-default}}"; export SANDBOX_NAME; bash -c "echo \\$SANDBOX_NAME"\'',
        {
          encoding: "utf-8",
          env: { ...process.env, NEMOCLAW_SANDBOX: "from-env", SANDBOX_NAME: "old" },
        },
      ).trim();
      expect(result).toBe("from-env");
    });

    it("start-services.sh falls back to default when both unset", () => {
      const result = execSync(
        'bash -c \'SANDBOX_NAME="${NEMOCLAW_SANDBOX:-${SANDBOX_NAME:-default}}"; export SANDBOX_NAME; bash -c "echo \\$SANDBOX_NAME"\'',
        {
          encoding: "utf-8",
          env: { ...process.env, NEMOCLAW_SANDBOX: "", SANDBOX_NAME: "" },
        },
      ).trim();
      expect(result).toBe("default");
    });
  });

  describe("proxy environment variables (issue #626)", () => {
    function extractProxyVars(env = {}) {
      const scriptPath = join(import.meta.dirname, "../scripts/nemoclaw-start.sh");
      const proxyBlock = execFileSync(
        "sed",
        ["-n", "/^PROXY_HOST=/,/^export no_proxy=/p", scriptPath],
        { encoding: "utf-8" },
      );
      if (!proxyBlock.trim()) {
        throw new Error(
          "Failed to extract proxy configuration from scripts/nemoclaw-start.sh — " +
            "the PROXY_HOST..no_proxy block may have been moved or renamed",
        );
      }
      const wrapper = [
        "#!/usr/bin/env bash",
        proxyBlock.trimEnd(),
        'echo "HTTP_PROXY=${HTTP_PROXY}"',
        'echo "HTTPS_PROXY=${HTTPS_PROXY}"',
        'echo "NO_PROXY=${NO_PROXY}"',
        'echo "http_proxy=${http_proxy}"',
        'echo "https_proxy=${https_proxy}"',
        'echo "no_proxy=${no_proxy}"',
      ].join("\n");
      const tmpFile = join(tmpdir(), `nemoclaw-proxy-test-${process.pid}.sh`);
      try {
        writeFileSync(tmpFile, wrapper, { mode: 0o700 });
        const out = execFileSync("bash", [tmpFile], {
          encoding: "utf-8",
          env: { ...process.env, ...env },
        }).trim();
        return Object.fromEntries(
          out.split("\n").map((l) => {
            const idx = l.indexOf("=");
            return [l.slice(0, idx), l.slice(idx + 1)];
          }),
        );
      } finally {
        try {
          unlinkSync(tmpFile);
        } catch {
          /* ignore */
        }
      }
    }

    it("sets HTTP_PROXY to default gateway address", () => {
      const vars = extractProxyVars();
      expect(vars.HTTP_PROXY).toBe("http://10.200.0.1:3128");
    });

    it("sets HTTPS_PROXY to default gateway address", () => {
      const vars = extractProxyVars();
      expect(vars.HTTPS_PROXY).toBe("http://10.200.0.1:3128");
    });

    it("NEMOCLAW_PROXY_HOST overrides default gateway IP", () => {
      const vars = extractProxyVars({ NEMOCLAW_PROXY_HOST: "192.168.64.1" });
      expect(vars.HTTP_PROXY).toBe("http://192.168.64.1:3128");
      expect(vars.HTTPS_PROXY).toBe("http://192.168.64.1:3128");
    });

    it("NEMOCLAW_PROXY_PORT overrides default proxy port", () => {
      const vars = extractProxyVars({ NEMOCLAW_PROXY_PORT: "8080" });
      expect(vars.HTTP_PROXY).toBe("http://10.200.0.1:8080");
      expect(vars.HTTPS_PROXY).toBe("http://10.200.0.1:8080");
    });

    it("NO_PROXY includes loopback only, not inference.local", () => {
      const vars = extractProxyVars();
      const noProxy = vars.NO_PROXY.split(",");
      expect(noProxy).toContain("localhost");
      expect(noProxy).toContain("127.0.0.1");
      expect(noProxy).toContain("::1");
      expect(noProxy).not.toContain("inference.local");
    });

    it("NO_PROXY includes OpenShell gateway IP", () => {
      const vars = extractProxyVars();
      expect(vars.NO_PROXY).toContain("10.200.0.1");
    });

    it("exports lowercase proxy variants for undici/gRPC compatibility", () => {
      const vars = extractProxyVars();
      expect(vars.http_proxy).toBe("http://10.200.0.1:3128");
      expect(vars.https_proxy).toBe("http://10.200.0.1:3128");
      const noProxy = vars.no_proxy.split(",");
      expect(noProxy).not.toContain("inference.local");
      expect(noProxy).toContain("10.200.0.1");
    });

    it("entrypoint persistence writes proxy snippet to env file", () => {
      const proxyEnvFile = join(tmpdir(), `nemoclaw-proxy-env-test-${process.pid}.sh`);
      const tmpFile = join(tmpdir(), `nemoclaw-bashrc-write-test-${process.pid}.sh`);
      try {
        const scriptPath = join(import.meta.dirname, "../scripts/nemoclaw-start.sh");
        let persistBlock = execFileSync(
          "sed",
          ["-n", "/^_PROXY_URL=/,/^# ── Main/{ /^# ── Main/d; p; }", scriptPath],
          { encoding: "utf-8" },
        );
        persistBlock = persistBlock.replace(
          '_PROXY_ENV_FILE="/tmp/nemoclaw-proxy-env.sh"',
          `_PROXY_ENV_FILE="${proxyEnvFile}"`,
        );
        const wrapper = [
          "#!/usr/bin/env bash",
          'PROXY_HOST="10.200.0.1"',
          'PROXY_PORT="3128"',
          "_TOOL_REDIRECTS=()",
          persistBlock.trimEnd(),
        ].join("\n");
        writeFileSync(tmpFile, wrapper, { mode: 0o700 });
        execFileSync("bash", [tmpFile], {
          encoding: "utf-8",
          env: { ...process.env },
        });

        const envContent = readFileSync(proxyEnvFile, "utf-8");
        expect(envContent).toContain("export HTTP_PROXY=");
        expect(envContent).toContain("export HTTPS_PROXY=");
        expect(envContent).toContain("export NO_PROXY=");
        expect(envContent).not.toContain("inference.local");
        expect(envContent).toContain("10.200.0.1");
      } finally {
        try {
          unlinkSync(tmpFile);
        } catch {
          /* ignore */
        }
        try {
          unlinkSync(proxyEnvFile);
        } catch {
          /* ignore */
        }
      }
    });

    it("entrypoint persistence is idempotent across repeated invocations", () => {
      const proxyEnvFile = join(tmpdir(), `nemoclaw-idempotent-env-test-${process.pid}.sh`);
      const tmpFile = join(tmpdir(), `nemoclaw-idempotent-write-test-${process.pid}.sh`);
      try {
        const scriptPath = join(import.meta.dirname, "../scripts/nemoclaw-start.sh");
        let persistBlock = execFileSync(
          "sed",
          ["-n", "/^_PROXY_URL=/,/^# ── Main/{ /^# ── Main/d; p; }", scriptPath],
          { encoding: "utf-8" },
        );
        persistBlock = persistBlock.replace(
          '_PROXY_ENV_FILE="/tmp/nemoclaw-proxy-env.sh"',
          `_PROXY_ENV_FILE="${proxyEnvFile}"`,
        );
        const wrapper = [
          "#!/usr/bin/env bash",
          'PROXY_HOST="10.200.0.1"',
          'PROXY_PORT="3128"',
          "_TOOL_REDIRECTS=()",
          persistBlock.trimEnd(),
        ].join("\n");
        writeFileSync(tmpFile, wrapper, { mode: 0o700 });
        const runOpts = { encoding: /** @type {const} */ ("utf-8") };
        execFileSync("bash", [tmpFile], runOpts);
        execFileSync("bash", [tmpFile], runOpts);
        execFileSync("bash", [tmpFile], runOpts);

        const envContent = readFileSync(proxyEnvFile, "utf-8");
        // File is rewritten each time (rm + write), so no duplicates
        const proxyLines = (envContent.match(/export HTTP_PROXY=/g) || []).length;
        expect(proxyLines).toBe(1);
      } finally {
        try {
          unlinkSync(tmpFile);
        } catch {
          /* ignore */
        }
        try {
          unlinkSync(proxyEnvFile);
        } catch {
          /* ignore */
        }
      }
    });

    it("entrypoint persistence replaces stale proxy values on restart", () => {
      const proxyEnvFile = join(tmpdir(), `nemoclaw-replace-env-test-${process.pid}.sh`);
      const tmpFile = join(tmpdir(), `nemoclaw-replace-write-test-${process.pid}.sh`);
      try {
        const scriptPath = join(import.meta.dirname, "../scripts/nemoclaw-start.sh");
        let persistBlock = execFileSync(
          "sed",
          ["-n", "/^_PROXY_URL=/,/^# ── Main/{ /^# ── Main/d; p; }", scriptPath],
          { encoding: "utf-8" },
        );
        persistBlock = persistBlock.replace(
          '_PROXY_ENV_FILE="/tmp/nemoclaw-proxy-env.sh"',
          `_PROXY_ENV_FILE="${proxyEnvFile}"`,
        );
        const makeWrapper = (host) =>
          [
            "#!/usr/bin/env bash",
            `PROXY_HOST="${host}"`,
            'PROXY_PORT="3128"',
            "_TOOL_REDIRECTS=()",
            persistBlock.trimEnd(),
          ].join("\n");

        writeFileSync(tmpFile, makeWrapper("10.200.0.1"), { mode: 0o700 });
        execFileSync("bash", [tmpFile], { encoding: "utf-8" });
        let envContent = readFileSync(proxyEnvFile, "utf-8");
        expect(envContent).toContain("10.200.0.1");

        writeFileSync(tmpFile, makeWrapper("192.168.1.99"), { mode: 0o700 });
        execFileSync("bash", [tmpFile], { encoding: "utf-8" });
        envContent = readFileSync(proxyEnvFile, "utf-8");
        expect(envContent).toContain("192.168.1.99");
        expect(envContent).not.toContain("10.200.0.1");
      } finally {
        try {
          unlinkSync(tmpFile);
        } catch {
          /* ignore */
        }
        try {
          unlinkSync(proxyEnvFile);
        } catch {
          /* ignore */
        }
      }
    });

    it("[simulation] sourcing ~/.bashrc overrides narrow NO_PROXY and no_proxy", () => {
      const fakeHome = join(tmpdir(), `nemoclaw-bashi-test-${process.pid}`);
      execFileSync("mkdir", ["-p", fakeHome]);
      try {
        const bashrcContent = [
          "# nemoclaw-proxy-config begin",
          'export HTTP_PROXY="http://10.200.0.1:3128"',
          'export HTTPS_PROXY="http://10.200.0.1:3128"',
          'export NO_PROXY="localhost,127.0.0.1,::1,10.200.0.1"',
          'export http_proxy="http://10.200.0.1:3128"',
          'export https_proxy="http://10.200.0.1:3128"',
          'export no_proxy="localhost,127.0.0.1,::1,10.200.0.1"',
          "# nemoclaw-proxy-config end",
        ].join("\n");
        writeFileSync(join(fakeHome, ".bashrc"), bashrcContent);

        const out = execFileSync(
          "bash",
          [
            "--norc",
            "-c",
            [
              `export HOME=${JSON.stringify(fakeHome)}`,
              'export NO_PROXY="127.0.0.1,localhost,::1"',
              'export no_proxy="127.0.0.1,localhost,::1"',
              `source ${JSON.stringify(join(fakeHome, ".bashrc"))}`,
              'echo "NO_PROXY=$NO_PROXY"',
              'echo "no_proxy=$no_proxy"',
            ].join("; "),
          ],
          { encoding: "utf-8" },
        ).trim();

        expect(out).toContain("NO_PROXY=localhost,127.0.0.1,::1,10.200.0.1");
        expect(out).toContain("no_proxy=localhost,127.0.0.1,::1,10.200.0.1");
      } finally {
        try {
          execFileSync("rm", ["-rf", fakeHome]);
        } catch {
          /* ignore */
        }
      }
    });
  });
});
