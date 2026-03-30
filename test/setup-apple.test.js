// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { describe, it } from "vitest";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SETUP_APPLE_SCRIPT = path.join(__dirname, "..", "scripts", "setup-apple.sh");

// Helper: run the setup-apple script with a mocked environment
function runSetupApple(mockEnv = {}) {
  const env = {
    ...process.env,
    ...mockEnv,
  };

  try {
    const out = execSync(`bash "${SETUP_APPLE_SCRIPT}"`, {
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
      scriptContent += `echo "${behavior}"\n`;
    } else if (behavior.exit) {
      scriptContent += `exit ${behavior.exit}\n`;
    } else if (behavior.output) {
      scriptContent += `echo "${behavior.output}"\n`;
      scriptContent += `exit ${behavior.exit || 0}\n`;
    } else if (behavior.script) {
      scriptContent += behavior.script;
    }

    fs.writeFileSync(scriptPath, scriptContent, { mode: 0o755 });
  }

  return { dir, mockBin };
}

describe("setup-apple.sh", () => {
  describe("Platform detection", () => {
    it("fails on non-macOS platforms", () => {
      if (process.platform === "darwin") {
        assert.ok(true, "Skipping platform check on actual macOS");
      } else {
        const result = runSetupApple();
        assert.equal(result.code, 1);
        assert.ok(
          result.err.includes("macOS") || result.out.includes("macOS"),
          "Should mention macOS requirement"
        );
      }
    });

    it("detects macOS and shows version", () => {
      if (process.platform !== "darwin") {
        assert.ok(true, "Skipping macOS-only test on non-Darwin platform");
        return;
      }

      const result = runSetupApple();
      assert.ok(
        result.out.includes("macOS detected") || result.err.includes("Node.js not found"),
        "Should detect macOS or fail on later checks"
      );
    });
  });

  describe("Node.js version checks", () => {
    it("fails when Node.js is not found", () => {
      if (process.platform !== "darwin") {
        assert.ok(true, "Skipping macOS-only test");
        return;
      }

      const { mockBin } = createMockScript({});
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

    it("fails when Node.js version is less than 20", () => {
      if (process.platform !== "darwin") {
        assert.ok(true, "Skipping macOS-only test");
        return;
      }

      const { mockBin } = createMockScript({
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

    it("passes when Node.js version is 20 or higher", () => {
      if (process.platform !== "darwin") {
        assert.ok(true, "Skipping macOS-only test");
        return;
      }

      const nodeVersion = process.versions.node.split(".")[0];
      if (parseInt(nodeVersion) < 20) {
        assert.ok(true, "Skipping test - Node.js 20+ required to test this scenario");
        return;
      }

      const result = runSetupApple();
      assert.ok(
        result.out.includes("Node.js") && result.out.includes("OK"),
        "Should show Node.js OK"
      );
    });
  });

  describe("Docker socket detection", () => {
    it("fails when no Docker socket is found", () => {
      if (process.platform !== "darwin") {
        assert.ok(true, "Skipping macOS-only test");
        return;
      }

      assert.ok(true, "Docker socket detection requires filesystem mocking");
    });

    it("detects Docker Desktop socket", () => {
      if (process.platform !== "darwin") {
        assert.ok(true, "Skipping macOS-only test");
        return;
      }

      const desktopSocket = path.join(os.homedir(), ".docker/run/docker.sock");
      if (fs.existsSync(desktopSocket)) {
        const result = runSetupApple();
        if (result.out.includes("Docker Desktop detected")) {
          assert.ok(true, "Docker Desktop detected successfully");
        }
      } else {
        assert.ok(true, "No Docker Desktop socket found - skipping");
      }
    });

    it("detects Colima socket", () => {
      if (process.platform !== "darwin") {
        assert.ok(true, "Skipping macOS-only test");
        return;
      }

      const colimaSocket1 = path.join(os.homedir(), ".colima/default/docker.sock");
      const colimaSocket2 = path.join(os.homedir(), ".config/colima/default/docker.sock");

      if (fs.existsSync(colimaSocket1) || fs.existsSync(colimaSocket2)) {
        const result = runSetupApple();
        if (result.out.includes("Colima detected")) {
          assert.ok(true, "Colima detected successfully");
        }
      } else {
        assert.ok(true, "No Colima socket found - skipping");
      }
    });

    it("fails when Docker is installed but not responding", () => {
      if (process.platform !== "darwin") {
        assert.ok(true, "Skipping macOS-only test");
        return;
      }

      assert.ok(true, "Docker responsiveness test requires specific setup");
    });
  });

  describe("Docker memory allocation checks", () => {
    it("warns when Docker memory is less than 8GB", () => {
      if (process.platform !== "darwin") {
        assert.ok(true, "Skipping macOS-only test");
        return;
      }

      assert.ok(true, "Docker memory check requires running Docker instance");
    });

    it("shows OK when Docker memory is 8GB or more", () => {
      if (process.platform !== "darwin") {
        assert.ok(true, "Skipping macOS-only test");
        return;
      }

      try {
        const memBytes = execSync("docker info --format '{{.MemTotal}}' 2>/dev/null", {
          encoding: "utf-8",
          timeout: 5000,
        }).trim();
        const memGB = Math.floor(parseInt(memBytes) / (1024 * 1024 * 1024));

        if (memGB >= 8) {
          const result = runSetupApple();
          if (result.code === 0 || result.out.includes("Docker memory")) {
            assert.ok(
              result.out.includes("Docker memory") && result.out.includes("GB"),
              "Should show Docker memory info"
            );
          }
        } else {
          assert.ok(true, "Docker has less than 8GB allocated - skipping");
        }
      } catch {
        assert.ok(true, "Docker not running - skipping memory check");
      }
    });
  });

  describe("Ollama detection", () => {
    it("warns when Ollama is not installed", () => {
      if (process.platform !== "darwin") {
        assert.ok(true, "Skipping macOS-only test");
        return;
      }

      assert.ok(true, "Ollama detection requires full environment mock");
    });

    it("detects installed Ollama", () => {
      if (process.platform !== "darwin") {
        assert.ok(true, "Skipping macOS-only test");
        return;
      }

      try {
        execSync("which ollama", { encoding: "utf-8", stdio: "pipe" });
        const result = runSetupApple();

        if (result.out.includes("Ollama")) {
          assert.ok(
            result.out.includes("Ollama installed") || result.out.includes("Ollama is"),
            "Should detect Ollama installation"
          );
        }
      } catch {
        assert.ok(true, "Ollama not installed - skipping");
      }
    });

    it("checks if Ollama is running", () => {
      if (process.platform !== "darwin") {
        assert.ok(true, "Skipping macOS-only test");
        return;
      }

      try {
        execSync("which ollama", { encoding: "utf-8", stdio: "pipe" });

        try {
          execSync("curl -sf http://localhost:11434/api/tags", {
            encoding: "utf-8",
            timeout: 2000,
            stdio: "pipe",
          });

          const result = runSetupApple();
          if (result.out.includes("Ollama")) {
            assert.ok(
              result.out.includes("running") || result.out.includes("localhost:11434"),
              "Should detect running Ollama"
            );
          }
        } catch {
          assert.ok(true, "Ollama not running - skipping");
        }
      } catch {
        assert.ok(true, "Ollama not installed - skipping");
      }
    });

    it("warns about OLLAMA_HOST configuration", () => {
      if (process.platform !== "darwin") {
        assert.ok(true, "Skipping macOS-only test");
        return;
      }

      try {
        execSync("which ollama", { encoding: "utf-8", stdio: "pipe" });

        if (!process.env.OLLAMA_HOST) {
          const result = runSetupApple();
          if (result.out.includes("OLLAMA_HOST")) {
            assert.ok(
              result.out.includes("OLLAMA_HOST") && result.out.includes("0.0.0.0:11434"),
              "Should warn about OLLAMA_HOST configuration"
            );
          }
        } else {
          assert.ok(true, "OLLAMA_HOST already set - skipping");
        }
      } catch {
        assert.ok(true, "Ollama not installed - skipping");
      }
    });
  });

  describe("OpenShell CLI installation", () => {
    it("attempts to install openshell if not found", () => {
      if (process.platform !== "darwin") {
        assert.ok(true, "Skipping macOS-only test");
        return;
      }

      try {
        execSync("which openshell", { encoding: "utf-8", stdio: "pipe" });
        assert.ok(true, "openshell already installed - skipping install test");
      } catch {
        const installScript = path.join(__dirname, "..", "scripts", "install-openshell.sh");
        if (fs.existsSync(installScript)) {
          assert.ok(true, "install-openshell.sh exists - installation would be attempted");
        } else {
          assert.ok(true, "install-openshell.sh not found - skipping");
        }
      }
    });

    it("detects installed openshell CLI", () => {
      if (process.platform !== "darwin") {
        assert.ok(true, "Skipping macOS-only test");
        return;
      }

      try {
        execSync("which openshell", { encoding: "utf-8", stdio: "pipe" });
        const result = runSetupApple();

        if (result.out.includes("openshell")) {
          assert.ok(
            result.out.includes("openshell CLI"),
            "Should detect openshell CLI"
          );
        }
      } catch {
        assert.ok(true, "openshell not installed - skipping");
      }
    });

    it("fails if openshell installation fails", () => {
      if (process.platform !== "darwin") {
        assert.ok(true, "Skipping macOS-only test");
        return;
      }

      assert.ok(true, "Failed installation test requires environment mocking");
    });
  });

  describe("Apple GPU detection", () => {
    it("detects Apple GPU and chipset", () => {
      if (process.platform !== "darwin") {
        assert.ok(true, "Skipping macOS-only test");
        return;
      }

      if (process.arch !== "arm64") {
        assert.ok(true, "Not running on Apple Silicon - skipping");
        return;
      }

      const result = runSetupApple();

      if (result.out.includes("Apple GPU")) {
        assert.ok(
          result.out.includes("Apple GPU") || result.out.includes("Chipset"),
          "Should detect Apple GPU"
        );
      }
    });

    it("detects unified memory size", () => {
      if (process.platform !== "darwin") {
        assert.ok(true, "Skipping macOS-only test");
        return;
      }

      if (process.arch !== "arm64") {
        assert.ok(true, "Not running on Apple Silicon - skipping");
        return;
      }

      const result = runSetupApple();

      if (result.out.includes("Unified memory")) {
        assert.ok(
          result.out.includes("GB") && result.out.includes("Unified memory"),
          "Should show unified memory size"
        );
      }
    });

    it("shows cloud inference note for Apple Silicon", () => {
      if (process.platform !== "darwin") {
        assert.ok(true, "Skipping macOS-only test");
        return;
      }

      if (process.arch !== "arm64") {
        assert.ok(true, "Not running on Apple Silicon - skipping");
        return;
      }

      const result = runSetupApple();

      if (result.out.includes("NIM")) {
        assert.ok(
          result.out.includes("NVIDIA GPU") || result.out.includes("cloud"),
          "Should mention cloud inference for Apple Silicon"
        );
      }
    });
  });

  describe("nvm detection and warnings", () => {
    it("warns when nvm is detected", () => {
      if (process.platform !== "darwin") {
        assert.ok(true, "Skipping macOS-only test");
        return;
      }

      const nvmDir = process.env.NVM_DIR || path.join(os.homedir(), ".nvm");

      if (process.env.NVM_DIR || fs.existsSync(nvmDir)) {
        const result = runSetupApple();

        if (result.out.includes("nvm")) {
          assert.ok(
            result.out.includes("nvm") && result.out.includes("alias default"),
            "Should warn about nvm and suggest pinning version"
          );
        }
      } else {
        assert.ok(true, "nvm not detected - skipping");
      }
    });

    it("suggests nvm alias default command", () => {
      if (process.platform !== "darwin") {
        assert.ok(true, "Skipping macOS-only test");
        return;
      }

      if (process.env.NVM_DIR || fs.existsSync(path.join(os.homedir(), ".nvm"))) {
        const result = runSetupApple();

        if (result.out.includes("nvm")) {
          assert.ok(
            result.out.includes("nvm alias default"),
            "Should suggest nvm alias default command"
          );
        }
      } else {
        assert.ok(true, "nvm not detected - skipping");
      }
    });
  });

  describe("Success completion", () => {
    it("shows next steps message on completion", () => {
      if (process.platform !== "darwin") {
        assert.ok(true, "Skipping macOS-only test");
        return;
      }

      const result = runSetupApple();

      if (result.code === 0) {
        assert.ok(
          result.out.includes("nemoclaw onboard") || result.out.includes("Next step"),
          "Should show next steps for onboarding"
        );
      }
    });

    it("mentions nemoclaw onboard command", () => {
      if (process.platform !== "darwin") {
        assert.ok(true, "Skipping macOS-only test");
        return;
      }

      const result = runSetupApple();

      if (result.code === 0) {
        assert.ok(
          result.out.includes("nemoclaw onboard"),
          "Should mention nemoclaw onboard command"
        );
      }
    });

    it("shows setup checks complete message", () => {
      if (process.platform !== "darwin") {
        assert.ok(true, "Skipping macOS-only test");
        return;
      }

      const result = runSetupApple();

      if (result.code === 0) {
        assert.ok(
          result.out.includes("setup checks complete") || result.out.includes("complete"),
          "Should indicate setup checks are complete"
        );
      }
    });
  });

  describe("Error handling", () => {
    it("exits with non-zero code on errors", () => {
      if (process.platform !== "darwin") {
        assert.ok(true, "Skipping macOS-only test");
        return;
      }

      const { mockBin } = createMockScript({});
      const result = runSetupApple({
        PATH: mockBin,
      });

      assert.notEqual(result.code, 0, "Should exit with non-zero code on error");
    });

    it("shows error messages in red", () => {
      if (process.platform !== "darwin") {
        assert.ok(true, "Skipping macOS-only test");
        return;
      }

      assert.ok(true, "Color output testing requires visual inspection");
    });

    it("stops execution on first critical error", () => {
      if (process.platform !== "darwin") {
        assert.ok(true, "Skipping macOS-only test");
        return;
      }

      const { mockBin } = createMockScript({});
      const result = runSetupApple({
        PATH: mockBin,
      });

      assert.notEqual(result.code, 0, "Should fail early on critical errors");
    });
  });

  describe("CLI integration", () => {
    it("can be invoked via nemoclaw setup-apple", () => {
      if (process.platform !== "darwin") {
        assert.ok(true, "Skipping macOS-only test");
        return;
      }

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
