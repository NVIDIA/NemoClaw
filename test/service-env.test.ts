// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import { execSync, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, unlinkSync, readFileSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveOpenshell } from "../dist/lib/resolve-openshell";
import { parseAllowedChatIds, isChatAllowed } from "../dist/lib/chat-filter.js";

describe("service environment", () => {
  describe("start-services behavior", () => {
    const scriptPath = join(import.meta.dirname, "../scripts/start-services.sh");

    it("starts without messaging-related warnings", () => {
      const workspace = mkdtempSync(join(tmpdir(), "nemoclaw-services-no-key-"));
      const result = execFileSync("bash", [scriptPath], {
        encoding: "utf-8",
        env: {
          ...process.env,
          SANDBOX_NAME: "test-box",
          TMPDIR: workspace,
        },
      });

      // Messaging channels are now native to OpenClaw inside the sandbox
      expect(result).toContain("Messaging:   via OpenClaw native channels");
    });
  });

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

  describe("chat-filter module", () => {
    it("parseAllowedChatIds parses comma-separated IDs with whitespace", () => {
      expect(parseAllowedChatIds("111, 222 , 333")).toEqual(["111", "222", "333"]);
    });

    it("isChatAllowed filters blocked chat IDs", () => {
      const allowed = parseAllowedChatIds("111,222");
      expect(isChatAllowed(allowed, "111")).toBe(true);
      expect(isChatAllowed(allowed, "222")).toBe(true);
      expect(isChatAllowed(allowed, "333")).toBe(false);
      expect(isChatAllowed(allowed, "999")).toBe(false);
    });

    it("parseAllowedChatIds handles single chat ID (no commas)", () => {
      expect(parseAllowedChatIds("111")).toEqual(["111"]);
    });

    it("parseAllowedChatIds filters empty entries from trailing commas", () => {
      expect(parseAllowedChatIds("111,,222,")).toEqual(["111", "222"]);
    });

    it("parseAllowedChatIds returns null when unset, isChatAllowed allows all", () => {
      expect(parseAllowedChatIds(undefined)).toBeNull();
      expect(parseAllowedChatIds("")).toBeNull();
      expect(isChatAllowed(null, "anyid")).toBe(true);
    });
  });

  describe("XDG and tool cache redirects (issue #804)", () => {
    it("entrypoint exports redirect all XDG and tool dirs to /tmp", () => {
      const scriptPath = join(import.meta.dirname, "../scripts/nemoclaw-start.sh");
      const src = readFileSync(scriptPath, "utf-8");
      // Redirects are defined in the _TOOL_REDIRECTS array (single source of truth)
      expect(src).toContain("_TOOL_REDIRECTS=(");
      // XDG base dirs
      expect(src).toContain("XDG_CACHE_HOME=/tmp/.cache");
      expect(src).toContain("XDG_CONFIG_HOME=/tmp/.config");
      expect(src).toContain("XDG_DATA_HOME=/tmp/.local/share");
      expect(src).toContain("XDG_STATE_HOME=/tmp/.local/state");
      expect(src).toContain("XDG_RUNTIME_DIR=/tmp/.runtime");
      // Tool-specific redirects
      expect(src).toContain("GNUPGHOME=/tmp/.gnupg");
      expect(src).toContain("PYTHON_HISTORY=/tmp/.python_history");
      expect(src).toContain("npm_config_prefix=/tmp/npm-global");
    });

    it("entrypoint pre-creates redirected dirs as sandbox user", () => {
      const scriptPath = join(import.meta.dirname, "../scripts/nemoclaw-start.sh");
      const src = readFileSync(scriptPath, "utf-8");
      // install -d creates dirs with correct ownership before the gateway
      // starts, preventing gateway:gateway ownership that blocks sandbox writes
      expect(src).toContain("install -d -o sandbox -g sandbox");
      expect(src).toContain("/tmp/.config");
      expect(src).toContain("/tmp/.cache");
      expect(src).toContain("/tmp/.local/share");
      expect(src).toContain("/tmp/npm-global");
    });

    it("entrypoint creates GNUPGHOME with restrictive permissions", () => {
      const scriptPath = join(import.meta.dirname, "../scripts/nemoclaw-start.sh");
      const src = readFileSync(scriptPath, "utf-8");
      expect(src).toContain("install -d -o sandbox -g sandbox -m 700 /tmp/.gnupg");
      expect(src).toContain("install -d -m 700 /tmp/.gnupg");
    });
  });

  describe("proxy environment variables (issue #626)", () => {
    function extractToolRedirects() {
      const scriptPath = join(import.meta.dirname, "../scripts/nemoclaw-start.sh");
      const block = execFileSync("sed", ["-n", "/^_TOOL_REDIRECTS=/,/^done$/p", scriptPath], {
        encoding: "utf-8",
      });
      if (!block.trim()) {
        throw new Error(
          "Failed to extract _TOOL_REDIRECTS from scripts/nemoclaw-start.sh — " +
            "the array may have been moved or renamed",
        );
      }
      return block.trimEnd();
    }

    function extractEmitHelper() {
      const scriptPath = join(import.meta.dirname, "../scripts/nemoclaw-start.sh");
      const block = execFileSync(
        "sed",
        ["-n", "/^emit_sandbox_sourced_file()/,/^}/p", scriptPath],
        { encoding: "utf-8" },
      );
      if (!block.trim()) {
        throw new Error(
          "Failed to extract emit_sandbox_sourced_file from scripts/nemoclaw-start.sh — " +
            "the function may have been moved or renamed",
        );
      }
      return block.trimEnd();
    }

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

    it("entrypoint writes proxy-env.sh to writable data dir", () => {
      const fakeDataDir = join(tmpdir(), `nemoclaw-data-test-${process.pid}`);
      execFileSync("mkdir", ["-p", fakeDataDir]);
      const tmpFile = join(tmpdir(), `nemoclaw-proxyenv-write-test-${process.pid}.sh`);
      try {
        const scriptPath = join(import.meta.dirname, "../scripts/nemoclaw-start.sh");
        const persistBlock = execFileSync(
          "sed",
          ["-n", "/^_PROXY_ENV_FILE=/,/emit_sandbox_sourced_file/p", scriptPath],
          { encoding: "utf-8" },
        );
        if (!persistBlock.trim()) {
          throw new Error(
            "Failed to extract proxy persistence block from scripts/nemoclaw-start.sh — " +
              "the _PROXY_ENV_FILE..emit_sandbox_sourced_file block may have been moved or renamed",
          );
        }
        const toolRedirects = extractToolRedirects();
        const emitHelper = extractEmitHelper();
        const wrapper = [
          "#!/usr/bin/env bash",
          emitHelper,
          toolRedirects,
          'PROXY_HOST="10.200.0.1"',
          'PROXY_PORT="3128"',
          '_PROXY_URL="http://${PROXY_HOST}:${PROXY_PORT}"',
          '_NO_PROXY_VAL="localhost,127.0.0.1,::1,${PROXY_HOST}"',
          // Override the hardcoded path to use our temp dir
          persistBlock
            .trimEnd()
            .replaceAll("/tmp/nemoclaw-proxy-env.sh", `${fakeDataDir}/proxy-env.sh`),
        ].join("\n");
        writeFileSync(tmpFile, wrapper, { mode: 0o700 });
        execFileSync("bash", [tmpFile], { encoding: "utf-8" });

        const envFile = readFileSync(join(fakeDataDir, "proxy-env.sh"), "utf-8");
        expect(envFile).toContain('export HTTP_PROXY="http://10.200.0.1:3128"');
        expect(envFile).toContain('export HTTPS_PROXY="http://10.200.0.1:3128"');
        expect(envFile).toContain("export NO_PROXY=");
        expect(envFile).not.toContain("inference.local");
        expect(envFile).toContain("10.200.0.1");
        // Tool cache redirects should be present (#804)
        expect(envFile).toContain("npm_config_cache");
        expect(envFile).toContain("HISTFILE");
        expect(envFile).toContain("GIT_CONFIG_GLOBAL");
        // XDG redirects prevent tools from writing to read-only /sandbox (#804)
        expect(envFile).toContain("XDG_CONFIG_HOME=/tmp/.config");
        expect(envFile).toContain("XDG_DATA_HOME=/tmp/.local/share");
        expect(envFile).toContain("XDG_STATE_HOME=/tmp/.local/state");
        expect(envFile).toContain("XDG_RUNTIME_DIR=/tmp/.runtime");
        expect(envFile).toContain("GNUPGHOME=/tmp/.gnupg");
        expect(envFile).toContain("PYTHON_HISTORY=/tmp/.python_history");
        expect(envFile).toContain("npm_config_prefix=/tmp/npm-global");
        // SECURITY: file must be read-only (#2181)
        // Use platform-appropriate stat format: -c '%a' on Linux, -f '%Lp' on macOS
        const proxyEnvPath = join(fakeDataDir, "proxy-env.sh");
        let stat;
        try {
          stat = execFileSync("stat", ["-c", "%a", proxyEnvPath], { encoding: "utf-8" }).trim();
        } catch {
          stat = execFileSync("stat", ["-f", "%Lp", proxyEnvPath], { encoding: "utf-8" }).trim();
        }
        expect(stat).toBe("444");
      } finally {
        try {
          unlinkSync(tmpFile);
        } catch {
          /* ignore */
        }
        try {
          execFileSync("rm", ["-rf", fakeDataDir]);
        } catch {
          /* ignore */
        }
      }
    });

    it("entrypoint overwrites proxy-env.sh cleanly on repeated invocations", () => {
      const fakeDataDir = join(tmpdir(), `nemoclaw-idempotent-test-${process.pid}`);
      execFileSync("mkdir", ["-p", fakeDataDir]);
      const tmpFile = join(tmpdir(), `nemoclaw-idempotent-write-test-${process.pid}.sh`);
      try {
        const scriptPath = join(import.meta.dirname, "../scripts/nemoclaw-start.sh");
        const persistBlock = execFileSync(
          "sed",
          ["-n", "/^_PROXY_ENV_FILE=/,/emit_sandbox_sourced_file/p", scriptPath],
          { encoding: "utf-8" },
        );
        if (!persistBlock.trim()) {
          throw new Error(
            "Failed to extract proxy persistence block from scripts/nemoclaw-start.sh — " +
              "the _PROXY_ENV_FILE..emit_sandbox_sourced_file block may have been moved or renamed",
          );
        }
        const toolRedirects = extractToolRedirects();
        const emitHelper = extractEmitHelper();
        const wrapper = [
          "#!/usr/bin/env bash",
          emitHelper,
          toolRedirects,
          'PROXY_HOST="10.200.0.1"',
          'PROXY_PORT="3128"',
          '_PROXY_URL="http://${PROXY_HOST}:${PROXY_PORT}"',
          '_NO_PROXY_VAL="localhost,127.0.0.1,::1,${PROXY_HOST}"',
          persistBlock
            .trimEnd()
            .replaceAll("/tmp/nemoclaw-proxy-env.sh", `${fakeDataDir}/proxy-env.sh`),
        ].join("\n");
        writeFileSync(tmpFile, wrapper, { mode: 0o700 });
        const runOpts = { encoding: /** @type {const} */ "utf-8" };
        execFileSync("bash", [tmpFile], runOpts);
        execFileSync("bash", [tmpFile], runOpts);
        execFileSync("bash", [tmpFile], runOpts);

        const envFile = readFileSync(join(fakeDataDir, "proxy-env.sh"), "utf-8");
        // cat > overwrites the file each time, so there should be exactly one
        // HTTP_PROXY line — no duplication from repeated runs.
        const httpProxyCount = (envFile.match(/export HTTP_PROXY=/g) || []).length;
        expect(httpProxyCount).toBe(1);
      } finally {
        try {
          unlinkSync(tmpFile);
        } catch {
          /* ignore */
        }
        try {
          execFileSync("rm", ["-rf", fakeDataDir]);
        } catch {
          /* ignore */
        }
      }
    });

    it("entrypoint replaces stale proxy values on restart", () => {
      const fakeDataDir = join(tmpdir(), `nemoclaw-replace-test-${process.pid}`);
      execFileSync("mkdir", ["-p", fakeDataDir]);
      const tmpFile = join(tmpdir(), `nemoclaw-replace-write-test-${process.pid}.sh`);
      try {
        const scriptPath = join(import.meta.dirname, "../scripts/nemoclaw-start.sh");
        const persistBlock = execFileSync(
          "sed",
          ["-n", "/^_PROXY_ENV_FILE=/,/emit_sandbox_sourced_file/p", scriptPath],
          { encoding: "utf-8" },
        );
        if (!persistBlock.trim()) {
          throw new Error(
            "Failed to extract proxy persistence block from scripts/nemoclaw-start.sh — " +
              "the _PROXY_ENV_FILE..emit_sandbox_sourced_file block may have been moved or renamed",
          );
        }
        const toolRedirects = extractToolRedirects();
        const emitHelper = extractEmitHelper();
        const makeWrapper = (host) =>
          [
            "#!/usr/bin/env bash",
            emitHelper,
            toolRedirects,
            `PROXY_HOST="${host}"`,
            'PROXY_PORT="3128"',
            `_PROXY_URL="http://\${PROXY_HOST}:\${PROXY_PORT}"`,
            `_NO_PROXY_VAL="localhost,127.0.0.1,::1,\${PROXY_HOST}"`,
            persistBlock
              .trimEnd()
              .replaceAll("/tmp/nemoclaw-proxy-env.sh", `${fakeDataDir}/proxy-env.sh`),
          ].join("\n");

        writeFileSync(tmpFile, makeWrapper("10.200.0.1"), { mode: 0o700 });
        execFileSync("bash", [tmpFile], { encoding: "utf-8" });
        let envFile = readFileSync(join(fakeDataDir, "proxy-env.sh"), "utf-8");
        expect(envFile).toContain("10.200.0.1");

        writeFileSync(tmpFile, makeWrapper("192.168.1.99"), { mode: 0o700 });
        execFileSync("bash", [tmpFile], { encoding: "utf-8" });
        envFile = readFileSync(join(fakeDataDir, "proxy-env.sh"), "utf-8");
        expect(envFile).toContain("192.168.1.99");
        expect(envFile).not.toContain("10.200.0.1");
      } finally {
        try {
          unlinkSync(tmpFile);
        } catch {
          /* ignore */
        }
        try {
          execFileSync("rm", ["-rf", fakeDataDir]);
        } catch {
          /* ignore */
        }
      }
    });

    it("emit_sandbox_sourced_file prevents symlink-following attack on proxy-env.sh", () => {
      const fakeDataDir = join(tmpdir(), `nemoclaw-symlink-test-${process.pid}`);
      execFileSync("mkdir", ["-p", fakeDataDir]);
      const tmpFile = join(tmpdir(), `nemoclaw-symlink-write-test-${process.pid}.sh`);
      try {
        const scriptPath = join(import.meta.dirname, "../scripts/nemoclaw-start.sh");
        const persistBlock = execFileSync(
          "sed",
          ["-n", "/^_PROXY_ENV_FILE=/,/emit_sandbox_sourced_file/p", scriptPath],
          { encoding: "utf-8" },
        );
        if (!persistBlock.trim()) {
          throw new Error(
            "Failed to extract proxy persistence block from scripts/nemoclaw-start.sh — " +
              "the _PROXY_ENV_FILE..emit_sandbox_sourced_file block may have been moved or renamed",
          );
        }
        const sensitiveFile = join(fakeDataDir, "sensitive");
        writeFileSync(sensitiveFile, "SECRET_DATA");
        const proxyEnvPath = join(fakeDataDir, "proxy-env.sh");
        execFileSync("ln", ["-sf", sensitiveFile, proxyEnvPath]);
        const toolRedirects = extractToolRedirects();
        const emitHelper = extractEmitHelper();
        const wrapper = [
          "#!/usr/bin/env bash",
          emitHelper,
          toolRedirects,
          'PROXY_HOST="10.200.0.1"',
          'PROXY_PORT="3128"',
          '_PROXY_URL="http://${PROXY_HOST}:${PROXY_PORT}"',
          '_NO_PROXY_VAL="localhost,127.0.0.1,::1,${PROXY_HOST}"',
          persistBlock.trimEnd().replaceAll("/tmp/nemoclaw-proxy-env.sh", proxyEnvPath),
        ].join("\n");
        writeFileSync(tmpFile, wrapper, { mode: 0o700 });
        execFileSync("bash", [tmpFile], { encoding: "utf-8" });
        const stat = lstatSync(proxyEnvPath);
        expect(stat.isSymbolicLink()).toBe(false);
        expect(readFileSync(sensitiveFile, "utf-8")).toBe("SECRET_DATA");
      } finally {
        try {
          unlinkSync(tmpFile);
        } catch {
          /* ignore */
        }
        try {
          execFileSync("rm", ["-rf", fakeDataDir]);
        } catch {
          /* ignore */
        }
      }
    });

    it("[simulation] sourcing proxy-env.sh overrides narrow NO_PROXY and no_proxy", () => {
      const fakeDataDir = join(tmpdir(), `nemoclaw-bashi-test-${process.pid}`);
      execFileSync("mkdir", ["-p", fakeDataDir]);
      try {
        const envContent = [
          'export HTTP_PROXY="http://10.200.0.1:3128"',
          'export HTTPS_PROXY="http://10.200.0.1:3128"',
          'export NO_PROXY="localhost,127.0.0.1,::1,10.200.0.1"',
          'export http_proxy="http://10.200.0.1:3128"',
          'export https_proxy="http://10.200.0.1:3128"',
          'export no_proxy="localhost,127.0.0.1,::1,10.200.0.1"',
        ].join("\n");
        writeFileSync(join(fakeDataDir, "proxy-env.sh"), envContent);

        const out = execFileSync(
          "bash",
          [
            "--norc",
            "-c",
            [
              'export NO_PROXY="127.0.0.1,localhost,::1"',
              'export no_proxy="127.0.0.1,localhost,::1"',
              `source ${JSON.stringify(join(fakeDataDir, "proxy-env.sh"))}`,
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
          execFileSync("rm", ["-rf", fakeDataDir]);
        } catch {
          /* ignore */
        }
      }
    });

    it("regression #2109: proxy-env.sh includes NODE_OPTIONS --require when NODE_USE_ENV_PROXY=1 and fix script exists", () => {
      const fakeDataDir = join(tmpdir(), `nemoclaw-axios-fix-test-${process.pid}`);
      const fakeFixScript = join(fakeDataDir, "axios-proxy-fix.js");
      execFileSync("mkdir", ["-p", fakeDataDir]);
      const tmpFile = join(tmpdir(), `nemoclaw-axios-fix-env-${process.pid}.sh`);
      try {
        const scriptPath = join(import.meta.dirname, "../scripts/nemoclaw-start.sh");
        const persistBlock = execFileSync(
          "sed",
          ["-n", "/^_PROXY_ENV_FILE=/,/emit_sandbox_sourced_file/p", scriptPath],
          { encoding: "utf-8" },
        );
        if (!persistBlock.trim()) {
          throw new Error(
            "sed anchors (_PROXY_ENV_FILE…emit_sandbox_sourced_file) not found in nemoclaw-start.sh — test cannot run",
          );
        }
        const emitHelper = extractEmitHelper();
        const wrapper = [
          "#!/usr/bin/env bash",
          "set -euo pipefail",
          emitHelper,
          `PROXY_HOST="10.200.0.1"`,
          `PROXY_PORT="3128"`,
          `_PROXY_URL="http://\${PROXY_HOST}:\${PROXY_PORT}"`,
          `_NO_PROXY_VAL="localhost,127.0.0.1,::1,\${PROXY_HOST}"`,
          `NODE_USE_ENV_PROXY=1`,
          `_AXIOS_FIX_SCRIPT="${fakeFixScript}"`,
          `_TOOL_REDIRECTS=()`,
          "set +u  # array expansion safe on macOS bash",
          persistBlock
            .trimEnd()
            .replaceAll("/tmp/nemoclaw-proxy-env.sh", `${fakeDataDir}/proxy-env.sh`),
        ].join("\n");
        // Create a fake fix script so the -f check passes
        writeFileSync(fakeFixScript, "// fake", { mode: 0o644 });
        writeFileSync(tmpFile, wrapper, { mode: 0o700 });
        execFileSync("bash", [tmpFile], { encoding: "utf-8" });

        const envFile = readFileSync(join(fakeDataDir, "proxy-env.sh"), "utf-8");
        expect(envFile).toContain("NODE_OPTIONS");
        expect(envFile).toContain("--require");
        expect(envFile).toContain(fakeFixScript);
      } finally {
        try {
          execFileSync("rm", ["-rf", fakeDataDir, tmpFile]);
        } catch {
          /* ignore */
        }
      }
    });

    it("regression #2109: proxy-env.sh does NOT include NODE_OPTIONS when NODE_USE_ENV_PROXY is unset", () => {
      const fakeDataDir = join(tmpdir(), `nemoclaw-axios-noop-test-${process.pid}`);
      const fakeFixScript = join(fakeDataDir, "axios-proxy-fix.js");
      execFileSync("mkdir", ["-p", fakeDataDir]);
      const tmpFile = join(tmpdir(), `nemoclaw-axios-noop-env-${process.pid}.sh`);
      try {
        const scriptPath = join(import.meta.dirname, "../scripts/nemoclaw-start.sh");
        const persistBlock = execFileSync(
          "sed",
          ["-n", "/^_PROXY_ENV_FILE=/,/emit_sandbox_sourced_file/p", scriptPath],
          { encoding: "utf-8" },
        );
        if (!persistBlock.trim()) {
          throw new Error("sed anchors not found in nemoclaw-start.sh — test cannot run");
        }
        const emitHelper = extractEmitHelper();
        const wrapper = [
          "#!/usr/bin/env bash",
          "set -euo pipefail",
          emitHelper,
          `PROXY_HOST="10.200.0.1"`,
          `PROXY_PORT="3128"`,
          `_PROXY_URL="http://\${PROXY_HOST}:\${PROXY_PORT}"`,
          `_NO_PROXY_VAL="localhost,127.0.0.1,::1,\${PROXY_HOST}"`,
          // NODE_USE_ENV_PROXY intentionally NOT set
          `_AXIOS_FIX_SCRIPT="${fakeFixScript}"`,
          `_TOOL_REDIRECTS=()`,
          "set +u  # array expansion safe on macOS bash",
          persistBlock
            .trimEnd()
            .replaceAll("/tmp/nemoclaw-proxy-env.sh", `${fakeDataDir}/proxy-env.sh`),
        ].join("\n");
        writeFileSync(fakeFixScript, "// fake", { mode: 0o644 });
        writeFileSync(tmpFile, wrapper, { mode: 0o700 });
        execFileSync("bash", [tmpFile], { encoding: "utf-8" });

        const envFile = readFileSync(join(fakeDataDir, "proxy-env.sh"), "utf-8");
        // NODE_OPTIONS preload should NOT be injected when NODE_USE_ENV_PROXY is not 1
        expect(envFile).not.toContain("--require");
        expect(envFile).not.toContain("axios-proxy-fix");
      } finally {
        try {
          execFileSync("rm", ["-rf", fakeDataDir, tmpFile]);
        } catch {
          /* ignore */
        }
      }
    });
  });
});
