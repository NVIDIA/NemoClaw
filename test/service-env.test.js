// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import { execSync, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, unlinkSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveOpenshell } from "../bin/lib/resolve-openshell";
import { parseAllowedChatIds, isChatAllowed } from "../bin/lib/chat-filter.js";

describe("service environment", () => {
  describe("start-services behavior", () => {
    const scriptPath = join(import.meta.dirname, "../scripts/start-services.sh");

    it("starts local-only services without NVIDIA_API_KEY", () => {
      const workspace = mkdtempSync(join(tmpdir(), "nemoclaw-services-no-key-"));
      const result = execFileSync("bash", [scriptPath], {
        encoding: "utf-8",
        env: {
          ...process.env,
          NVIDIA_API_KEY: "",
          TELEGRAM_BOT_TOKEN: "",
          SANDBOX_NAME: "test-box",
          TMPDIR: workspace,
        },
      });

      expect(result).not.toContain("NVIDIA_API_KEY required");
      expect(result).toContain("TELEGRAM_BOT_TOKEN not set");
      expect(result).toContain("Telegram:    not started (no token)");
    });

    it("warns and skips Telegram bridge when token is set without NVIDIA_API_KEY", () => {
      const workspace = mkdtempSync(join(tmpdir(), "nemoclaw-services-missing-key-"));
      const result = execFileSync("bash", [scriptPath], {
        encoding: "utf-8",
        env: {
          ...process.env,
          NVIDIA_API_KEY: "",
          TELEGRAM_BOT_TOKEN: "test-token",
          SANDBOX_NAME: "test-box",
          TMPDIR: workspace,
        },
      });

      expect(result).not.toContain("NVIDIA_API_KEY required");
      expect(result).toContain("NVIDIA_API_KEY not set");
      expect(result).toContain("Telegram:    not started (no token)");
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

  describe("ALLOWED_CHAT_IDS propagation (issue #896)", () => {
    const scriptPath = join(import.meta.dirname, "../scripts/start-services.sh");

    it("start-services.sh propagates ALLOWED_CHAT_IDS to nohup child", () => {
      // Patch start-services.sh to launch an env-dump script instead of the
      // real telegram-bridge.js. The real bridge needs Telegram API + openshell,
      // so we swap the node command with a script that writes its env to a file.
      const workspace = mkdtempSync(join(tmpdir(), "nemoclaw-chatids-"));
      const envDump = join(workspace, "child-env.txt");

      // Fake node script that dumps env and exits
      const fakeScript = join(workspace, "fake-bridge.js");
      writeFileSync(
        fakeScript,
        `require("fs").writeFileSync(${JSON.stringify(envDump)}, Object.entries(process.env).map(([k,v])=>k+"="+v).join("\\n"));`,
      );

      // Wrapper that overrides REPO_DIR so start-services.sh launches our fake
      // bridge instead of the real one, and stubs out openshell + cloudflared
      const wrapper = join(workspace, "run.sh");
      writeFileSync(
        wrapper,
        [
          "#!/usr/bin/env bash",
          "set -euo pipefail",
          // Create a fake repo dir with the fake bridge at the expected path
          `FAKE_REPO="${workspace}/fakerepo"`,
          `mkdir -p "$FAKE_REPO/scripts"`,
          `cp "${fakeScript}" "$FAKE_REPO/scripts/telegram-bridge.js"`,
          // Source the start function from the real script, then call it with our fake repo
          `export SANDBOX_NAME="test-box"`,
          `export TELEGRAM_BOT_TOKEN="test-token"`,
          `export NVIDIA_API_KEY="test-key"`,
          `export ALLOWED_CHAT_IDS="111,222,333"`,
          // Stub openshell (prints "Ready" to pass sandbox check) and hide cloudflared
          `BIN_DIR="${workspace}/bin"`,
          `mkdir -p "$BIN_DIR"`,
          `printf '#!/usr/bin/env bash\\necho "Ready"\\n' > "$BIN_DIR/openshell"`,
          `chmod +x "$BIN_DIR/openshell"`,
          `NODE_DIR="$(dirname "$(command -v node)")"`,
          `export PATH="$BIN_DIR:$NODE_DIR:/usr/bin:/bin:/usr/local/bin"`,
          // Run the real script but with REPO_DIR overridden via sed — also disable cloudflared
          `PATCHED="${workspace}/patched-start.sh"`,
          `sed -e 's|REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"|REPO_DIR="'"$FAKE_REPO"'"|' -e 's|command -v cloudflared|false|g' "${scriptPath}" > "$PATCHED"`,
          `chmod +x "$PATCHED"`,
          `bash "$PATCHED"`,
          // Poll for the env dump file (nohup child writes it asynchronously)
          `for i in $(seq 1 20); do [ -s "${envDump}" ] && break; sleep 0.1; done`,
        ].join("\n"),
        { mode: 0o755 },
      );

      execFileSync("bash", [wrapper], { encoding: "utf-8", timeout: 10000 });

      const childEnv = readFileSync(envDump, "utf-8");
      expect(childEnv).toContain("ALLOWED_CHAT_IDS=111,222,333");
      expect(childEnv).toContain("SANDBOX_NAME=test-box");
      expect(childEnv).toContain("TELEGRAM_BOT_TOKEN=test-token");
      expect(childEnv).toContain("NVIDIA_API_KEY=test-key");
    });

    it("telegram-bridge.js imports and uses chat-filter module with correct env var", () => {
      const bridgeSrc = readFileSync(
        join(import.meta.dirname, "../scripts/telegram-bridge.js"),
        "utf-8",
      );
      // Verify it imports the module (not inline parsing)
      expect(bridgeSrc).toContain('require("../bin/lib/chat-filter")');
      // Verify it parses the correct env var name (not a typo like ALLOWED_CHATS)
      expect(bridgeSrc).toContain("parseAllowedChatIds(process.env.ALLOWED_CHAT_IDS)");
      // Verify it uses isChatAllowed for access control
      expect(bridgeSrc).toContain("isChatAllowed(ALLOWED_CHATS, chatId)");
      // Verify the old inline pattern is gone
      expect(bridgeSrc).not.toContain('.split(",").map((s) => s.trim())');
    });

    it("nohup child can parse the propagated ALLOWED_CHAT_IDS value", () => {
      // End-to-end: start-services.sh passes env to child, child parses it
      // using the same chat-filter module telegram-bridge.js uses.
      const workspace = mkdtempSync(join(tmpdir(), "nemoclaw-parse-e2e-"));
      const resultFile = join(workspace, "parse-result.json");

      // Fake bridge that parses ALLOWED_CHAT_IDS using chat-filter and dumps result
      const chatFilterPath = join(import.meta.dirname, "../bin/lib/chat-filter.js");
      const fakeScript = join(workspace, "fake-bridge.js");
      writeFileSync(
        fakeScript,
        [
          `const { parseAllowedChatIds, isChatAllowed } = require(${JSON.stringify(chatFilterPath)});`,
          `const parsed = parseAllowedChatIds(process.env.ALLOWED_CHAT_IDS);`,
          `const result = {`,
          `  raw: process.env.ALLOWED_CHAT_IDS,`,
          `  parsed,`,
          `  allows111: isChatAllowed(parsed, "111"),`,
          `  allows999: isChatAllowed(parsed, "999"),`,
          `};`,
          `require("fs").writeFileSync(${JSON.stringify(resultFile)}, JSON.stringify(result));`,
        ].join("\n"),
      );

      const wrapper = join(workspace, "run.sh");
      writeFileSync(
        wrapper,
        [
          "#!/usr/bin/env bash",
          "set -euo pipefail",
          `FAKE_REPO="${workspace}/fakerepo"`,
          `mkdir -p "$FAKE_REPO/scripts"`,
          `cp "${fakeScript}" "$FAKE_REPO/scripts/telegram-bridge.js"`,
          `export SANDBOX_NAME="test-box"`,
          `export TELEGRAM_BOT_TOKEN="test-token"`,
          `export NVIDIA_API_KEY="test-key"`,
          `export ALLOWED_CHAT_IDS="111, 222 , 333"`,
          // Stub openshell (prints "Ready" to pass sandbox check) and hide cloudflared
          `BIN_DIR="${workspace}/bin"`,
          `mkdir -p "$BIN_DIR"`,
          `printf '#!/usr/bin/env bash\\necho "Ready"\\n' > "$BIN_DIR/openshell"`,
          `chmod +x "$BIN_DIR/openshell"`,
          `NODE_DIR="$(dirname "$(command -v node)")"`,
          `export PATH="$BIN_DIR:$NODE_DIR:/usr/bin:/bin:/usr/local/bin"`,
          `PATCHED="${workspace}/patched-start.sh"`,
          `sed -e 's|REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"|REPO_DIR="'"$FAKE_REPO"'"|' -e 's|command -v cloudflared|false|g' "${scriptPath}" > "$PATCHED"`,
          `chmod +x "$PATCHED"`,
          `bash "$PATCHED"`,
          `for i in $(seq 1 20); do [ -s "${resultFile}" ] && break; sleep 0.1; done`,
        ].join("\n"),
        { mode: 0o755 },
      );

      execFileSync("bash", [wrapper], { encoding: "utf-8", timeout: 10000 });

      const result = JSON.parse(readFileSync(resultFile, "utf-8"));
      expect(result.raw).toBe("111, 222 , 333");
      expect(result.parsed).toEqual(["111", "222", "333"]);
      expect(result.allows111).toBe(true);
      expect(result.allows999).toBe(false);
    });

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

    it("entrypoint persistence writes proxy snippet to ~/.bashrc and ~/.profile", () => {
      const fakeHome = join(tmpdir(), `nemoclaw-home-test-${process.pid}`);
      execFileSync("mkdir", ["-p", fakeHome]);
      const tmpFile = join(tmpdir(), `nemoclaw-bashrc-write-test-${process.pid}.sh`);
      try {
        const scriptPath = join(import.meta.dirname, "../scripts/nemoclaw-start.sh");
        const persistBlock = execFileSync(
          "sed",
          ["-n", "/^_PROXY_URL=/,/^# ── Main/{ /^# ── Main/d; p; }", scriptPath],
          { encoding: "utf-8" },
        );
        const wrapper = [
          "#!/usr/bin/env bash",
          'PROXY_HOST="10.200.0.1"',
          'PROXY_PORT="3128"',
          persistBlock.trimEnd(),
        ].join("\n");
        writeFileSync(tmpFile, wrapper, { mode: 0o700 });
        execFileSync("bash", [tmpFile], {
          encoding: "utf-8",
          env: { ...process.env, HOME: fakeHome },
        });

        const bashrc = readFileSync(join(fakeHome, ".bashrc"), "utf-8");
        expect(bashrc).toContain("export HTTP_PROXY=");
        expect(bashrc).toContain("export HTTPS_PROXY=");
        expect(bashrc).toContain("export NO_PROXY=");
        expect(bashrc).not.toContain("inference.local");
        expect(bashrc).toContain("10.200.0.1");

        const profile = readFileSync(join(fakeHome, ".profile"), "utf-8");
        expect(profile).not.toContain("inference.local");
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

    it("entrypoint persistence is idempotent across repeated invocations", () => {
      const fakeHome = join(tmpdir(), `nemoclaw-idempotent-test-${process.pid}`);
      execFileSync("mkdir", ["-p", fakeHome]);
      const tmpFile = join(tmpdir(), `nemoclaw-idempotent-write-test-${process.pid}.sh`);
      try {
        const scriptPath = join(import.meta.dirname, "../scripts/nemoclaw-start.sh");
        const persistBlock = execFileSync(
          "sed",
          ["-n", "/^_PROXY_URL=/,/^# ── Main/{ /^# ── Main/d; p; }", scriptPath],
          { encoding: "utf-8" },
        );
        const wrapper = [
          "#!/usr/bin/env bash",
          'PROXY_HOST="10.200.0.1"',
          'PROXY_PORT="3128"',
          persistBlock.trimEnd(),
        ].join("\n");
        writeFileSync(tmpFile, wrapper, { mode: 0o700 });
        const runOpts = {
          encoding: /** @type {const} */ ("utf-8"),
          env: { ...process.env, HOME: fakeHome },
        };
        execFileSync("bash", [tmpFile], runOpts);
        execFileSync("bash", [tmpFile], runOpts);
        execFileSync("bash", [tmpFile], runOpts);

        const bashrc = readFileSync(join(fakeHome, ".bashrc"), "utf-8");
        const beginCount = (bashrc.match(/nemoclaw-proxy-config begin/g) || []).length;
        const endCount = (bashrc.match(/nemoclaw-proxy-config end/g) || []).length;
        expect(beginCount).toBe(1);
        expect(endCount).toBe(1);
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

    it("entrypoint persistence replaces stale proxy values on restart", () => {
      const fakeHome = join(tmpdir(), `nemoclaw-replace-test-${process.pid}`);
      execFileSync("mkdir", ["-p", fakeHome]);
      const tmpFile = join(tmpdir(), `nemoclaw-replace-write-test-${process.pid}.sh`);
      try {
        const scriptPath = join(import.meta.dirname, "../scripts/nemoclaw-start.sh");
        const persistBlock = execFileSync(
          "sed",
          ["-n", "/^_PROXY_URL=/,/^# ── Main/{ /^# ── Main/d; p; }", scriptPath],
          { encoding: "utf-8" },
        );
        const makeWrapper = (host) =>
          [
            "#!/usr/bin/env bash",
            `PROXY_HOST="${host}"`,
            'PROXY_PORT="3128"',
            persistBlock.trimEnd(),
          ].join("\n");

        writeFileSync(tmpFile, makeWrapper("10.200.0.1"), { mode: 0o700 });
        execFileSync("bash", [tmpFile], {
          encoding: "utf-8",
          env: { ...process.env, HOME: fakeHome },
        });
        let bashrc = readFileSync(join(fakeHome, ".bashrc"), "utf-8");
        expect(bashrc).toContain("10.200.0.1");

        writeFileSync(tmpFile, makeWrapper("192.168.1.99"), { mode: 0o700 });
        execFileSync("bash", [tmpFile], {
          encoding: "utf-8",
          env: { ...process.env, HOME: fakeHome },
        });
        bashrc = readFileSync(join(fakeHome, ".bashrc"), "utf-8");
        expect(bashrc).toContain("192.168.1.99");
        expect(bashrc).not.toContain("10.200.0.1");
        const beginCount = (bashrc.match(/nemoclaw-proxy-config begin/g) || []).length;
        expect(beginCount).toBe(1);
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
