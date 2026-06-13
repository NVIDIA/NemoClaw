// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import {
  execSync,
  execFileSync,
  type ExecFileSyncOptionsWithStringEncoding,
} from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  writeFileSync,
  unlinkSync,
  readFileSync,
  lstatSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveOpenshell } from "../dist/lib/adapters/openshell/resolve";

const NEMOCLAW_START_SCRIPT = join(import.meta.dirname, "../scripts/nemoclaw-start.sh");
const RC_CLEAN_SCRIPT = join(import.meta.dirname, "../scripts/lib/clean_runtime_shell_env_shim.py");

function rcShimWrapperHeader(): string {
  return `export NEMOCLAW_RC_CLEAN_SCRIPT=${JSON.stringify(RC_CLEAN_SCRIPT)}`;
}

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

    it("starts without messaging-related warnings", { timeout: 30000 }, () => {
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

  describe("GIT_SSL_CAINFO for proxy CA trust (issue #2270)", () => {
    const sandboxInitSource = `source ${JSON.stringify(join(import.meta.dirname, "../scripts/lib/sandbox-init.sh"))}`;

    it("entrypoint exports GIT_SSL_CAINFO when SSL_CERT_FILE points to a real file", () => {
      const scriptPath = join(import.meta.dirname, "../scripts/nemoclaw-start.sh");
      const src = readFileSync(scriptPath, "utf-8");
      const start = src.indexOf("# Git TLS CA bundle fix");
      const end = src.indexOf("# HTTP library + NODE_USE_ENV_PROXY", start);
      if (start === -1 || end === -1 || end <= start) {
        throw new Error("Failed to extract SSL_CERT_FILE handling block");
      }

      const fakeDir = mkdtempSync(join(tmpdir(), "nemoclaw-git-ssl-entrypoint-"));
      const fakeCaBundle = join(fakeDir, "ca-bundle.pem");
      const tmpFile = join(tmpdir(), `nemoclaw-git-ssl-entrypoint-${process.pid}.sh`);
      try {
        writeFileSync(
          fakeCaBundle,
          "-----BEGIN CERTIFICATE-----\nfake\n-----END CERTIFICATE-----\n",
        );
        writeFileSync(
          tmpFile,
          [
            "#!/usr/bin/env bash",
            "set -euo pipefail",
            `export SSL_CERT_FILE=${JSON.stringify(fakeCaBundle)}`,
            src.slice(start, end),
            'printf "%s" "${GIT_SSL_CAINFO:-}"',
          ].join("\n"),
          { mode: 0o700 },
        );

        const output = execFileSync("bash", [tmpFile], { encoding: "utf-8" });
        expect(output).toBe(fakeCaBundle);
      } finally {
        try {
          unlinkSync(tmpFile);
        } catch {
          /* ignore */
        }
        try {
          execFileSync("rm", ["-rf", fakeDir]);
        } catch {
          /* ignore */
        }
      }
    });

    it("proxy-env.sh includes GIT_SSL_CAINFO when set", () => {
      const fakeDataDir = mkdtempSync(join(tmpdir(), "nemoclaw-git-ssl-test-"));
      const fakeCaBundle = join(fakeDataDir, "ca-bundle.pem");
      const tmpFile = join(fakeDataDir, "git-ssl-env.sh");
      try {
        const persistBlock = extractRuntimeShellEnvSnippet();
        // Create a fake CA bundle so the -f check passes
        writeFileSync(
          fakeCaBundle,
          "-----BEGIN CERTIFICATE-----\nfake\n-----END CERTIFICATE-----\n",
        );
        const wrapper = [
          "#!/usr/bin/env bash",
          "set -euo pipefail",
          sandboxInitSource,
          'PROXY_HOST="10.200.0.1"',
          'PROXY_PORT="3128"',
          '_PROXY_URL="http://${PROXY_HOST}:${PROXY_PORT}"',
          '_NO_PROXY_VAL="localhost,127.0.0.1,::1,${PROXY_HOST}"',
          "_TOOL_REDIRECTS=()",
          `_AXIOS_FIX_SCRIPT="/nonexistent/axios-proxy-fix.js"`,
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
          execFileSync("rm", ["-rf", fakeDataDir]);
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
          "_TOOL_REDIRECTS=()",
          `_AXIOS_FIX_SCRIPT="/nonexistent/axios-proxy-fix.js"`,
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

  describe("runtime npm online state", () => {
    it("entrypoint exports npm_config_offline=false and NPM_CONFIG_OFFLINE=false at PID 1", () => {
      const src = readFileSync(NEMOCLAW_START_SCRIPT, "utf-8");
      const start = src.indexOf("_TOOL_REDIRECTS=(");
      const end = src.indexOf("done", src.indexOf("for _redir", start));
      if (start === -1 || end === -1 || end <= start) {
        throw new Error("Failed to extract _TOOL_REDIRECTS block from scripts/nemoclaw-start.sh");
      }
      const block = `${src.slice(start, end)}done`;
      const tmpFile = join(tmpdir(), `nemoclaw-tool-redirects-npm-online-${process.pid}.sh`);
      try {
        writeFileSync(
          tmpFile,
          [
            "#!/usr/bin/env bash",
            "set -euo pipefail",
            block,
            'printf "npm_config_offline=%s\\n" "${npm_config_offline:-unset}"',
            'printf "NPM_CONFIG_OFFLINE=%s\\n" "${NPM_CONFIG_OFFLINE:-unset}"',
          ].join("\n"),
          { mode: 0o700 },
        );
        const out = execFileSync("bash", [tmpFile], { encoding: "utf-8" });
        expect(out).toContain("npm_config_offline=false");
        expect(out).toContain("NPM_CONFIG_OFFLINE=false");
      } finally {
        try {
          unlinkSync(tmpFile);
        } catch {
          /* ignore */
        }
      }
    });

    it("a sandbox-connect shell sourcing the emitted proxy-env reports both npm offline env vars as false", () => {
      const persistBlock = extractRuntimeShellEnvSnippet();
      const toolRedirects = execFileSync(
        "sed",
        ["-n", "/^_TOOL_REDIRECTS=/,/^done$/p", NEMOCLAW_START_SCRIPT],
        { encoding: "utf-8" },
      ).trimEnd();
      const sandboxInitSource = `source ${JSON.stringify(join(import.meta.dirname, "../scripts/lib/sandbox-init.sh"))}`;
      const fakeDataDir = mkdtempSync(join(tmpdir(), "nemoclaw-connect-npm-online-"));
      const tmpFile = join(tmpdir(), `nemoclaw-connect-npm-online-${process.pid}.sh`);
      try {
        const wrapper = [
          "#!/usr/bin/env bash",
          sandboxInitSource,
          toolRedirects,
          'PROXY_HOST="10.200.0.1"',
          'PROXY_PORT="3128"',
          '_PROXY_URL="http://${PROXY_HOST}:${PROXY_PORT}"',
          '_NO_PROXY_VAL="localhost,127.0.0.1,::1,${PROXY_HOST}"',
          'export OPENCLAW_GATEWAY_TOKEN="probe-token"',
          persistBlock.replaceAll("/tmp/nemoclaw-proxy-env.sh", `${fakeDataDir}/proxy-env.sh`),
          `env -i HOME=/tmp bash --noprofile --norc -c 'source ${fakeDataDir}/proxy-env.sh; printf "%s\\n" "$npm_config_offline" "$NPM_CONFIG_OFFLINE"'`,
        ].join("\n");
        writeFileSync(tmpFile, wrapper, { mode: 0o700 });
        const out = execFileSync("bash", [tmpFile], { encoding: "utf-8" }).trim();
        expect(out.split("\n")).toEqual(["false", "false"]);
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
  });

  describe("XDG and tool cache redirects (issue #804)", () => {
    it("entrypoint pre-creates redirected dirs and restricts GNUPGHOME permissions", () => {
      const scriptPath = join(import.meta.dirname, "../scripts/nemoclaw-start.sh");
      const src = readFileSync(scriptPath, "utf-8");
      const start = src.indexOf("# Pre-create redirected directories");
      const end = src.indexOf("# ── Drop unnecessary Linux capabilities", start);
      if (start === -1 || end === -1 || end <= start) {
        throw new Error("Failed to extract redirected-directory setup block");
      }

      const fakeTmp = mkdtempSync(join(tmpdir(), "nemoclaw-tool-redirects-"));
      const block = src.slice(start, end).replaceAll("/tmp/", `${fakeTmp}/`);
      const tmpFile = join(tmpdir(), `nemoclaw-tool-redirects-${process.pid}.sh`);
      try {
        writeFileSync(
          tmpFile,
          [
            "#!/usr/bin/env bash",
            "set -euo pipefail",
            'id() { if [ "${1:-}" = "-u" ]; then printf "1000\\n"; else command id "$@"; fi; }',
            block,
          ].join("\n"),
          {
            mode: 0o700,
          },
        );
        execFileSync("bash", [tmpFile], { encoding: "utf-8" });

        for (const dir of [
          ".npm-cache",
          ".cache",
          ".config",
          join(".local", "share"),
          join(".local", "state"),
          ".runtime",
          ".claude",
          "npm-global",
        ]) {
          expect(lstatSync(join(fakeTmp, dir)).isDirectory()).toBe(true);
        }
        const gnupg = lstatSync(join(fakeTmp, ".gnupg"));
        expect(gnupg.isDirectory()).toBe(true);
        expect((gnupg.mode & 0o777).toString(8)).toBe("700");
      } finally {
        try {
          unlinkSync(tmpFile);
        } catch {
          /* ignore */
        }
        try {
          execFileSync("rm", ["-rf", fakeTmp]);
        } catch {
          /* ignore */
        }
      }
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
        // Pin npm online for connect sessions and PID 1 so a leaked
        // build-time NPM_CONFIG_OFFLINE=true cannot force `only-if-cached`
        // mode on dashboard-driven MCP installs, skill installers, or
        // ad-hoc `npx -y` invocations inside the sandbox.
        expect(envFile).toContain("npm_config_offline=false");
        expect(envFile).toContain("NPM_CONFIG_OFFLINE=false");
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

    it("removes legacy proxy-env.sh source shims from sandbox user rc files", () => {
      const fakeHome = mkdtempSync(join(tmpdir(), "nemoclaw-rc-shim-test-"));
      const proxyEnvPath = join(fakeHome, "proxy-env.sh");
      const tmpFile = join(fakeHome, "rc-shim-write-test.sh");
      try {
        writeFileSync(
          join(fakeHome, ".bashrc"),
          [
            "# old bashrc",
            "# Source runtime proxy config",
            `[ -f ${proxyEnvPath} ] && . ${proxyEnvPath}`,
            "export PATH=/usr/local/bin:$PATH",
            "",
          ].join("\n"),
          { mode: 0o644 },
        );
        writeFileSync(
          join(fakeHome, ".profile"),
          [
            "# old profile",
            "# Source runtime proxy config",
            `[ -f ${proxyEnvPath} ] && . ${proxyEnvPath}`,
            "umask 022",
            "",
          ].join("\n"),
          { mode: 0o444 },
        );

        const wrapper = [
          "#!/usr/bin/env bash",
          `_SANDBOX_HOME=${JSON.stringify(fakeHome)}`,
          `_RUNTIME_SHELL_ENV_FILE=${JSON.stringify(proxyEnvPath)}`,
          '_RUNTIME_SHELL_ENV_SHIM="[ -f ${_RUNTIME_SHELL_ENV_FILE} ] && . ${_RUNTIME_SHELL_ENV_FILE}"',
          rcShimWrapperHeader(),
          extractRuntimeShellEnvShimSnippet(),
          "ensure_runtime_shell_env_shim",
        ].join("\n");
        writeFileSync(tmpFile, wrapper, { mode: 0o700 });
        execFileSync("bash", [tmpFile], { encoding: "utf-8" });

        for (const rcName of [".bashrc", ".profile"]) {
          const rcFile = readFileSync(join(fakeHome, rcName), "utf-8");
          expect(rcFile.toLowerCase()).not.toContain("proxy");
          expect(rcFile).not.toContain(proxyEnvPath);
          expect(rcFile).toContain(rcName === ".bashrc" ? "export PATH" : "umask 022");
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

    it("does not follow pre-planted legacy rc cleanup temp symlinks", () => {
      const fakeHome = mkdtempSync(join(tmpdir(), "nemoclaw-rc-shim-symlink-test-"));
      const proxyEnvPath = join(fakeHome, "proxy-env.sh");
      const rcPath = join(fakeHome, ".bashrc");
      const sensitivePath = join(fakeHome, "sensitive");
      const tmpFile = join(fakeHome, "rc-shim-symlink-test.sh");
      try {
        writeFileSync(
          rcPath,
          [
            "# old bashrc",
            "# Source runtime proxy config",
            `[ -f ${proxyEnvPath} ] && . ${proxyEnvPath}`,
            "export PATH=/usr/local/bin:$PATH",
            "",
          ].join("\n"),
          { mode: 0o644 },
        );
        writeFileSync(sensitivePath, "SECRET\n", { mode: 0o600 });

        const wrapper = [
          "#!/usr/bin/env bash",
          "set -euo pipefail",
          `_SANDBOX_HOME=${JSON.stringify(fakeHome)}`,
          `_RUNTIME_SHELL_ENV_FILE=${JSON.stringify(proxyEnvPath)}`,
          '_RUNTIME_SHELL_ENV_SHIM="[ -f ${_RUNTIME_SHELL_ENV_FILE} ] && . ${_RUNTIME_SHELL_ENV_FILE}"',
          'legacy_tmp="${_SANDBOX_HOME}/.bashrc.nemoclaw-clean.$$"',
          `ln -s ${JSON.stringify(sensitivePath)} "$legacy_tmp"`,
          rcShimWrapperHeader(),
          extractRuntimeShellEnvShimSnippet(),
          "ensure_runtime_shell_env_shim",
        ].join("\n");
        writeFileSync(tmpFile, wrapper, { mode: 0o700 });
        execFileSync("bash", [tmpFile], { encoding: "utf-8" });

        expect(readFileSync(sensitivePath, "utf-8")).toBe("SECRET\n");
        const rcFile = readFileSync(rcPath, "utf-8");
        expect(rcFile.toLowerCase()).not.toContain("proxy");
        expect(rcFile).not.toContain(proxyEnvPath);
        expect(rcFile).toContain("export PATH");
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

    it("cleans rc shims without shell chown/chmod on the rc path", () => {
      const fakeHome = mkdtempSync(join(tmpdir(), "nemoclaw-rc-shim-no-path-chmod-test-"));
      const proxyEnvPath = join(fakeHome, "proxy-env.sh");
      const rcPath = join(fakeHome, ".bashrc");
      const tmpFile = join(fakeHome, "rc-shim-no-path-chmod-test.sh");
      try {
        writeFileSync(
          rcPath,
          [
            "# old bashrc",
            "# Source runtime proxy config",
            `[ -f ${proxyEnvPath} ] && . ${proxyEnvPath}`,
            "",
          ].join("\n"),
          { mode: 0o644 },
        );

        const wrapper = [
          "#!/usr/bin/env bash",
          "set -euo pipefail",
          `_SANDBOX_HOME=${JSON.stringify(fakeHome)}`,
          `_RUNTIME_SHELL_ENV_FILE=${JSON.stringify(proxyEnvPath)}`,
          '_RUNTIME_SHELL_ENV_SHIM="[ -f ${_RUNTIME_SHELL_ENV_FILE} ] && . ${_RUNTIME_SHELL_ENV_FILE}"',
          'chown() { echo "unexpected chown $*" >&2; exit 42; }',
          'chmod() { echo "unexpected chmod $*" >&2; exit 43; }',
          rcShimWrapperHeader(),
          extractRuntimeShellEnvShimSnippet(),
        ].join("\n");
        writeFileSync(tmpFile, wrapper, { mode: 0o700 });
        execFileSync("bash", [tmpFile], { encoding: "utf-8" });

        const rcFile = readFileSync(rcPath, "utf-8");
        expect(rcFile.toLowerCase()).not.toContain("proxy");
        expect(rcFile).not.toContain(proxyEnvPath);
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

    it("does not rewrite locked clean rc files", () => {
      const fakeHome = mkdtempSync(join(tmpdir(), "nemoclaw-rc-shim-clean-locked-test-"));
      const proxyEnvPath = join(fakeHome, "proxy-env.sh");
      const rcPath = join(fakeHome, ".bashrc");
      const profilePath = join(fakeHome, ".profile");
      const tmpFile = join(tmpdir(), `rc-shim-clean-locked-test-${process.pid}.sh`);
      try {
        writeFileSync(rcPath, "# clean bashrc\n", { mode: 0o444 });
        writeFileSync(profilePath, "# clean profile\n", { mode: 0o444 });
        execFileSync("chmod", ["555", fakeHome]);

        const wrapper = [
          "#!/usr/bin/env bash",
          "set -euo pipefail",
          `_SANDBOX_HOME=${JSON.stringify(fakeHome)}`,
          `_RUNTIME_SHELL_ENV_FILE=${JSON.stringify(proxyEnvPath)}`,
          '_RUNTIME_SHELL_ENV_SHIM="[ -f ${_RUNTIME_SHELL_ENV_FILE} ] && . ${_RUNTIME_SHELL_ENV_FILE}"',
          rcShimWrapperHeader(),
          extractRuntimeShellEnvShimSnippet(),
          "ensure_runtime_shell_env_shim",
        ].join("\n");
        writeFileSync(tmpFile, wrapper, { mode: 0o700 });
        execFileSync("bash", [tmpFile], { encoding: "utf-8" });

        expect(readFileSync(rcPath, "utf-8")).toBe("# clean bashrc\n");
        expect(readFileSync(profilePath, "utf-8")).toBe("# clean profile\n");
      } finally {
        try {
          execFileSync("chmod", ["755", fakeHome]);
        } catch {
          /* ignore */
        }
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

    const itOnProcFd = existsSync("/proc/self/fd") ? it : it.skip;
    itOnProcFd("removes legacy rc shims without directory write permission", () => {
      const fakeHome = mkdtempSync(join(tmpdir(), "nemoclaw-rc-shim-unwritable-dir-test-"));
      const proxyEnvPath = join(fakeHome, "proxy-env.sh");
      const rcPath = join(fakeHome, ".bashrc");
      const profilePath = join(fakeHome, ".profile");
      const tmpFile = join(tmpdir(), `rc-shim-unwritable-dir-test-${process.pid}.sh`);
      try {
        for (const rcPathToWrite of [rcPath, profilePath]) {
          writeFileSync(
            rcPathToWrite,
            [
              "# old rc",
              "# Source runtime proxy config",
              `[ -f ${proxyEnvPath} ] && . ${proxyEnvPath}`,
              "export PATH=/usr/local/bin:$PATH",
              "",
            ].join("\n"),
            { mode: 0o444 },
          );
        }
        execFileSync("chmod", ["555", fakeHome]);

        const wrapper = [
          "#!/usr/bin/env bash",
          "set -euo pipefail",
          `_SANDBOX_HOME=${JSON.stringify(fakeHome)}`,
          `_RUNTIME_SHELL_ENV_FILE=${JSON.stringify(proxyEnvPath)}`,
          '_RUNTIME_SHELL_ENV_SHIM="[ -f ${_RUNTIME_SHELL_ENV_FILE} ] && . ${_RUNTIME_SHELL_ENV_FILE}"',
          rcShimWrapperHeader(),
          extractRuntimeShellEnvShimSnippet(),
          "ensure_runtime_shell_env_shim",
        ].join("\n");
        writeFileSync(tmpFile, wrapper, { mode: 0o700 });
        execFileSync("bash", [tmpFile], { encoding: "utf-8" });

        for (const rcPathToRead of [rcPath, profilePath]) {
          const rcFile = readFileSync(rcPathToRead, "utf-8");
          expect(rcFile.toLowerCase()).not.toContain("proxy");
          expect(rcFile).not.toContain(proxyEnvPath);
          expect(rcFile).toContain("export PATH");
        }
      } finally {
        try {
          execFileSync("chmod", ["755", fakeHome]);
        } catch {
          /* ignore */
        }
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

    // Composed startup invariant: write_runtime_shell_env emits the proxy
    // env file with mode 444, ensure_runtime_shell_env_shim then sees a
    // foreign-owned .bashrc and must exit 0 (otherwise the entrypoint would
    // terminate the container with exit code 1). The composed assertion
    // proves the legacy trust-boundary file remains non-user-writable
    // across the skip path.
    it("composed startup leaves the proxy env file at mode 444 when the rc cleanup skips a foreign-owned rc file", () => {
      const fakeDataDir = mkdtempSync(join(tmpdir(), "nemoclaw-rc-skip-composed-"));
      const fakeHome = mkdtempSync(join(tmpdir(), "nemoclaw-rc-skip-home-"));
      const proxyEnvPath = join(fakeDataDir, "proxy-env.sh");
      const rcPath = join(fakeHome, ".bashrc");
      const tmpFile = join(tmpdir(), `nemoclaw-rc-skip-composed-${process.pid}.sh`);
      try {
        const shimLine = `[ -f ${proxyEnvPath} ] && . ${proxyEnvPath}`;
        const originalBashrc = [
          "# user-managed bashrc owned by a foreign uid (e.g. root)",
          "# Source runtime proxy config",
          shimLine,
          "export PATH=/usr/local/bin:$PATH",
          "",
        ].join("\n");
        writeFileSync(rcPath, originalBashrc, { mode: 0o644 });

        const persistBlock = extractRuntimeShellEnvSnippet()
          .trimEnd()
          .replaceAll("/tmp/nemoclaw-proxy-env.sh", proxyEnvPath);
        // Foreign uid that does not match the test-runner's actual file owner.
        // Overriding `id -u` for the bash function-level shim invocation is
        // the cheapest way to drive the "uid != owner" branch without root.
        const foreignUid = (process.getuid?.() ?? 1000) + 99999;
        const wrapper = [
          "#!/usr/bin/env bash",
          "set -euo pipefail",
          sandboxInitSource,
          'PROXY_HOST="10.200.0.1"',
          'PROXY_PORT="3128"',
          '_PROXY_URL="http://${PROXY_HOST}:${PROXY_PORT}"',
          '_NO_PROXY_VAL="localhost,127.0.0.1,::1,${PROXY_HOST}"',
          "_TOOL_REDIRECTS=()",
          `_AXIOS_FIX_SCRIPT="/nonexistent/axios-proxy-fix.js"`,
          `_SANDBOX_HOME=${JSON.stringify(fakeHome)}`,
          `_RUNTIME_SHELL_ENV_FILE=${JSON.stringify(proxyEnvPath)}`,
          `_RUNTIME_SHELL_ENV_SHIM="[ -f \${_RUNTIME_SHELL_ENV_FILE} ] && . \${_RUNTIME_SHELL_ENV_FILE}"`,
          rcShimWrapperHeader(),
          // Override `id -u` BEFORE the entrypoint snippets are sourced so the
          // function-shadow is in place when both write_runtime_shell_env and
          // ensure_runtime_shell_env_shim consult `$(id -u)`.
          `id() { case "\${1:-}" in -u) echo ${foreignUid};; *) command id "$@";; esac; }`,
          "set +u",
          persistBlock,
          extractRuntimeShellEnvShimSnippet(),
          "validate_tmp_permissions " + JSON.stringify(proxyEnvPath),
        ].join("\n");
        writeFileSync(tmpFile, wrapper, { mode: 0o700 });
        const result = execFileSync("bash", [tmpFile], { encoding: "utf-8" });

        expect(result).not.toContain("[SECURITY] " + proxyEnvPath + " has unsafe permissions");

        const finalMode = (lstatSync(proxyEnvPath).mode & 0o777).toString(8);
        expect(finalMode).toBe("444");

        const rcAfter = readFileSync(rcPath, "utf-8");
        expect(rcAfter).toBe(originalBashrc);
      } finally {
        try {
          unlinkSync(tmpFile);
        } catch {
          /* ignore */
        }
        try {
          execFileSync("rm", ["-rf", fakeDataDir, fakeHome]);
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
      const fakeDataDir = mkdtempSync(join(tmpdir(), "nemoclaw-symlink-test-"));
      const tmpFile = join(fakeDataDir, "symlink-write-test.sh");
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
      const fakeDataDir = mkdtempSync(join(tmpdir(), "nemoclaw-bashi-test-"));
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
          `_NEMOTRON_FIX_SCRIPT="/tmp/nemoclaw-nemotron-inference-fix.js"`,
          "set +u  # array expansion safe on macOS bash",
          persistBlock
            .trimEnd()
            .replaceAll("/tmp/nemoclaw-proxy-env.sh", `${fakeDataDir}/proxy-env.sh`),
        ].join("\n");
        writeFileSync(tmpFile, wrapper, { mode: 0o700 });
        execFileSync("bash", [tmpFile], { encoding: "utf-8" });

        const envFile = readFileSync(join(fakeDataDir, "proxy-env.sh"), "utf-8");
        // Proxy preloads should NOT be injected when NODE_USE_ENV_PROXY
        // is not 1. The Nemotron inference fix is
        // unconditional (always needed regardless of proxy config).
        expect(envFile).not.toContain("http-proxy-fix");
        expect(envFile).toContain("nemotron-inference-fix");
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
