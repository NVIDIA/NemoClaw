// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { runCapture } from "../bin/lib/runner";

const runnerPath = path.join(import.meta.dirname, "..", "bin", "lib", "runner");

describe("runner helpers", () => {
  it("does not let child commands consume installer stdin", () => {
    const script = `
      const { run } = require(${JSON.stringify(runnerPath)});
      process.stdin.setEncoding("utf8");
      run("cat >/dev/null || true");
      process.stdin.once("data", (chunk) => {
        process.stdout.write(chunk);
      });
    `;

    const result = spawnSync("node", ["-e", script], {
      cwd: path.join(import.meta.dirname, ".."),
      encoding: "utf-8",
      input: "preserved-answer\n",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("preserved-answer\n");
  });

  it("uses inherited stdio for interactive commands only", () => {
    const calls = [];
    const originalSpawnSync = childProcess.spawnSync;
    // @ts-expect-error — intentional partial mock for testing
    childProcess.spawnSync = (...args) => {
      calls.push(args);
      return { status: 0, stdout: "", stderr: "" };
    };

    try {
      delete require.cache[require.resolve(runnerPath)];
      const { run, runInteractive } = require(runnerPath);
      run("echo noninteractive");
      runInteractive("echo interactive");
    } finally {
      childProcess.spawnSync = originalSpawnSync;
      delete require.cache[require.resolve(runnerPath)];
    }

    expect(calls).toHaveLength(2);
    expect(calls[0][2].stdio).toEqual(["ignore", "pipe", "pipe"]);
    expect(calls[1][2].stdio).toEqual(["inherit", "pipe", "pipe"]);
  });
});

describe("runner env merging", () => {
  it("preserves process env when opts.env is provided to runCapture", () => {
    const originalGateway = process.env.OPENSHELL_GATEWAY;
    process.env.OPENSHELL_GATEWAY = "nemoclaw";
    try {
      const output = runCapture('printf \'%s %s\' "$OPENSHELL_GATEWAY" "$OPENAI_API_KEY"', {
        env: { OPENAI_API_KEY: "sk-test-secret" },
      });
      expect(output).toBe("nemoclaw sk-test-secret");
    } finally {
      if (originalGateway === undefined) {
        delete process.env.OPENSHELL_GATEWAY;
      } else {
        process.env.OPENSHELL_GATEWAY = originalGateway;
      }
    }
  });

  it("preserves process env when opts.env is provided to run", () => {
    const calls = [];
    const originalSpawnSync = childProcess.spawnSync;
    const originalPath = process.env.PATH;
    // @ts-expect-error — intentional partial mock for testing
    childProcess.spawnSync = (...args) => {
      calls.push(args);
      return { status: 0, stdout: "", stderr: "" };
    };

    try {
      delete require.cache[require.resolve(runnerPath)];
      const { run } = require(runnerPath);
      process.env.PATH = "/usr/local/bin:/usr/bin";
      run("echo test", {
        env: { OPENSHELL_CLUSTER_IMAGE: "ghcr.io/nvidia/openshell/cluster:0.0.12" },
      });
    } finally {
      if (originalPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = originalPath;
      }
      childProcess.spawnSync = originalSpawnSync;
      delete require.cache[require.resolve(runnerPath)];
    }

    expect(calls).toHaveLength(1);
    expect(calls[0][2].env.OPENSHELL_CLUSTER_IMAGE).toBe("ghcr.io/nvidia/openshell/cluster:0.0.12");
    expect(calls[0][2].env.PATH).toBe("/usr/local/bin:/usr/bin");
  });
});

describe("shellQuote", () => {
  it("wraps in single quotes", () => {
    const { shellQuote } = require(runnerPath);
    expect(shellQuote("hello")).toBe("'hello'");
  });

  it("escapes embedded single quotes", () => {
    const { shellQuote } = require(runnerPath);
    expect(shellQuote("it's")).toBe("'it'\\''s'");
  });

  it("neutralizes shell metacharacters", () => {
    const { shellQuote } = require(runnerPath);
    const dangerous = "test; rm -rf /";
    const quoted = shellQuote(dangerous);
    expect(quoted).toBe("'test; rm -rf /'");
    const result = spawnSync("bash", ["-c", `echo ${quoted}`], { encoding: "utf-8" });
    expect(result.stdout.trim()).toBe(dangerous);
  });

  it("handles backticks and dollar signs", () => {
    const { shellQuote } = require(runnerPath);
    const payload = "test`whoami`$HOME";
    const quoted = shellQuote(payload);
    const result = spawnSync("bash", ["-c", `echo ${quoted}`], { encoding: "utf-8" });
    expect(result.stdout.trim()).toBe(payload);
  });
});

describe("validateName", () => {
  it("accepts valid RFC 1123 names", () => {
    const { validateName } = require(runnerPath);
    expect(validateName("my-sandbox")).toBe("my-sandbox");
    expect(validateName("test123")).toBe("test123");
    expect(validateName("a")).toBe("a");
  });

  it("rejects names with shell metacharacters", () => {
    const { validateName } = require(runnerPath);
    expect(() => validateName("test; whoami")).toThrow(/Invalid/);
    expect(() => validateName("test`id`")).toThrow(/Invalid/);
    expect(() => validateName("test$(cat /etc/passwd)")).toThrow(/Invalid/);
    expect(() => validateName("../etc/passwd")).toThrow(/Invalid/);
  });

  it("rejects empty and overlength names", () => {
    const { validateName } = require(runnerPath);
    expect(() => validateName("")).toThrow(/required/);
    expect(() => validateName(null)).toThrow(/required/);
    expect(() => validateName("a".repeat(64))).toThrow(/too long/);
  });

  it("rejects uppercase and special characters", () => {
    const { validateName } = require(runnerPath);
    expect(() => validateName("MyBox")).toThrow(/Invalid/);
    expect(() => validateName("my_box")).toThrow(/Invalid/);
    expect(() => validateName("-leading")).toThrow(/Invalid/);
    expect(() => validateName("trailing-")).toThrow(/Invalid/);
  });
});

describe("redact", () => {
  it("masks NVIDIA API keys", () => {
    const { redact } = require(runnerPath);
    expect(redact("key is nvapi-abc123XYZ_def456")).toBe("key is nvap******************");
  });

  it("masks NVCF keys", () => {
    const { redact } = require(runnerPath);
    expect(redact("nvcf-abcdef1234567890")).toBe("nvcf*****************");
  });

  it("masks bearer tokens", () => {
    const { redact } = require(runnerPath);
    expect(redact("Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload")).toBe(
      "Authorization: Bearer eyJh********************",
    );
  });

  it("masks key assignments in commands", () => {
    const { redact } = require(runnerPath);
    expect(redact("export NVIDIA_API_KEY=nvapi-realkey12345")).toContain("nvap");
    expect(redact("export NVIDIA_API_KEY=nvapi-realkey12345")).not.toContain("realkey12345");
  });

  it("masks variables ending in _KEY", () => {
    const { redact } = require(runnerPath);
    const output = redact('export SERVICE_KEY="supersecretvalue12345"');
    expect(output).not.toContain("supersecretvalue12345");
    expect(output).toContain('export SERVICE_KEY="supe');
  });

  it("masks bare GitHub personal access tokens", () => {
    const { redact } = require(runnerPath);
    const output = redact("token ghp_abcdefghijklmnopqrstuvwxyz1234567890");
    expect(output).toContain("ghp_");
    expect(output).not.toContain("abcdefghijklmnopqrstuvwxyz1234567890");
  });

  it("masks bearer tokens case-insensitively", () => {
    const { redact } = require(runnerPath);
    expect(redact("authorization: bearer someBearerToken")).toContain("some****");
    expect(redact("authorization: bearer someBearerToken")).not.toContain("someBearerToken");
    expect(redact("AUTHORIZATION: BEARER someBearerToken")).toContain("some****");
    expect(redact("AUTHORIZATION: BEARER someBearerToken")).not.toContain("someBearerToken");
  });

  it("masks bearer tokens with repeated spacing", () => {
    const { redact } = require(runnerPath);
    const output = redact("Authorization: Bearer   someBearerToken");
    expect(output).toContain("some****");
    expect(output).not.toContain("someBearerToken");
  });

  it("masks quoted assignment values", () => {
    const { redact } = require(runnerPath);
    const output = redact('API_KEY="secret123abc"');
    expect(output).not.toContain("secret123abc");
    expect(output).toContain('API_KEY="sec');
  });

  it("masks multiple secrets in one string", () => {
    const { redact } = require(runnerPath);
    const output = redact("nvapi-firstkey12345 nvapi-secondkey67890");
    expect(output).not.toContain("firstkey12345");
    expect(output).not.toContain("secondkey67890");
    expect(output).toContain("nvap");
    expect(output).toContain(" ");
  });

  it("masks URL credentials and auth query parameters", () => {
    const { redact } = require(runnerPath);
    const output = redact(
      "https://alice:secret@example.com/v1/models?auth=abc123456789&sig=def987654321&keep=yes",
    );
    expect(output).toBe("https://alice:****@example.com/v1/models?auth=****&sig=****&keep=yes");
  });

  it("masks auth-style query parameters case-insensitively", () => {
    const { redact } = require(runnerPath);
    const output = redact("https://example.com?Signature=secret123456&AUTH=anothersecret123");
    expect(output).toBe("https://example.com/?Signature=****&AUTH=****");
  });

  it("leaves non-secret strings untouched", () => {
    const { redact } = require(runnerPath);
    expect(redact("docker run --name my-sandbox")).toBe("docker run --name my-sandbox");
    expect(redact("openshell sandbox list")).toBe("openshell sandbox list");
  });

  it("handles non-string input gracefully", () => {
    const { redact } = require(runnerPath);
    expect(redact(null)).toBe(null);
    expect(redact(undefined)).toBe(undefined);
    expect(redact(42)).toBe(42);
  });
});

describe("regression guards", () => {
  it("runCapture redacts secrets before rethrowing errors", () => {
    const originalExecSync = childProcess.execSync;
    childProcess.execSync = () => {
      throw new Error(
        'command failed: export SERVICE_KEY="supersecretvalue12345" ghp_abcdefghijklmnopqrstuvwxyz1234567890',
      );
    };

    try {
      delete require.cache[require.resolve(runnerPath)];
      const { runCapture } = require(runnerPath);

      let error;
      try {
        runCapture("echo nope");
      } catch (err) {
        error = err;
      }

      expect(error).toBeInstanceOf(Error);
      expect(error.message).toContain("ghp_");
      expect(error.message).not.toContain("supersecretvalue12345");
      expect(error.message).not.toContain("abcdefghijklmnopqrstuvwxyz1234567890");
    } finally {
      childProcess.execSync = originalExecSync;
      delete require.cache[require.resolve(runnerPath)];
    }
  });

  it("runCapture redacts execSync error cmd/output fields", () => {
    const originalExecSync = childProcess.execSync;
    childProcess.execSync = () => {
      const err = /** @type {any} */ (new Error("command failed"));
      err.cmd = "echo nvapi-aaaabbbbcccc1111 && echo ghp_abcdefghijklmnopqrstuvwxyz123456";
      err.output = ["stdout: nvapi-aaaabbbbcccc1111", "stderr: PASSWORD=secret123456"];
      throw err;
    };

    try {
      delete require.cache[require.resolve(runnerPath)];
      const { runCapture } = require(runnerPath);

      let error;
      try {
        runCapture("echo nope");
      } catch (err) {
        error = /** @type {any} */ (err);
      }

      expect(error).toBeDefined();
      expect(error).toBeInstanceOf(Error);
      expect(error.cmd).not.toContain("nvapi-aaaabbbbcccc1111");
      expect(error.cmd).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz123456");
      expect(Array.isArray(error.output)).toBe(true);
      expect(error.output[0]).not.toContain("nvapi-aaaabbbbcccc1111");
      expect(error.output[1]).not.toContain("secret123456");
      expect(error.output[0]).toContain("****");
      expect(error.output[1]).toContain("****");
    } finally {
      childProcess.execSync = originalExecSync;
      delete require.cache[require.resolve(runnerPath)];
    }
  });

  it("run redacts captured child output before printing on failure", () => {
    const originalSpawnSync = childProcess.spawnSync;
    const originalExit = process.exit;
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    // @ts-expect-error — intentional partial mock for testing
    childProcess.spawnSync = () => ({
      status: 1,
      stdout: "token ghp_abcdefghijklmnopqrstuvwxyz1234567890\n",
      stderr: 'export SERVICE_KEY="supersecretvalue12345"\n',
    });
    process.exit = (code) => {
      throw new Error(`exit:${code}`);
    };

    try {
      delete require.cache[require.resolve(runnerPath)];
      const { run } = require(runnerPath);
      expect(() => run("echo fail")).toThrow("exit:1");
      expect(stdoutSpy).toHaveBeenCalledWith("token ghp_********************\n");
      expect(stderrSpy).toHaveBeenCalledWith('export SERVICE_KEY="supe*****************"\n');
      expect(errorSpy).toHaveBeenCalledWith("  Command failed (exit 1): echo fail");
    } finally {
      childProcess.spawnSync = originalSpawnSync;
      process.exit = originalExit;
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
      errorSpy.mockRestore();
      delete require.cache[require.resolve(runnerPath)];
    }
  });

  it("runInteractive keeps stdin inherited while redacting captured output", () => {
    const originalSpawnSync = childProcess.spawnSync;
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const calls = [];

    // @ts-expect-error — intentional partial mock for testing
    childProcess.spawnSync = (...args) => {
      calls.push(args);
      return {
        status: 0,
        stdout: "visit https://alice:secret@example.com/?token=abc123456789\n", // gitleaks:allow
        stderr: "",
      };
    };

    try {
      delete require.cache[require.resolve(runnerPath)];
      const { runInteractive } = require(runnerPath);
      runInteractive("echo interactive");
      expect(calls[0][2].stdio).toEqual(["inherit", "pipe", "pipe"]);
      expect(stdoutSpy).toHaveBeenCalledWith("visit https://alice:****@example.com/?token=****\n");
      expect(stderrSpy).not.toHaveBeenCalled();
    } finally {
      childProcess.spawnSync = originalSpawnSync;
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
      delete require.cache[require.resolve(runnerPath)];
    }
  });

  it("nemoclaw.js does not use execSync", () => {
    const src = fs.readFileSync(
      path.join(import.meta.dirname, "..", "bin", "nemoclaw.js"),
      "utf-8",
    );
    const lines = src.split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      if (lines[i].includes("execSync") && !lines[i].includes("execFileSync")) {
        expect.unreachable(`bin/nemoclaw.js:${i + 1} uses execSync — use execFileSync instead`);
      }
    }
  });

  it("no duplicate shellQuote definitions in bin/", () => {
    const binDir = path.join(import.meta.dirname, "..", "bin");
    const files = [];
    function walk(dir) {
      for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
        if (f.isDirectory() && f.name !== "node_modules") walk(path.join(dir, f.name));
        else if (f.name.endsWith(".js")) files.push(path.join(dir, f.name));
      }
    }
    walk(binDir);

    const defs = [];
    for (const file of files) {
      const src = fs.readFileSync(file, "utf-8");
      if (src.includes("function shellQuote")) {
        defs.push(file.replace(binDir, "bin"));
      }
    }
    expect(defs).toHaveLength(1);
    expect(defs[0].includes("runner")).toBeTruthy();
  });

  it("CLI rejects malicious sandbox names before shell commands (e2e)", () => {
    const canaryDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-canary-"));
    const canary = path.join(canaryDir, "executed");
    try {
      const result = spawnSync(
        "node",
        [
          path.join(import.meta.dirname, "..", "bin", "nemoclaw.js"),
          `test; touch ${canary}`,
          "connect",
        ],
        {
          encoding: "utf-8",
          timeout: 10000,
          cwd: path.join(import.meta.dirname, ".."),
        },
      );
      expect(result.status).not.toBe(0);
      expect(fs.existsSync(canary)).toBe(false);
    } finally {
      fs.rmSync(canaryDir, { recursive: true, force: true });
    }
  });

  describe("credential exposure guards (#429)", () => {
    it("onboard createSandbox does not pass NVIDIA_API_KEY to sandbox env", () => {
      const fs = require("fs");
      const src = fs.readFileSync(
        path.join(import.meta.dirname, "..", "bin", "lib", "onboard.js"),
        "utf-8",
      );
      // Find the envArgs block in createSandbox — it should not contain NVIDIA_API_KEY
      const envArgsMatch = src.match(/const envArgs = \[[\s\S]*?\];/);
      expect(envArgsMatch).toBeTruthy();
      expect(envArgsMatch[0].includes("NVIDIA_API_KEY")).toBe(false);
    });

    it("onboard clears NVIDIA_API_KEY from process.env after setupInference", () => {
      const fs = require("fs");
      const src = fs.readFileSync(
        path.join(import.meta.dirname, "..", "bin", "lib", "onboard.js"),
        "utf-8",
      );
      expect(src.includes("delete process.env.NVIDIA_API_KEY")).toBeTruthy();
    });

    it("setupSpark is a compatibility alias that does not shell out to sudo", () => {
      const fs = require("fs");
      const src = fs.readFileSync(
        path.join(import.meta.dirname, "..", "bin", "nemoclaw.js"),
        "utf-8",
      );
      expect(src).toContain("`nemoclaw setup-spark` is deprecated.");
      expect(src).toContain("await onboard(args);");
      expect(src).not.toContain('sudo bash "${SCRIPTS}/setup-spark.sh"');
    });

    it("walkthrough.sh does not embed NVIDIA_API_KEY in tmux or sandbox commands", () => {
      const fs = require("fs");
      const src = fs.readFileSync(
        path.join(import.meta.dirname, "..", "scripts", "walkthrough.sh"),
        "utf-8",
      );
      // Check only executable lines (tmux spawn, openshell connect) — not comments/docs
      const cmdLines = src
        .split("\n")
        .filter(
          (l) =>
            !l.trim().startsWith("#") &&
            !l.trim().startsWith("echo") &&
            (l.includes("tmux") || l.includes("openshell sandbox connect")),
        );
      for (const line of cmdLines) {
        expect(line.includes("NVIDIA_API_KEY")).toBe(false);
      }
    });

    it("install-openshell.sh verifies OpenShell binary checksum after download", () => {
      const src = fs.readFileSync(
        path.join(import.meta.dirname, "..", "scripts", "install-openshell.sh"),
        "utf-8",
      );
      expect(src).toContain("openshell-checksums-sha256.txt");
      expect(src).toContain("shasum -a 256 -c");
    });

    it("install-openshell.sh falls back to curl when gh fails (#1318)", () => {
      const src = fs.readFileSync(
        path.join(import.meta.dirname, "..", "scripts", "install-openshell.sh"),
        "utf-8",
      );
      expect(src).toContain("download_with_curl");
      const ghBlock = src.slice(src.indexOf("command -v gh"));
      expect(ghBlock).toContain("2>/dev/null");
      expect(ghBlock).toContain("falling back to curl");
      expect(ghBlock).toContain("download_with_curl");
    });

    it("install-openshell.sh gh-absent path uses curl directly", () => {
      const src = fs.readFileSync(
        path.join(import.meta.dirname, "..", "scripts", "install-openshell.sh"),
        "utf-8",
      );
      expect(src).toContain("download_with_curl");
      const ghCheck = src.indexOf("command -v gh");
      const elseBlock = src.indexOf("\nelse\n", ghCheck);
      const finalFi = src.indexOf("\nfi\n", elseBlock);
      expect(ghCheck).toBeGreaterThan(-1);
      expect(elseBlock).toBeGreaterThan(ghCheck);
      expect(finalFi).toBeGreaterThan(elseBlock);
      const fallthrough = src.slice(elseBlock, finalFi);
      expect(fallthrough).toContain("download_with_curl");
      expect(fallthrough).not.toContain("gh release");
    });

    it("install-openshell.sh gh-present-but-fails path falls back to curl", () => {
      const scriptPath = path.join(import.meta.dirname, "..", "scripts", "install-openshell.sh");
      const tmpBin = fs.mkdtempSync(path.join(os.tmpdir(), "gh-stub-"));
      const ghStub = path.join(tmpBin, "gh");
      fs.writeFileSync(ghStub, "#!/bin/sh\nexit 4\n");
      fs.chmodSync(ghStub, 0o755);

      const stub = `
        #!/usr/bin/env bash
        openshell() { echo "openshell 0.0.1"; }
        export -f openshell
        export PATH="${tmpBin}:/usr/bin:/bin"
        curl() { echo "CURL_FALLBACK $*"; return 0; }
        export -f curl
        shasum() { echo "checksum OK"; return 0; }
        export -f shasum
        tar() { return 0; }; export -f tar
        install() { return 0; }; export -f install
        source "${scriptPath}"
      `;
      try {
        const result = spawnSync("bash", ["-c", stub], {
          encoding: "utf-8",
          timeout: 5000,
        });
        const out = (result.stdout || "") + (result.stderr || "");
        expect(out).toContain("falling back to curl");
        expect(out).toContain("CURL_FALLBACK");
      } finally {
        fs.rmSync(tmpBin, { recursive: true, force: true });
      }
    });
  });

  describe("curl-pipe-to-shell guards (#574, #583)", () => {
    // Strip comment lines, then join line continuations so multiline
    // curl ... |\n  bash patterns are caught by the single-line regex.
    const stripComments = (src, commentPrefix) =>
      src
        .split("\n")
        .filter((l) => !l.trim().startsWith(commentPrefix))
        .join("\n");

    const joinContinuations = (src) => src.replace(/\\\n\s*/g, " ");

    const collapseMultilinePipes = (src) => src.replace(/\|\s*\n\s*/g, "| ");

    const normalize = (src, commentPrefix) =>
      collapseMultilinePipes(joinContinuations(stripComments(src, commentPrefix)));

    const shellViolationRe = /curl\s[^|]*\|\s*(sh|bash|sudo\s+(-\S+\s+)*(sh|bash))\b/;
    const jsViolationRe = /curl.*\|\s*(sh|bash|sudo\s+(-\S+\s+)*(sh|bash))\b/;

    const findShellViolations = (src) => {
      const normalized = normalize(src, "#");
      return normalized.split("\n").filter((line) => {
        const t = line.trim();
        if (t.startsWith("printf") || t.startsWith("echo") || t.startsWith("warn")) return false;
        return shellViolationRe.test(t);
      });
    };

    const findJsViolations = (src) => {
      const normalized = normalize(src, "//");
      return normalized.split("\n").filter((line) => {
        const t = line.trim();
        if (t.startsWith("*")) return false;
        return jsViolationRe.test(t);
      });
    };

    it("install.sh does not pipe curl to shell", () => {
      const src = fs.readFileSync(path.join(import.meta.dirname, "..", "install.sh"), "utf-8");
      expect(findShellViolations(src)).toEqual([]);
    });

    it("scripts/install.sh does not pipe curl to shell", () => {
      const src = fs.readFileSync(
        path.join(import.meta.dirname, "..", "scripts", "install.sh"),
        "utf-8",
      );
      expect(findShellViolations(src)).toEqual([]);
    });

    it("scripts/brev-setup.sh has been removed", () => {
      expect(fs.existsSync(path.join(import.meta.dirname, "..", "scripts", "brev-setup.sh"))).toBe(
        false,
      );
    });

    it("services no longer tell users to install brev-setup.sh", () => {
      const src = fs.readFileSync(
        path.join(import.meta.dirname, "..", "src", "lib", "services.ts"),
        "utf-8",
      );
      expect(src).not.toContain("brev-setup.sh");
    });

    it("deploy uses the standard installer and connects to the actual sandbox name", () => {
      const tsSrc = fs.readFileSync(
        path.join(import.meta.dirname, "..", "src", "lib", "deploy.ts"),
        "utf-8",
      );
      const src = fs.readFileSync(
        path.join(import.meta.dirname, "..", "bin", "nemoclaw.js"),
        "utf-8",
      );
      expect(src).toContain('const { executeDeploy } = require("../dist/lib/deploy")');
      expect(tsSrc).toContain("export function inferDeployProvider(");
      expect(tsSrc).toContain("export function buildDeployEnvLines(");
      expect(tsSrc).toContain(
        "bash scripts/install.sh --non-interactive --yes-i-accept-third-party-software",
      );
      expect(tsSrc).not.toContain("sandbox connect nemoclaw");
      expect(tsSrc).toContain("openshell sandbox connect ${shellQuote(sandboxName)}");
    });

    it("deploy syncs a complete buildable checkout instead of excluding src", () => {
      const src = fs.readFileSync(
        path.join(import.meta.dirname, "..", "src", "lib", "deploy.ts"),
        "utf-8",
      );
      expect(src).not.toContain("--exclude src");
      expect(src).toContain('"${rootDir}/"');
      expect(src).toContain("--exclude dist");
      expect(src).toContain('const brevProvider = String(env.NEMOCLAW_BREV_PROVIDER || "gcp")');
      expect(src).toContain("--provider ${shellQuote(brevProvider)}");
    });

    it("deploy supports test-friendly non-interactive skip flags", () => {
      const src = fs.readFileSync(
        path.join(import.meta.dirname, "..", "src", "lib", "deploy.ts"),
        "utf-8",
      );
      expect(src).toContain("NEMOCLAW_DEPLOY_NO_CONNECT");
      expect(src).toContain("NEMOCLAW_DEPLOY_NO_START_SERVICES");
      expect(src).toContain("Skipping interactive sandbox connect");
    });

    it("deploy pins SSH host keys via TOFU instead of accept-new (#691)", () => {
      const src = fs.readFileSync(
        path.join(import.meta.dirname, "..", "src", "lib", "deploy.ts"),
        "utf-8",
      );
      expect(src).not.toContain("StrictHostKeyChecking=accept-new");
      expect(src).toContain("StrictHostKeyChecking=yes");
      expect(src).toContain("ssh-keyscan");
      expect(src).toContain("UserKnownHostsFile=");
      expect(src).toContain("nemoclaw-ssh-");
    });

    it("deploy reports Brev failure states before SSH timeout", () => {
      const src = fs.readFileSync(
        path.join(import.meta.dirname, "..", "src", "lib", "deploy.ts"),
        "utf-8",
      );
      expect(src).toContain("function getBrevInstanceStatus(");
      expect(src).toContain('brev", ["ls", "--json"]');
      expect(src).toContain("Brev instance '${name}' did not become ready.");
      expect(src).toContain("Try: brev reset");
      expect(src).toContain("Brev status at timeout:");
    });

    it("brev e2e suite includes a deploy-cli mode", () => {
      const src = fs.readFileSync(
        path.join(import.meta.dirname, "..", "test", "e2e", "brev-e2e.test.js"),
        "utf-8",
      );
      expect(src).toContain('TEST_SUITE === "deploy-cli"');
      expect(src).toContain("deploy CLI provisions a remote sandbox end to end");
      expect(src).toContain('NEMOCLAW_DEPLOY_NO_CONNECT: "1"');
    });

    it("brev e2e suite relies on an authenticated brev CLI instead of a Brev API token", () => {
      const src = fs.readFileSync(
        path.join(import.meta.dirname, "..", "test", "e2e", "brev-e2e.test.js"),
        "utf-8",
      );
      expect(src).toContain("const hasAuthenticatedBrev =");
      expect(src).toContain('brev("ls")');
      expect(src).not.toContain("BREV_API_TOKEN");
      expect(src).not.toContain('brev("login", "--token"');
    });

    it("brev e2e suite no longer contains the old brev-setup compatibility path", () => {
      const src = fs.readFileSync(
        path.join(import.meta.dirname, "..", "test", "e2e", "brev-e2e.test.js"),
        "utf-8",
      );
      expect(src).not.toContain("scripts/brev-setup.sh");
      expect(src).not.toContain("USE_LAUNCHABLE");
      expect(src).not.toContain("SKIP_VLLM=1");
    });

    it("bin/nemoclaw.js does not pipe curl to shell", () => {
      const src = fs.readFileSync(
        path.join(import.meta.dirname, "..", "bin", "nemoclaw.js"),
        "utf-8",
      );
      expect(findJsViolations(src)).toEqual([]);
    });
  });
});
