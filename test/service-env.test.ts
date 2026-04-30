// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import {
  execSync,
  execFileSync,
  type ExecFileSyncOptionsWithStringEncoding,
} from "node:child_process";
import { mkdtempSync, writeFileSync, unlinkSync, readFileSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveOpenshell } from "../dist/lib/resolve-openshell";
import { parseAllowedChatIds, isChatAllowed } from "../dist/lib/chat-filter.js";

const NEMOCLAW_START_SCRIPT = join(import.meta.dirname, "../scripts/nemoclaw-start.sh");

function extractRuntimeShellEnvSnippet() {
  const src = readFileSync(NEMOCLAW_START_SCRIPT, "utf-8");
  const start = src.indexOf("write_runtime_shell_env() {");
  const end = src.indexOf("# cleanup_on_signal", start);
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(
      "Failed to extract write_runtime_shell_env from scripts/nemoclaw-start.sh — " +
        "the runtime shell env function may have been moved or renamed",
    );
  }
  return `${src.slice(start, end).trimEnd()}\nwrite_runtime_shell_env`;
}

function extractRuntimeShellEnvShimSnippet() {
  const src = readFileSync(NEMOCLAW_START_SCRIPT, "utf-8");
  const start = src.indexOf("ensure_runtime_shell_env_shim() {");
  const end = src.indexOf("# ── Legacy layout migration", start);
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(
      "Failed to extract ensure_runtime_shell_env_shim from scripts/nemoclaw-start.sh — " +
        "the rc shim helper may have been moved or renamed",
    );
  }
  return `${src.slice(start, end).trimEnd()}\nensure_runtime_shell_env_shim`;
}

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

  describe("GIT_SSL_CAINFO for proxy CA trust (issue #2270)", () => {
    const sandboxInitSource = `source ${JSON.stringify(join(import.meta.dirname, "../scripts/lib/sandbox-init.sh"))}`;

    it("entrypoint exports GIT_SSL_CAINFO when SSL_CERT_FILE points to a real file", () => {
      const scriptPath = join(import.meta.dirname, "../scripts/nemoclaw-start.sh");
      const src = readFileSync(scriptPath, "utf-8");
      // The fix must detect SSL_CERT_FILE and set GIT_SSL_CAINFO so git trusts
      // the OpenShell L7 proxy's re-signed certificate.
      expect(src).toContain('GIT_SSL_CAINFO="$SSL_CERT_FILE"');
    });

    it("proxy-env.sh includes GIT_SSL_CAINFO when set", () => {
      const fakeDataDir = join(tmpdir(), `nemoclaw-git-ssl-test-${process.pid}`);
      const fakeCaBundle = join(fakeDataDir, "ca-bundle.pem");
      execFileSync("mkdir", ["-p", fakeDataDir]);
      const tmpFile = join(tmpdir(), `nemoclaw-git-ssl-env-${process.pid}.sh`);
      try {
        const persistBlock = extractRuntimeShellEnvSnippet();
        // Create a fake CA bundle so the -f check passes
        writeFileSync(fakeCaBundle, "-----BEGIN CERTIFICATE-----\nfake\n-----END CERTIFICATE-----\n");
        const wrapper = [
          "#!/usr/bin/env bash",
          "set -euo pipefail",
          sandboxInitSource,
          'PROXY_HOST="10.200.0.1"',
          'PROXY_PORT="3128"',
          '_PROXY_URL="http://${PROXY_HOST}:${PROXY_PORT}"',
          '_NO_PROXY_VAL="localhost,127.0.0.1,::1,${PROXY_HOST}"',
          '_TOOL_REDIRECTS=()',
          `_AXIOS_FIX_SCRIPT="/nonexistent/axios-proxy-fix.js"`,
          `_WS_FIX_SCRIPT="/nonexistent/ws-proxy-fix.js"`,
          // Simulate OpenShell injecting SSL_CERT_FILE and the entrypoint setting GIT_SSL_CAINFO
          `export SSL_CERT_FILE="${fakeCaBundle}"`,
          `export GIT_SSL_CAINFO="${fakeCaBundle}"`,
          "set +u  # array expansion safe on macOS bash",
          persistBlock
            .trimEnd()
            .replaceAll("/tmp/nemoclaw-proxy-env.sh", `${fakeDataDir}/proxy-env.sh`),
        ].join("\n");
        writeFileSync(tmpFile, wrapper, { mode: 0o700 });
        execFileSync("bash", [tmpFile], { encoding: "utf-8" });

        const envFile = readFileSync(join(fakeDataDir, "proxy-env.sh"), "utf-8");
        expect(envFile).toContain("GIT_SSL_CAINFO");
        expect(envFile).toContain(fakeCaBundle);
      } finally {
        try {
          execFileSync("rm", ["-rf", fakeDataDir, tmpFile]);
        } catch {
          /* ignore */
        }
      }
    });

    it("proxy-env.sh omits GIT_SSL_CAINFO when not set", () => {
      const fakeDataDir = join(tmpdir(), `nemoclaw-git-ssl-noop-test-${process.pid}`);
      execFileSync("mkdir", ["-p", fakeDataDir]);
      const tmpFile = join(tmpdir(), `nemoclaw-git-ssl-noop-env-${process.pid}.sh`);
      try {
        const persistBlock = extractRuntimeShellEnvSnippet();
        const wrapper = [
          "#!/usr/bin/env bash",
          "set -euo pipefail",
          sandboxInitSource,
          'PROXY_HOST="10.200.0.1"',
          'PROXY_PORT="3128"',
          '_PROXY_URL="http://${PROXY_HOST}:${PROXY_PORT}"',
          '_NO_PROXY_VAL="localhost,127.0.0.1,::1,${PROXY_HOST}"',
          '_TOOL_REDIRECTS=()',
          `_AXIOS_FIX_SCRIPT="/nonexistent/axios-proxy-fix.js"`,
          `_WS_FIX_SCRIPT="/nonexistent/ws-proxy-fix.js"`,
          // GIT_SSL_CAINFO intentionally NOT set
          "set +u  # array expansion safe on macOS bash",
          persistBlock
            .trimEnd()
            .replaceAll("/tmp/nemoclaw-proxy-env.sh", `${fakeDataDir}/proxy-env.sh`),
        ].join("\n");
        writeFileSync(tmpFile, wrapper, { mode: 0o700 });
        execFileSync("bash", [tmpFile], { encoding: "utf-8" });

        const envFile = readFileSync(join(fakeDataDir, "proxy-env.sh"), "utf-8");
        expect(envFile).not.toContain("GIT_SSL_CAINFO");
      } finally {
        try {
          execFileSync("rm", ["-rf", fakeDataDir, tmpFile]);
        } catch {
          /* ignore */
        }
      }
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
    // The proxy persistence block calls emit_sandbox_sourced_file from the
    // shared library. Wrappers that execute the extracted block must source it.
    const sandboxInitSource = `source ${JSON.stringify(join(import.meta.dirname, "../scripts/lib/sandbox-init.sh"))}`;

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
        const persistBlock = extractRuntimeShellEnvSnippet();
        const toolRedirects = extractToolRedirects();
        const wrapper = [
          "#!/usr/bin/env bash",
          sandboxInitSource,
          toolRedirects,
          'PROXY_HOST="10.200.0.1"',
          'PROXY_PORT="3128"',
          '_PROXY_URL="http://${PROXY_HOST}:${PROXY_PORT}"',
          '_NO_PROXY_VAL="localhost,127.0.0.1,::1,${PROXY_HOST}"',
          'export OPENCLAW_GATEWAY_TOKEN="test-token-123"',
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
        expect(envFile).toContain("export OPENCLAW_GATEWAY_TOKEN='test-token-123'");
        expect(envFile).toContain("nemoclaw-configure-guard begin");
        expect(envFile).toContain('command openclaw "$@"');
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
        // Permission should be 444 (hardened via emit_sandbox_sourced_file)
        // Cross-platform: Linux uses stat -c '%a', macOS uses stat -f '%Lp'
        let perms: string;
        try {
          perms = execFileSync("stat", ["-c", "%a", join(fakeDataDir, "proxy-env.sh")], {
            encoding: "utf-8",
          }).trim();
        } catch {
          perms = execFileSync("stat", ["-f", "%Lp", join(fakeDataDir, "proxy-env.sh")], {
            encoding: "utf-8",
          }).trim();
        }
        expect(perms).toBe("444");
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

    it("backfills proxy-env.sh source shims into stale rc files", () => {
      const fakeHome = join(tmpdir(), `nemoclaw-rc-shim-test-${process.pid}`);
      const proxyEnvPath = join(fakeHome, "proxy-env.sh");
      const tmpFile = join(tmpdir(), `nemoclaw-rc-shim-write-test-${process.pid}.sh`);
      const runtimeEnvShim = `[ -f ${proxyEnvPath} ] && . ${proxyEnvPath}`;
      try {
        execFileSync("mkdir", ["-p", fakeHome]);
        writeFileSync(join(fakeHome, ".bashrc"), "# old bashrc\n", { mode: 0o644 });
        writeFileSync(join(fakeHome, ".profile"), "# old profile\n", { mode: 0o444 });

        const wrapper = [
          "#!/usr/bin/env bash",
          `_SANDBOX_HOME=${JSON.stringify(fakeHome)}`,
          `_RUNTIME_SHELL_ENV_FILE=${JSON.stringify(proxyEnvPath)}`,
          '_RUNTIME_SHELL_ENV_SHIM="[ -f ${_RUNTIME_SHELL_ENV_FILE} ] && . ${_RUNTIME_SHELL_ENV_FILE}"',
          extractRuntimeShellEnvShimSnippet(),
          "ensure_runtime_shell_env_shim",
        ].join("\n");
        writeFileSync(tmpFile, wrapper, { mode: 0o700 });
        execFileSync("bash", [tmpFile], { encoding: "utf-8" });

        for (const rcName of [".bashrc", ".profile"]) {
          const rcFile = readFileSync(join(fakeHome, rcName), "utf-8");
          expect(rcFile.split(runtimeEnvShim).length - 1).toBe(1);
        }
      } finally {
        try {
          unlinkSync(tmpFile);
        } catch {
          /* ignore */
        }
        try {
          execFileSync("rm", ["-rf", fakeHome]);
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
        const persistBlock = extractRuntimeShellEnvSnippet();
        const toolRedirects = extractToolRedirects();
        const wrapper = [
          "#!/usr/bin/env bash",
          sandboxInitSource,
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
        const runOpts: ExecFileSyncOptionsWithStringEncoding = { encoding: "utf-8" };
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
        const persistBlock = extractRuntimeShellEnvSnippet();
        const toolRedirects = extractToolRedirects();
        const makeWrapper = (host: string) =>
          [
            "#!/usr/bin/env bash",
            sandboxInitSource,
            toolRedirects,
            `PROXY_HOST="${host}"`,
            'PROXY_PORT="3128"',
            '_PROXY_URL="http://${PROXY_HOST}:${PROXY_PORT}"',
            '_NO_PROXY_VAL="localhost,127.0.0.1,::1,${PROXY_HOST}"',
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
        const persistBlock = extractRuntimeShellEnvSnippet();
        const sensitiveFile = join(fakeDataDir, "sensitive");
        writeFileSync(sensitiveFile, "SECRET_DATA");
        const proxyEnvPath = join(fakeDataDir, "proxy-env.sh");
        execFileSync("ln", ["-sf", sensitiveFile, proxyEnvPath]);
        const toolRedirects = extractToolRedirects();
        const wrapper = [
          "#!/usr/bin/env bash",
          sandboxInitSource,
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

    it("regression #2109: proxy-env.sh includes NODE_OPTIONS --require when NODE_USE_ENV_PROXY=1", () => {
      const fakeDataDir = join(tmpdir(), `nemoclaw-http-fix-test-${process.pid}`);
      execFileSync("mkdir", ["-p", fakeDataDir]);
      const tmpFile = join(tmpdir(), `nemoclaw-http-fix-env-${process.pid}.sh`);
      const fakeFixPath = "/tmp/nemoclaw-http-proxy-fix.js";
      try {
        const persistBlock = extractRuntimeShellEnvSnippet();
        const wrapper = [
          "#!/usr/bin/env bash",
          "set -euo pipefail",
          sandboxInitSource,
          'PROXY_HOST="10.200.0.1"',
          'PROXY_PORT="3128"',
          '_PROXY_URL="http://${PROXY_HOST}:${PROXY_PORT}"',
          '_NO_PROXY_VAL="localhost,127.0.0.1,::1,${PROXY_HOST}"',
          "NODE_USE_ENV_PROXY=1",
          "_TOOL_REDIRECTS=()",
          `_PROXY_FIX_SCRIPT="${fakeFixPath}"`,
          `_WS_FIX_SCRIPT="/nonexistent/ws-proxy-fix.js"`,
          `_NEMOTRON_FIX_SCRIPT="/tmp/nemoclaw-nemotron-inference-fix.js"`,
          "set +u  # array expansion safe on macOS bash",
          persistBlock
            .trimEnd()
            .replaceAll("/tmp/nemoclaw-proxy-env.sh", `${fakeDataDir}/proxy-env.sh`),
        ].join("\n");
        writeFileSync(tmpFile, wrapper, { mode: 0o700 });
        execFileSync("bash", [tmpFile], { encoding: "utf-8" });

        const envFile = readFileSync(join(fakeDataDir, "proxy-env.sh"), "utf-8");
        expect(envFile).toContain("NODE_OPTIONS");
        expect(envFile).toContain("--require");
        // Preload target is the in-sandbox /tmp path; no dependency on an
        // external /opt path (see axios-proxy-fix Bug 1 — scripts/ never
        // made it into the optimized build context). The JS is embedded in
        // nemoclaw-start.sh and written to /tmp at boot.
        expect(envFile).toContain(fakeFixPath);
      } finally {
        try {
          execFileSync("rm", ["-rf", fakeDataDir, tmpFile]);
        } catch {
          /* ignore */
        }
      }
    });

    it("regression #2109: proxy-env.sh does NOT include NODE_OPTIONS when NODE_USE_ENV_PROXY is unset", () => {
      const fakeDataDir = join(tmpdir(), `nemoclaw-http-noop-test-${process.pid}`);
      execFileSync("mkdir", ["-p", fakeDataDir]);
      const tmpFile = join(tmpdir(), `nemoclaw-http-noop-env-${process.pid}.sh`);
      try {
        const persistBlock = extractRuntimeShellEnvSnippet();
        const wrapper = [
          "#!/usr/bin/env bash",
          "set -euo pipefail",
          sandboxInitSource,
          'PROXY_HOST="10.200.0.1"',
          'PROXY_PORT="3128"',
          '_PROXY_URL="http://${PROXY_HOST}:${PROXY_PORT}"',
          '_NO_PROXY_VAL="localhost,127.0.0.1,::1,${PROXY_HOST}"',
          // NODE_USE_ENV_PROXY intentionally NOT set
          "_TOOL_REDIRECTS=()",
          `_PROXY_FIX_SCRIPT="/tmp/nemoclaw-http-proxy-fix.js"`,
          `_WS_FIX_SCRIPT="/nonexistent/ws-proxy-fix.js"`,
          `_NEMOTRON_FIX_SCRIPT="/tmp/nemoclaw-nemotron-inference-fix.js"`,
          "set +u  # array expansion safe on macOS bash",
          persistBlock
            .trimEnd()
            .replaceAll("/tmp/nemoclaw-proxy-env.sh", `${fakeDataDir}/proxy-env.sh`),
        ].join("\n");
        writeFileSync(tmpFile, wrapper, { mode: 0o700 });
        execFileSync("bash", [tmpFile], { encoding: "utf-8" });

        const envFile = readFileSync(join(fakeDataDir, "proxy-env.sh"), "utf-8");
        // Proxy and ws fix preloads should NOT be injected when NODE_USE_ENV_PROXY
        // is not 1 and ws fix script does not exist. The Nemotron inference fix is
        // unconditional (always needed regardless of proxy config).
        expect(envFile).not.toContain("http-proxy-fix");
        expect(envFile).not.toContain("ws-proxy-fix");
        expect(envFile).toContain("nemotron-inference-fix");
      } finally {
        try {
          execFileSync("rm", ["-rf", fakeDataDir, tmpFile]);
        } catch {
          /* ignore */
        }
      }
    });

    it("NemoClaw#1570: proxy-env.sh includes ws-proxy-fix NODE_OPTIONS when fix script exists", () => {
      const fakeDataDir = join(tmpdir(), `nemoclaw-ws-fix-test-${process.pid}`);
      const fakeWsFixScript = join(fakeDataDir, "ws-proxy-fix.js");
      execFileSync("mkdir", ["-p", fakeDataDir]);
      const tmpFile = join(tmpdir(), `nemoclaw-ws-fix-env-${process.pid}.sh`);
      try {
        const persistBlock = extractRuntimeShellEnvSnippet();
        const wrapper = [
          "#!/usr/bin/env bash",
          "set -euo pipefail",
          sandboxInitSource,
          `PROXY_HOST="10.200.0.1"`,
          `PROXY_PORT="3128"`,
          `_PROXY_URL="http://\${PROXY_HOST}:\${PROXY_PORT}"`,
          `_NO_PROXY_VAL="localhost,127.0.0.1,::1,\${PROXY_HOST}"`,
          `_PROXY_FIX_SCRIPT="/tmp/nemoclaw-http-proxy-fix.js"`,
          `_WS_FIX_SCRIPT="${fakeWsFixScript}"`,
          `_NEMOTRON_FIX_SCRIPT="/tmp/nemoclaw-nemotron-inference-fix.js"`,
          `_TOOL_REDIRECTS=()`,
          "set +u  # array expansion safe on macOS bash",
          persistBlock
            .trimEnd()
            .replaceAll("/tmp/nemoclaw-proxy-env.sh", `${fakeDataDir}/proxy-env.sh`),
        ].join("\n");
        writeFileSync(fakeWsFixScript, "// fake", { mode: 0o644 });
        writeFileSync(tmpFile, wrapper, { mode: 0o700 });
        execFileSync("bash", [tmpFile], { encoding: "utf-8" });

        const envFile = readFileSync(join(fakeDataDir, "proxy-env.sh"), "utf-8");
        expect(envFile).toContain("NODE_OPTIONS");
        expect(envFile).toContain("--require");
        expect(envFile).toContain(fakeWsFixScript);
      } finally {
        try {
          execFileSync("rm", ["-rf", fakeDataDir, tmpFile]);
        } catch {
          /* ignore */
        }
      }
    });

    it("NemoClaw#1570: proxy-env.sh omits ws-proxy-fix when script does not exist", () => {
      const fakeDataDir = join(tmpdir(), `nemoclaw-ws-noop-test-${process.pid}`);
      execFileSync("mkdir", ["-p", fakeDataDir]);
      const tmpFile = join(tmpdir(), `nemoclaw-ws-noop-env-${process.pid}.sh`);
      try {
        const persistBlock = extractRuntimeShellEnvSnippet();
        const wrapper = [
          "#!/usr/bin/env bash",
          "set -euo pipefail",
          sandboxInitSource,
          `PROXY_HOST="10.200.0.1"`,
          `PROXY_PORT="3128"`,
          `_PROXY_URL="http://\${PROXY_HOST}:\${PROXY_PORT}"`,
          `_NO_PROXY_VAL="localhost,127.0.0.1,::1,\${PROXY_HOST}"`,
          `_PROXY_FIX_SCRIPT="/tmp/nemoclaw-http-proxy-fix.js"`,
          `_WS_FIX_SCRIPT="/nonexistent/ws-proxy-fix.js"`,
          `_NEMOTRON_FIX_SCRIPT="/tmp/nemoclaw-nemotron-inference-fix.js"`,
          `_TOOL_REDIRECTS=()`,
          "set +u  # array expansion safe on macOS bash",
          persistBlock
            .trimEnd()
            .replaceAll("/tmp/nemoclaw-proxy-env.sh", `${fakeDataDir}/proxy-env.sh`),
        ].join("\n");
        writeFileSync(tmpFile, wrapper, { mode: 0o700 });
        execFileSync("bash", [tmpFile], { encoding: "utf-8" });

        const envFile = readFileSync(join(fakeDataDir, "proxy-env.sh"), "utf-8");
        expect(envFile).not.toContain("ws-proxy-fix");
      } finally {
        try {
          execFileSync("rm", ["-rf", fakeDataDir, tmpFile]);
        } catch {
          /* ignore */
        }
      }
    });
  });

  describe("ws-proxy-fix preload (issue #1570)", () => {
    const wsFixPath = join(import.meta.dirname, "../nemoclaw-blueprint/scripts/ws-proxy-fix.js");

    it("patches https.request when HTTPS_PROXY is set", () => {
      const result = execFileSync(
        "node",
        ["--require", wsFixPath, "-e", "console.log(require('https').request.name)"],
        {
          encoding: "utf-8",
          env: { ...process.env, HTTPS_PROXY: "http://10.200.0.1:3128" },
        },
      ).trim();
      expect(result).toBe("wsProxyFixedRequest");
    });

    it("is a no-op when HTTPS_PROXY is unset", () => {
      const env = { ...process.env };
      delete env.HTTPS_PROXY;
      delete env.https_proxy;
      const result = execFileSync(
        "node",
        ["--require", wsFixPath, "-e", "console.log(require('https').request.name)"],
        { encoding: "utf-8", env },
      ).trim();
      expect(result).not.toBe("wsProxyFixedRequest");
    });

    it("is idempotent — loading twice does not double-patch", () => {
      const result = execFileSync(
        "node",
        [
          "--require",
          wsFixPath,
          "-e",
          `require("${wsFixPath}"); console.log(require('https').request.name)`,
        ],
        {
          encoding: "utf-8",
          env: { ...process.env, HTTPS_PROXY: "http://10.200.0.1:3128" },
        },
      ).trim();
      expect(result).toBe("wsProxyFixedRequest");
    });

    it("strips port from opts.host to avoid double-port CONNECT path", () => {
      // When callers pass host:"gateway.discord.gg:443" instead of hostname,
      // the CONNECT target must be "gateway.discord.gg:443" not
      // "gateway.discord.gg:443:443".
      const result = execFileSync(
        "node",
        [
          "--require",
          wsFixPath,
          "-e",
          `
const https = require("https");
const http = require("http");
// Intercept http.request to capture the CONNECT path, then abort immediately
http.request = function(opts) {
  if (opts.method === "CONNECT") {
    console.log(opts.path);
    process.exit(0);
  }
  return http.__proto__.request.apply(this, arguments);
};
const req = https.request({
  host: "gateway.discord.gg:443",
  path: "/?v=10&encoding=json",
  headers: { Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Key": "dGVzdA==", "Sec-WebSocket-Version": "13" },
});
req.on("error", () => {});
req.end();
          `,
        ],
        {
          encoding: "utf-8",
          env: { ...process.env, HTTPS_PROXY: "http://10.200.0.1:3128" },
        },
      ).trim();
      expect(result).toBe("gateway.discord.gg:443");
      expect(result).not.toContain("443:443");
    });

    it("ignores non-Discord WebSocket upgrades", () => {
      const result = execFileSync(
        "node",
        [
          "--require",
          wsFixPath,
          "-e",
          `
const https = require("https");
const http = require("http");
let sawConnect = false;
http.request = function(opts) {
  if (opts.method === "CONNECT") sawConnect = true;
  return http.__proto__.request.apply(this, arguments);
};
const req = https.request({
  hostname: "echo.websocket.org",
  path: "/",
  headers: { Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Key": "dGVzdA==", "Sec-WebSocket-Version": "13" },
});
req.on("error", () => {});
req.destroy();
console.log(sawConnect ? "CONNECT" : "NO_CONNECT");
          `,
        ],
        {
          encoding: "utf-8",
          env: { ...process.env, HTTPS_PROXY: "http://10.200.0.1:3128" },
        },
      ).trim();
      // Non-Discord host should NOT trigger the CONNECT tunnel
      expect(result).toBe("NO_CONNECT");
    });
  });
});
