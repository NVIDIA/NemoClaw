const { execSync, spawnSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");

const ROOT = path.resolve(__dirname, "..", "..");

// --- platform.js excerpt ---
function runCapture(cmd, opts = {}) {
  try {
    return execSync(cmd, {
      encoding: "utf-8",
      cwd: ROOT,
      env: { ...process.env, ...opts.env },
      stdio: ["pipe", "pipe", "pipe"],
      ...opts,
    }).trim();
  } catch (err) {
    if (opts.ignoreError) return "";
    throw err;
  }
}

function detectDockerHost() {
  if (process.env.DOCKER_HOST) {
    return { name: "env", dockerHost: process.env.DOCKER_HOST };
  }
  try {
    const info = runCapture("docker info --format '{{json .}}'", { ignoreError: true });
    if (!info) return null;
    return { name: "docker", dockerHost: null }; // Should check if it returns valid JSON but ignore for now
  } catch {
    return null;
  }
}
// ---------------------------

const dockerHost = detectDockerHost();
if (dockerHost && dockerHost.dockerHost) {
  process.env.DOCKER_HOST = dockerHost.dockerHost;
  console.log('Set DOCKER_HOST:', process.env.DOCKER_HOST);
} else {
  console.log('No DOCKER_HOST override detected');
}

// Ensure the sandboxName is correct
const sandboxName = 'the-crucible';
console.log(`Checking sandbox existence via 'openshell sandbox get "${sandboxName}"'`);

try {
  const output = runCapture(`openshell sandbox get "${sandboxName}"`, {
    ignoreError: false,
  });
  console.log(`Command output length: ${output.length}`);
  console.log(`Success: true`);
} catch (e) {
  console.error("Sandbox check failed:", e.message);
  if (e.stderr) console.error("Stderr:", e.stderr.toString());
}
