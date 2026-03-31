// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

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
      return { status: 0 };
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
    expect(calls[0][2].stdio).toEqual(["ignore", "inherit", "inherit"]);
    expect(calls[1][2].stdio).toBe("inherit");
  });
});

describe("runner env merging", () => {
  it("preserves process env when opts.env is provided to runCapture", () => {
    const originalGateway = process.env.OPENSHELL_GATEWAY;
    process.env.OPENSHELL_GATEWAY = "nemoclaw";
    try {
      const output = runCapture("printf '%s %s' \"$OPENSHELL_GATEWAY\" \"$OPENAI_API_KEY\"", {
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
      return { status: 0 };
    };

    try {
      delete require.cache[require.resolve(runnerPath)];
      const { run } = require(runnerPath);
      process.env.PATH = "/usr/local/bin:/usr/bin";
      run("echo test", { env: { OPENSHELL_CLUSTER_IMAGE: "ghcr.io/nvidia/openshell/cluster:0.0.12" } });
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

describe("regression guards", () => {
  it("nemoclaw.js does not use execSync", () => {
    const src = fs.readFileSync(path.join(import.meta.dirname, "..", "bin", "nemoclaw.js"), "utf-8");
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
      const result = spawnSync("node", [
        path.join(import.meta.dirname, "..", "bin", "nemoclaw.js"),
        `test; touch ${canary}`,
        "connect",
      ], {
        encoding: "utf-8",
        timeout: 10000,
        cwd: path.join(import.meta.dirname, ".."),
      });
      expect(result.status).not.toBe(0);
      expect(fs.existsSync(canary)).toBe(false);
    } finally {
      fs.rmSync(canaryDir, { recursive: true, force: true });
    }
  });

  it("telegram bridge validates SANDBOX_NAME on startup", () => {
    const src = fs.readFileSync(path.join(import.meta.dirname, "..", "scripts", "telegram-bridge.js"), "utf-8");
    expect(src.includes("validateName(SANDBOX")).toBeTruthy();
    expect(src.includes("execSync")).toBeFalsy();
  });

  describe("credential exposure guards (#429)", () => {
    it("onboard createSandbox does not pass NVIDIA_API_KEY to sandbox env", () => {
      const fs = require("fs");
      const src = fs.readFileSync(path.join(import.meta.dirname, "..", "bin", "lib", "onboard.js"), "utf-8");
      // Find the envArgs block in createSandbox — it should not contain NVIDIA_API_KEY
      const envArgsMatch = src.match(/const envArgs = \[[\s\S]*?\];/);
      expect(envArgsMatch).toBeTruthy();
      expect(envArgsMatch[0].includes("NVIDIA_API_KEY")).toBe(false);
    });

    it("onboard clears NVIDIA_API_KEY from process.env after setupInference", () => {
      const fs = require("fs");
      const src = fs.readFileSync(path.join(import.meta.dirname, "..", "bin", "lib", "onboard.js"), "utf-8");
      expect(src.includes("delete process.env.NVIDIA_API_KEY")).toBeTruthy();
    });

    it("setup.sh uses env-name-only form for nvidia-nim credential", () => {
      const fs = require("fs");
      const src = fs.readFileSync(path.join(import.meta.dirname, "..", "scripts", "setup.sh"), "utf-8");
      // Should use "NVIDIA_API_KEY" (name only), not "NVIDIA_API_KEY=$NVIDIA_API_KEY" (value)
      const lines = src.split("\n");
      for (const line of lines) {
        if (line.includes("upsert_provider") || line.includes("--credential")) continue;
        if (line.trim().startsWith("#")) continue;
        // Check credential argument lines passed to upsert_provider
        if (line.includes('"NVIDIA_API_KEY=')) {
          // Allow "NVIDIA_API_KEY" alone but not "NVIDIA_API_KEY=$..."
          expect(line.includes("NVIDIA_API_KEY=$")).toBe(false);
        }
      }
    });

    it("setup.sh does not pass NVIDIA_API_KEY in sandbox create env args", () => {
      const fs = require("fs");
      const src = fs.readFileSync(path.join(import.meta.dirname, "..", "scripts", "setup.sh"), "utf-8");
      // Find sandbox create command — should not have env NVIDIA_API_KEY
      const createLines = src.split("\n").filter((l) => l.includes("sandbox create"));
      for (const line of createLines) {
        expect(line.includes("NVIDIA_API_KEY")).toBe(false);
      }
    });

    it("setupSpark does not pass NVIDIA_API_KEY to sudo", () => {
      const fs = require("fs");
      const src = fs.readFileSync(path.join(import.meta.dirname, "..", "bin", "nemoclaw.js"), "utf-8");
      // Find the run() call inside setupSpark — it should not contain the key
      const sparkLines = src.split("\n").filter(
        (l) => l.includes("setup-spark") && l.includes("run(")
      );
      for (const line of sparkLines) {
        expect(line.includes("NVIDIA_API_KEY")).toBe(false);
      }
    });

    it("walkthrough.sh does not embed NVIDIA_API_KEY in tmux or sandbox commands", () => {
      const fs = require("fs");
      const src = fs.readFileSync(path.join(import.meta.dirname, "..", "scripts", "walkthrough.sh"), "utf-8");
      // Check only executable lines (tmux spawn, openshell connect) — not comments/docs
      const cmdLines = src.split("\n").filter(
        (l) => !l.trim().startsWith("#") && !l.trim().startsWith("echo") &&
               (l.includes("tmux") || l.includes("openshell sandbox connect"))
      );
      for (const line of cmdLines) {
        expect(line.includes("NVIDIA_API_KEY")).toBe(false);
      }
    });

    it("install-openshell.sh verifies OpenShell binary checksum after download", () => {
      const src = fs.readFileSync(path.join(import.meta.dirname, "..", "scripts", "install-openshell.sh"), "utf-8");
      expect(src).toContain("openshell-checksums-sha256.txt");
      expect(src).toContain("shasum -a 256 -c");
    });
  });
});
