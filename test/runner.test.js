// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const childProcess = require("node:child_process");
const { spawnSync } = childProcess;

const runnerPath = path.join(__dirname, "..", "bin", "lib", "runner");

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
      cwd: path.join(__dirname, ".."),
      encoding: "utf-8",
      input: "preserved-answer\n",
    });

    assert.equal(result.status, 0);
    assert.equal(result.stdout, "preserved-answer\n");
  });

  it("uses inherited stdio for interactive commands only", () => {
    const calls = [];
    const originalSpawnSync = childProcess.spawnSync;
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

    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0][2].stdio, ["ignore", "inherit", "inherit"]);
    assert.equal(calls[1][2].stdio, "inherit");
  });

  it("preserves process env when opts.env is provided", () => {
    const calls = [];
    const originalSpawnSync = childProcess.spawnSync;
    const originalPath = process.env.PATH;
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

    assert.equal(calls.length, 1);
    assert.equal(calls[0][2].env.OPENSHELL_CLUSTER_IMAGE, "ghcr.io/nvidia/openshell/cluster:0.0.12");
    assert.equal(calls[0][2].env.PATH, "/usr/local/bin:/usr/bin");
  });

  describe("shellQuote", () => {
    it("wraps in single quotes", () => {
      const { shellQuote } = require(runnerPath);
      assert.equal(shellQuote("hello"), "'hello'");
    });

    it("escapes embedded single quotes", () => {
      const { shellQuote } = require(runnerPath);
      assert.equal(shellQuote("it's"), "'it'\\''s'");
    });

    it("neutralizes shell metacharacters", () => {
      const { shellQuote } = require(runnerPath);
      const dangerous = "test; rm -rf /";
      const quoted = shellQuote(dangerous);
      assert.equal(quoted, "'test; rm -rf /'");
      const result = spawnSync("bash", ["-c", `echo ${quoted}`], { encoding: "utf-8" });
      assert.equal(result.stdout.trim(), dangerous);
    });

    it("handles backticks and dollar signs", () => {
      const { shellQuote } = require(runnerPath);
      const payload = "test`whoami`$HOME";
      const quoted = shellQuote(payload);
      const result = spawnSync("bash", ["-c", `echo ${quoted}`], { encoding: "utf-8" });
      assert.equal(result.stdout.trim(), payload);
    });
  });

  describe("validateName", () => {
    it("accepts valid RFC 1123 names", () => {
      const { validateName } = require(runnerPath);
      assert.equal(validateName("my-sandbox"), "my-sandbox");
      assert.equal(validateName("test123"), "test123");
      assert.equal(validateName("a"), "a");
    });

    it("rejects names with shell metacharacters", () => {
      const { validateName } = require(runnerPath);
      assert.throws(() => validateName("test; whoami"), /Invalid/);
      assert.throws(() => validateName("test`id`"), /Invalid/);
      assert.throws(() => validateName("test$(cat /etc/passwd)"), /Invalid/);
      assert.throws(() => validateName("../etc/passwd"), /Invalid/);
    });

    it("rejects empty and overlength names", () => {
      const { validateName } = require(runnerPath);
      assert.throws(() => validateName(""), /required/);
      assert.throws(() => validateName(null), /required/);
      assert.throws(() => validateName("a".repeat(64)), /too long/);
    });

    it("rejects uppercase and special characters", () => {
      const { validateName } = require(runnerPath);
      assert.throws(() => validateName("MyBox"), /Invalid/);
      assert.throws(() => validateName("my_box"), /Invalid/);
      assert.throws(() => validateName("-leading"), /Invalid/);
      assert.throws(() => validateName("trailing-"), /Invalid/);
    });
  });

  describe("regression guards", () => {
    it("nemoclaw.js does not use execSync", () => {
      const fs = require("fs");
      const src = fs.readFileSync(path.join(__dirname, "..", "bin", "nemoclaw.js"), "utf-8");
      const lines = src.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes("execSync") && !lines[i].includes("execFileSync")) {
          assert.fail(`bin/nemoclaw.js:${i + 1} uses execSync — use execFileSync instead`);
        }
      }
    });

    it("no duplicate shellQuote definitions in bin/", () => {
      const fs = require("fs");
      const binDir = path.join(__dirname, "..", "bin");
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
      assert.equal(defs.length, 1, `Expected 1 shellQuote definition, found ${defs.length}: ${defs.join(", ")}`);
      assert.ok(defs[0].includes("runner"), `shellQuote should be in runner.js, found in ${defs[0]}`);
    });

    it("CLI rejects malicious sandbox names before shell commands (e2e)", () => {
      const fs = require("fs");
      const os = require("os");
      const canaryDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-canary-"));
      const canary = path.join(canaryDir, "executed");
      try {
        const result = spawnSync("node", [
          path.join(__dirname, "..", "bin", "nemoclaw.js"),
          `test; touch ${canary}`,
          "connect",
        ], {
          encoding: "utf-8",
          timeout: 10000,
          cwd: path.join(__dirname, ".."),
        });
        assert.notEqual(result.status, 0, "CLI should reject malicious sandbox name");
        assert.equal(fs.existsSync(canary), false, "shell payload must never execute");
      } finally {
        fs.rmSync(canaryDir, { recursive: true, force: true });
      }
    });

    it("bridge-core validates SANDBOX_NAME on startup", () => {
      const fs = require("fs");
      const src = fs.readFileSync(path.join(__dirname, "..", "scripts", "bridge-core.js"), "utf-8");
      assert.ok(src.includes("validateName(SANDBOX"), "bridge-core.js must validate SANDBOX_NAME");
      assert.ok(!src.includes("execSync"), "bridge-core.js should not use execSync");
    });

    it("bridge runner uses bridge-core for sandbox relay", () => {
      const fs = require("fs");
      const src = fs.readFileSync(path.join(__dirname, "..", "scripts", "bridge.js"), "utf-8");
      assert.ok(src.includes("require(\"./bridge-core\")"), "bridge.js must use bridge-core");
      assert.ok(src.includes("runAgentInSandbox"), "bridge.js must use runAgentInSandbox");
    });

    it("each messaging adapter exists and exports a function", () => {
      const fs = require("fs");
      const adaptersDir = path.join(__dirname, "..", "scripts", "adapters", "messaging");
      for (const name of ["telegram", "discord", "slack"]) {
        const adapterPath = path.join(adaptersDir, `${name}.js`);
        assert.ok(fs.existsSync(adapterPath), `adapter ${name}.js must exist`);
        const src = fs.readFileSync(adapterPath, "utf-8");
        assert.ok(src.includes("module.exports"), `${name}.js must export a function`);
      }
    });

    it("blueprint.yaml defines bridge configs for all messaging platforms", () => {
      const fs = require("fs");
      const yaml = require("js-yaml");
      const bp = yaml.load(fs.readFileSync(path.join(__dirname, "..", "nemoclaw-blueprint", "blueprint.yaml"), "utf-8"));
      const bridges = bp.components.bridges;
      for (const name of ["telegram", "discord", "slack"]) {
        assert.ok(bridges[name], `blueprint must define ${name} bridge`);
        assert.ok(bridges[name].credential_env, `${name} bridge must specify credential_env`);
        assert.ok(bridges[name].session_prefix, `${name} bridge must specify session_prefix`);
        assert.ok(bridges[name].adapter, `${name} bridge must specify adapter`);
      }
    });

    it("blueprint bridge configs use credential_env naming consistent with inference profiles", () => {
      const fs = require("fs");
      const yaml = require("js-yaml");
      const bp = yaml.load(fs.readFileSync(path.join(__dirname, "..", "nemoclaw-blueprint", "blueprint.yaml"), "utf-8"));
      const bridges = bp.components.bridges;
      // Verify field naming matches inference profile convention (credential_env, not token_env)
      for (const [name, config] of Object.entries(bridges)) {
        assert.ok(!config.token_env, `${name} bridge should use credential_env, not token_env`);
        assert.equal(typeof config.credential_env, "string", `${name} bridge credential_env must be a string`);
      }
    });

    it("slack bridge config lists SLACK_APP_TOKEN in extra_credential_env", () => {
      const fs = require("fs");
      const yaml = require("js-yaml");
      const bp = yaml.load(fs.readFileSync(path.join(__dirname, "..", "nemoclaw-blueprint", "blueprint.yaml"), "utf-8"));
      const slack = bp.components.bridges.slack;
      assert.ok(Array.isArray(slack.extra_credential_env), "slack must have extra_credential_env array");
      assert.ok(slack.extra_credential_env.includes("SLACK_APP_TOKEN"), "slack must require SLACK_APP_TOKEN");
    });

    it("telegram-bridge.js backwards-compat wrapper delegates to bridge.js", () => {
      const fs = require("fs");
      const src = fs.readFileSync(path.join(__dirname, "..", "scripts", "telegram-bridge.js"), "utf-8");
      assert.ok(src.includes("require(\"./bridge\")"), "telegram-bridge.js must delegate to bridge.js");
      assert.ok(src.includes("telegram"), "telegram-bridge.js must inject 'telegram' arg");
    });

    it("bridge.js loads configs from blueprint.yaml, not separate files", () => {
      const fs = require("fs");
      const src = fs.readFileSync(path.join(__dirname, "..", "scripts", "bridge.js"), "utf-8");
      assert.ok(src.includes("blueprint.yaml"), "bridge.js must reference blueprint.yaml");
      assert.ok(!src.includes("bridges/messaging"), "bridge.js must not reference separate bridge files");
    });

    it("bridge.js logs metadata only, never raw message content", () => {
      const fs = require("fs");
      const src = fs.readFileSync(path.join(__dirname, "..", "scripts", "bridge.js"), "utf-8");
      // Ensure log lines use length, not content
      assert.ok(src.includes("inbound (len="), "bridge.js must log message length, not content");
      assert.ok(src.includes("response (len="), "bridge.js must log response length, not content");
      // Ensure console.log calls never interpolate raw msg.text (length is ok)
      const logLines = src.split("\n").filter((l) => l.includes("console.log"));
      for (const line of logLines) {
        const hasRawText = line.includes("msg.text}") || line.includes("msg.text,") || line.includes("msg.text)");
        assert.ok(!hasRawText, `log line must not include raw text: ${line.trim()}`);
      }
    });

    it("onboard auto-starts bridges when messaging tokens detected", () => {
      const fs = require("fs");
      const src = fs.readFileSync(path.join(__dirname, "..", "bin", "lib", "onboard.js"), "utf-8");
      assert.ok(src.includes("startMessagingBridges"), "onboard must call startMessagingBridges");
      assert.ok(src.includes("start-services.sh"), "startMessagingBridges must delegate to start-services.sh");
      assert.ok(src.includes("RISKY CHANGE"), "auto-start must be annotated as risky migration");
    });

    it("onboard passes all four credential types via getCredential pattern", () => {
      const fs = require("fs");
      const src = fs.readFileSync(path.join(__dirname, "..", "bin", "lib", "onboard.js"), "utf-8");
      for (const token of ["NVIDIA_API_KEY", "DISCORD_BOT_TOKEN", "SLACK_BOT_TOKEN", "TELEGRAM_BOT_TOKEN"]) {
        assert.ok(src.includes(`getCredential("${token}")`), `onboard must use getCredential for ${token}`);
      }
    });
  });
});
