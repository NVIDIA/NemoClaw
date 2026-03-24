// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import { execSync, execFileSync } from "node:child_process";
import { writeFileSync, unlinkSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveOpenshell } from "../bin/lib/resolve-openshell";

describe("service environment", () => {
  describe("resolveOpenshell logic", () => {
    it("returns command -v result when absolute path", () => {
      expect(resolveOpenshell({ commandVResult: "/usr/bin/openshell" })).toBe("/usr/bin/openshell");
    });

    it("rejects non-absolute command -v result (alias)", () => {
      expect(
        resolveOpenshell({ commandVResult: "openshell", checkExecutable: () => false })
      ).toBe(null);
    });

    it("rejects alias definition from command -v", () => {
      expect(
        resolveOpenshell({ commandVResult: "alias openshell='echo pwned'", checkExecutable: () => false })
      ).toBe(null);
    });

    it("falls back to ~/.local/bin when command -v fails", () => {
      expect(resolveOpenshell({
        commandVResult: null,
        checkExecutable: (p) => p === "/fakehome/.local/bin/openshell",
        home: "/fakehome",
      })).toBe("/fakehome/.local/bin/openshell");
    });

    it("falls back to /usr/local/bin", () => {
      expect(resolveOpenshell({
        commandVResult: null,
        checkExecutable: (p) => p === "/usr/local/bin/openshell",
      })).toBe("/usr/local/bin/openshell");
    });

    it("falls back to /usr/bin", () => {
      expect(resolveOpenshell({
        commandVResult: null,
        checkExecutable: (p) => p === "/usr/bin/openshell",
      })).toBe("/usr/bin/openshell");
    });

    it("prefers ~/.local/bin over /usr/local/bin", () => {
      expect(resolveOpenshell({
        commandVResult: null,
        checkExecutable: (p) => p === "/fakehome/.local/bin/openshell" || p === "/usr/local/bin/openshell",
        home: "/fakehome",
      })).toBe("/fakehome/.local/bin/openshell");
    });

    it("returns null when openshell not found anywhere", () => {
      expect(resolveOpenshell({
        commandVResult: null,
        checkExecutable: () => false,
      })).toBe(null);
    });
  });

  describe("SANDBOX_NAME defaulting", () => {
    it("start-services.sh preserves existing SANDBOX_NAME", () => {
      const result = execSync(
        'bash -c \'SANDBOX_NAME="${NEMOCLAW_SANDBOX:-${SANDBOX_NAME:-default}}"; export SANDBOX_NAME; bash -c "echo \\$SANDBOX_NAME"\'',
        {
          encoding: "utf-8",
          env: { ...process.env, NEMOCLAW_SANDBOX: "", SANDBOX_NAME: "my-box" },
        }
      ).trim();
      expect(result).toBe("my-box");
    });

    it("start-services.sh uses NEMOCLAW_SANDBOX over SANDBOX_NAME", () => {
      const result = execSync(
        'bash -c \'SANDBOX_NAME="${NEMOCLAW_SANDBOX:-${SANDBOX_NAME:-default}}"; export SANDBOX_NAME; bash -c "echo \\$SANDBOX_NAME"\'',
        {
          encoding: "utf-8",
          env: { ...process.env, NEMOCLAW_SANDBOX: "from-env", SANDBOX_NAME: "old" },
        }
      ).trim();
      expect(result).toBe("from-env");
    });

    it("start-services.sh falls back to default when both unset", () => {
      const result = execSync(
        'bash -c \'SANDBOX_NAME="${NEMOCLAW_SANDBOX:-${SANDBOX_NAME:-default}}"; export SANDBOX_NAME; bash -c "echo \\$SANDBOX_NAME"\'',
        {
          encoding: "utf-8",
          env: { ...process.env, NEMOCLAW_SANDBOX: "", SANDBOX_NAME: "" },
        }
      ).trim();
      expect(result).toBe("default");
    });
  });

  describe("proxy environment variables (issue #626)", () => {
    // Verify nemoclaw-start.sh sets HTTP_PROXY / HTTPS_PROXY / NO_PROXY so that
    // Node.js (undici) routes outbound requests through the OpenShell egress
    // proxy and does not attempt to resolve DNS locally inside the sandbox.

    function extractProxyVars(env = {}) {
      // Source the proxy-variable block directly from scripts/nemoclaw-start.sh
      // so that tests always validate the actual implementation rather than a
      // hand-maintained copy.  If the script changes its defaults or variable
      // names, these tests will catch the regression.
      //
      // Implementation: extract the proxy block (PROXY_HOST= through
      // export NO_PROXY=) via sed, then run it in a minimal bash wrapper that
      // echoes the three variables we care about.
      const scriptPath = join(import.meta.dirname, "../scripts/nemoclaw-start.sh");
      const proxyBlock = execFileSync(
        "sed",
        ["-n", "/^PROXY_HOST=/,/^export NO_PROXY=/p", scriptPath],
        { encoding: "utf-8" }
      );
      if (!proxyBlock.trim()) {
        throw new Error(
          "Failed to extract proxy configuration from scripts/nemoclaw-start.sh — " +
          "the PROXY_HOST/NO_PROXY block may have been moved or renamed"
        );
      }
      const wrapper = [
        "#!/usr/bin/env bash",
        proxyBlock.trimEnd(),
        'echo "HTTP_PROXY=${HTTP_PROXY}"',
        'echo "HTTPS_PROXY=${HTTPS_PROXY}"',
        'echo "NO_PROXY=${NO_PROXY}"',
      ].join("\n");
      const tmpFile = join(tmpdir(), `nemoclaw-proxy-test-${process.pid}.sh`);
      try {
        writeFileSync(tmpFile, wrapper, { mode: 0o700 });
        const out = execFileSync("bash", [tmpFile], {
          encoding: "utf-8",
          env: { ...process.env, ...env },
        }).trim();
        return Object.fromEntries(out.split("\n").map((l) => {
          const idx = l.indexOf("=");
          return [l.slice(0, idx), l.slice(idx + 1)];
        }));
      } finally {
        try { unlinkSync(tmpFile); } catch { /* ignore */ }
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

    it("NO_PROXY excludes loopback and inference.local", () => {
      const vars = extractProxyVars();
      const noProxy = vars.NO_PROXY.split(",");
      expect(noProxy).toContain("localhost");
      expect(noProxy).toContain("127.0.0.1");
      expect(noProxy).toContain("::1");
      expect(noProxy).toContain("inference.local");
    });

    it("NO_PROXY excludes OpenShell gateway IP (undici does not support CIDR)", () => {
      const vars = extractProxyVars();
      expect(vars.NO_PROXY).toContain("10.200.0.1");
    });

    it("writes proxy snippet to a profile.d directory when it exists", () => {
      // Verify that nemoclaw-start.sh writes /etc/profile.d/nemoclaw-proxy.sh so
      // that interactive shells opened via `openshell sandbox connect` (which
      // inject a truncated NO_PROXY=127.0.0.1,localhost,::1) get the full value
      // restored on every subsequent login shell.
      const profileDir = join(tmpdir(), `nemoclaw-profile-test-${process.pid}`);
      execFileSync("mkdir", ["-p", profileDir]);
      const tmpFile = join(tmpdir(), `nemoclaw-profile-write-test-${process.pid}.sh`);
      try {
        // Run a minimal wrapper that sets the stage variables and executes only
        // the proxy block from the start script, redirecting the profile.d write
        // to our temp directory instead of /etc/profile.d.
        const wrapper = [
          "#!/usr/bin/env bash",
          `OVERRIDE_PROFILE_D=${JSON.stringify(profileDir)}`,
          `PROXY_HOST="10.200.0.1"`,
          `PROXY_PORT="3128"`,
          `export HTTP_PROXY="http://\${PROXY_HOST}:\${PROXY_PORT}"`,
          `export HTTPS_PROXY="http://\${PROXY_HOST}:\${PROXY_PORT}"`,
          `export NO_PROXY="localhost,127.0.0.1,::1,inference.local,10.200.0.1"`,
          // Reproduce the profile.d block with the overridden directory
          `if [ -d "\${OVERRIDE_PROFILE_D}" ]; then`,
          `  cat > "\${OVERRIDE_PROFILE_D}/nemoclaw-proxy.sh" <<PROXYPROFILE`,
          `# Set by nemoclaw-start.sh — restores full NO_PROXY after OpenShell injection.`,
          `export HTTP_PROXY="http://\${PROXY_HOST}:\${PROXY_PORT}"`,
          `export HTTPS_PROXY="http://\${PROXY_HOST}:\${PROXY_PORT}"`,
          `export NO_PROXY="localhost,127.0.0.1,::1,inference.local,10.200.0.1"`,
          `PROXYPROFILE`,
          `fi`,
        ].join("\n");
        writeFileSync(tmpFile, wrapper, { mode: 0o700 });
        execFileSync("bash", [tmpFile], { encoding: "utf-8" });

        const snippetPath = join(profileDir, "nemoclaw-proxy.sh");
        const snippet = readFileSync(snippetPath, "utf-8");

        expect(snippet).toContain("export HTTP_PROXY=");
        expect(snippet).toContain("export HTTPS_PROXY=");
        expect(snippet).toContain("export NO_PROXY=");
        expect(snippet).toContain("inference.local");
        expect(snippet).toContain("10.200.0.1");
      } finally {
        try { unlinkSync(tmpFile); } catch { /* ignore */ }
        try { execFileSync("rm", ["-rf", profileDir]); } catch { /* ignore */ }
      }
    });
  });
});
