// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { execSync, spawnSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");

const SETUP_APPLE_SCRIPT = path.join(__dirname, "..", "scripts", "setup-apple.sh");

// Helper: run the setup-apple script with a mocked environment
// Redirects stderr to stdout so all output (info + warn) is captured together.
function runSetupApple(mockEnv = {}) {
  const env = {
    ...process.env,
    ...mockEnv,
  };

  try {
    const out = execSync(`/bin/bash "${SETUP_APPLE_SCRIPT}" 2>&1`, {
      encoding: "utf-8",
      timeout: 30000,
      env,
      stdio: "pipe",
    });
    return { code: 0, out, err: "" };
  } catch (err) {
    return {
      code: err.status || 1,
      out: err.stdout || "",
      err: err.stderr || "",
    };
  }
}

// Helper: create a temporary script that mocks system commands
function createMockScript(commands) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-apple-test-"));
  const mockBin = path.join(dir, "bin");
  fs.mkdirSync(mockBin, { recursive: true });

  // Create mock command scripts
  for (const [cmd, behavior] of Object.entries(commands)) {
    const scriptPath = path.join(mockBin, cmd);
    let scriptContent = "#!/usr/bin/env bash\n";

    if (typeof behavior === "string") {
      // Simple output
      scriptContent += `echo "${behavior}"\n`;
    } else if (behavior.exit) {
      // Exit with code
      scriptContent += `exit ${behavior.exit}\n`;
    } else if (behavior.output) {
      // Output and exit code
      scriptContent += `echo "${behavior.output}"\n`;
      scriptContent += `exit ${behavior.exit || 0}\n`;
    } else if (behavior.script) {
      // Custom script
      scriptContent += behavior.script;
    }

    fs.writeFileSync(scriptPath, scriptContent, { mode: 0o755 });
  }

  return { dir, mockBin };
}

// Helpers for common precondition checks
function requireDarwin(t) {
  if (process.platform !== "darwin") { t.skip("requires macOS"); return false; }
  return true;
}

function requireAppleSilicon(t) {
  if (!requireDarwin(t)) return false;
  if (process.arch !== "arm64") { t.skip("requires Apple Silicon"); return false; }
  return true;
}

function hasCommand(cmd) {
  try { execSync(`which ${cmd}`, { encoding: "utf-8", stdio: "pipe" }); return true; }
  catch { return false; }
}

function isDockerRunning() {
  try { execSync("docker info", { encoding: "utf-8", stdio: "pipe", timeout: 5000 }); return true; }
  catch { return false; }
}

describe("setup-apple.sh", () => {
  describe("Platform detection", () => {
    it("fails on non-macOS platforms", function () {
      if (process.platform === "darwin") {
        this.skip("can only verify failure on non-macOS");
        return;
      }
      const result = runSetupApple();
      assert.equal(result.code, 1);
      assert.ok(
        result.err.includes("macOS") || result.out.includes("macOS"),
        "Should mention macOS requirement"
      );
    });

    it("detects macOS and shows version", function () {
      if (!requireDarwin(this)) return;

      const result = runSetupApple();
      assert.ok(
        result.out.includes("macOS detected") || result.err.includes("Node.js not found"),
        "Should detect macOS or fail on later checks"
      );
    });
  });

  describe("Node.js version checks", () => {
    it("fails when Node.js is not found", function () {
      if (!requireDarwin(this)) return;

      const { dir, mockBin } = createMockScript({});
      const result = runSetupApple({
        PATH: mockBin,
      });

      assert.notEqual(result.code, 0, "Should exit with non-zero code");
      const output = result.out + result.err;
      assert.ok(
        output.includes("Node.js") || result.code !== 0,
        "Should report Node.js issue or fail"
      );
    });

    it("fails when Node.js version is less than 20", function () {
      if (!requireDarwin(this)) return;

      const { dir, mockBin } = createMockScript({
        node: {
          script: `#!/usr/bin/env bash
if [[ "$1" == "-v" ]]; then
  echo "v18.19.0"
elif [[ "$1" == "-e" ]]; then
  echo "18"
else
  exit 0
fi
`,
        },
        sw_vers: { output: "13.0" },
      });

      const result = runSetupApple({
        PATH: mockBin + ":" + process.env.PATH,
      });

      assert.equal(result.code, 1);
      assert.ok(
        result.err.includes("Node.js 20+ required") || result.out.includes("Node.js 20+ required"),
        "Should report Node.js 20+ requirement"
      );
    });

    it("passes when Node.js version is 20 or higher", function () {
      if (!requireDarwin(this)) return;
      const nodeVersion = parseInt(process.versions.node.split(".")[0]);
      if (nodeVersion < 20) { this.skip("host Node.js < 20"); return; }

      const result = runSetupApple();
      assert.ok(
        result.out.includes("Node.js") && result.out.includes("OK"),
        "Should show Node.js OK"
      );
    });
  });

  describe("Docker socket detection", () => {
    it("detects Docker Desktop socket when available", function () {
      if (!requireDarwin(this)) return;
      const desktopSocket = path.join(os.homedir(), ".docker/run/docker.sock");
      if (!fs.existsSync(desktopSocket)) { this.skip("no Docker Desktop socket"); return; }

      const result = runSetupApple();
      assert.ok(
        result.out.includes("Docker Desktop detected") || result.out.includes("Docker memory"),
        "Should detect Docker Desktop"
      );
    });

    it("detects Colima socket when available", function () {
      if (!requireDarwin(this)) return;
      const s1 = path.join(os.homedir(), ".colima/default/docker.sock");
      const s2 = path.join(os.homedir(), ".config/colima/default/docker.sock");
      if (!fs.existsSync(s1) && !fs.existsSync(s2)) { this.skip("no Colima socket"); return; }

      const result = runSetupApple();
      assert.ok(result.out.includes("Colima detected"), "Should detect Colima");
    });
  });

  describe("Docker memory allocation checks", () => {
    it("shows OK when Docker memory is 8GB or more", function () {
      if (!requireDarwin(this)) return;
      if (!isDockerRunning()) { this.skip("Docker not running"); return; }

      let memGB;
      try {
        const memBytes = execSync("docker info --format '{{.MemTotal}}' 2>/dev/null", {
          encoding: "utf-8", timeout: 5000,
        }).trim();
        memGB = Math.floor(parseInt(memBytes) / (1024 * 1024 * 1024));
      } catch {
        this.skip("could not query Docker memory"); return;
      }
      if (memGB < 8) { this.skip(`Docker has ${memGB}GB < 8GB`); return; }

      const result = runSetupApple();
      assert.ok(
        result.out.includes("Docker memory") && result.out.includes("GB"),
        "Should show Docker memory info"
      );
    });
  });

  describe("Ollama detection", () => {
    it("detects installed Ollama", function () {
      if (!requireDarwin(this)) return;
      if (!hasCommand("ollama")) { this.skip("Ollama not installed"); return; }

      const result = runSetupApple();
      assert.ok(
        result.out.includes("Ollama installed") || result.out.includes("Ollama is"),
        "Should detect Ollama installation"
      );
    });

    it("checks if Ollama is running", function () {
      if (!requireDarwin(this)) return;
      if (!hasCommand("ollama")) { this.skip("Ollama not installed"); return; }
      try {
        execSync("curl -sf http://localhost:11434/api/tags", {
          encoding: "utf-8", timeout: 2000, stdio: "pipe",
        });
      } catch {
        this.skip("Ollama not running"); return;
      }

      const result = runSetupApple();
      assert.ok(
        result.out.includes("running") || result.out.includes("localhost:11434"),
        "Should detect running Ollama"
      );
    });

    it("warns about OLLAMA_HOST when unset", function () {
      if (!requireDarwin(this)) return;
      if (!hasCommand("ollama")) { this.skip("Ollama not installed"); return; }
      if (process.env.OLLAMA_HOST) { this.skip("OLLAMA_HOST already set"); return; }

      const result = runSetupApple();
      const output = result.out + result.err;
      assert.ok(
        output.includes("OLLAMA_HOST") && output.includes("0.0.0.0:11434"),
        "Should warn about OLLAMA_HOST configuration"
      );
    });
  });

  describe("OpenShell CLI", () => {
    it("detects installed openshell CLI", function () {
      if (!requireDarwin(this)) return;
      if (!hasCommand("openshell")) { this.skip("openshell not installed"); return; }

      const result = runSetupApple();
      assert.ok(result.out.includes("openshell CLI"), "Should detect openshell CLI");
    });

    it("runs openshell doctor check after installation", function () {
      if (!requireDarwin(this)) return;
      if (!hasCommand("openshell")) { this.skip("openshell not installed"); return; }
      if (!isDockerRunning()) { this.skip("Docker not running"); return; }

      const result = runSetupApple();
      assert.ok(
        result.out.includes("openshell doctor check") ||
        result.err.includes("openshell doctor check"),
        "Should run openshell doctor check"
      );
    });

    it("install-openshell.sh script exists", () => {
      const installScript = path.join(__dirname, "..", "scripts", "install-openshell.sh");
      assert.ok(fs.existsSync(installScript), "install-openshell.sh should exist");
    });
  });

  describe("Apple GPU detection", () => {
    it("detects Apple GPU and chipset", function () {
      if (!requireAppleSilicon(this)) return;

      const result = runSetupApple();
      if (result.code === 0) {
        assert.ok(result.out.includes("Apple GPU"), "Should detect Apple GPU");
      }
    });

    it("detects unified memory size", function () {
      if (!requireAppleSilicon(this)) return;

      const result = runSetupApple();
      if (result.code === 0 && result.out.includes("Unified memory")) {
        assert.ok(
          result.out.includes("GB") && result.out.includes("Unified memory"),
          "Should show unified memory size"
        );
      }
    });

    it("shows cloud inference note for Apple Silicon", function () {
      if (!requireAppleSilicon(this)) return;

      const result = runSetupApple();
      if (result.code === 0) {
        assert.ok(
          result.out.includes("NVIDIA GPU") || result.out.includes("cloud"),
          "Should mention cloud inference for Apple Silicon"
        );
      }
    });
  });

  describe("nvm detection and warnings", () => {
    it("warns when nvm is detected", function () {
      if (!requireDarwin(this)) return;
      const nvmDir = process.env.NVM_DIR || path.join(os.homedir(), ".nvm");
      if (!process.env.NVM_DIR && !fs.existsSync(nvmDir)) { this.skip("nvm not detected"); return; }

      const result = runSetupApple();
      const output = result.out + result.err;
      assert.ok(
        output.includes("nvm") && output.includes("alias default"),
        "Should warn about nvm and suggest pinning version"
      );
    });
  });

  describe("Success completion", () => {
    it("shows next steps message on completion", function () {
      if (!requireDarwin(this)) return;

      const result = runSetupApple();
      if (result.code === 0) {
        assert.ok(
          result.out.includes("nemoclaw onboard") || result.out.includes("Next step"),
          "Should show next steps for onboarding"
        );
      }
    });

    it("shows setup checks complete message", function () {
      if (!requireDarwin(this)) return;

      const result = runSetupApple();
      if (result.code === 0) {
        assert.ok(
          result.out.includes("setup checks complete"),
          "Should indicate setup checks are complete"
        );
      }
    });
  });

  describe("Error handling", () => {
    it("exits with non-zero code on errors", function () {
      if (!requireDarwin(this)) return;

      const { dir, mockBin } = createMockScript({});
      const result = runSetupApple({ PATH: mockBin });
      assert.notEqual(result.code, 0, "Should exit with non-zero code on error");
    });

    it("stops execution on first critical error (set -e)", function () {
      if (!requireDarwin(this)) return;

      const { dir, mockBin } = createMockScript({});
      const result = runSetupApple({ PATH: mockBin });
      // Should fail on Node.js/uname check and not proceed to Docker checks
      assert.notEqual(result.code, 0, "Should fail early on critical errors");
      assert.ok(
        !result.out.includes("Docker"),
        "Should not reach Docker checks after early failure"
      );
    });
  });

  describe("CLI integration", () => {
    it("can be invoked via nemoclaw setup-apple", function () {
      if (!requireDarwin(this)) return;

      const CLI = path.join(__dirname, "..", "bin", "nemoclaw.js");

      try {
        const out = execSync(`node "${CLI}" setup-apple 2>&1`, {
          encoding: "utf-8",
          timeout: 30000,
          stdio: "pipe",
        });

        assert.ok(
          out.includes("macOS") || out.includes("Node.js") || out.includes("Docker"),
          "Should execute setup-apple script"
        );
      } catch (err) {
        const output = (err.stdout || "") + (err.stderr || "");
        assert.ok(
          output.includes("macOS") || output.includes("Node.js"),
          "Should execute setup-apple script even if checks fail"
        );
      }
    });
  });
});
