// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// NIM container management — pull, start, stop, health-check NIM images.

const { run, runArgv, runCapture, runCaptureArgv, assertSafeName } = require("./runner");
const nimImages = require("./nim-images.json");

function containerName(sandboxName) {
  return `nemoclaw-nim-${sandboxName}`;
}

function getImageForModel(modelName) {
  const entry = nimImages.models.find((m) => m.name === modelName);
  return entry ? entry.image : null;
}

function listModels() {
  return nimImages.models.map((m) => ({
    name: m.name,
    image: m.image,
    minGpuMemoryMB: m.minGpuMemoryMB,
  }));
}

function detectGpu() {
  // Try NVIDIA first — query VRAM
  try {
    const output = runCapture(
      "nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits",
      { ignoreError: true }
    );
    if (output) {
      const lines = output.split("\n").filter((l) => l.trim());
      const perGpuMB = lines.map((l) => parseInt(l.trim(), 10)).filter((n) => !isNaN(n));
      if (perGpuMB.length > 0) {
        const totalMemoryMB = perGpuMB.reduce((a, b) => a + b, 0);
        return {
          type: "nvidia",
          count: perGpuMB.length,
          totalMemoryMB,
          perGpuMB: perGpuMB[0],
          nimCapable: true,
        };
      }
    }
  } catch {}

  // Fallback: DGX Spark (GB10) — VRAM not queryable due to unified memory architecture
  try {
    const nameOutput = runCapture(
      "nvidia-smi --query-gpu=name --format=csv,noheader,nounits",
      { ignoreError: true }
    );
    if (nameOutput && nameOutput.includes("GB10")) {
      // GB10 has 128GB unified memory shared with Grace CPU — use system RAM
      let totalMemoryMB = 0;
      try {
        const memLine = runCapture("free -m | awk '/Mem:/ {print $2}'", { ignoreError: true });
        if (memLine) totalMemoryMB = parseInt(memLine.trim(), 10) || 0;
      } catch {}
      return {
        type: "nvidia",
        count: 1,
        totalMemoryMB,
        perGpuMB: totalMemoryMB,
        nimCapable: true,
        spark: true,
      };
    }
  } catch {}

  // macOS: detect Apple Silicon or discrete GPU
  if (process.platform === "darwin") {
    try {
      const spOutput = runCapture(
        "system_profiler SPDisplaysDataType 2>/dev/null",
        { ignoreError: true }
      );
      if (spOutput) {
        const chipMatch = spOutput.match(/Chipset Model:\s*(.+)/);
        const vramMatch = spOutput.match(/VRAM.*?:\s*(\d+)\s*(MB|GB)/i);
        const coresMatch = spOutput.match(/Total Number of Cores:\s*(\d+)/);

        if (chipMatch) {
          const name = chipMatch[1].trim();
          let memoryMB = 0;

          if (vramMatch) {
            memoryMB = parseInt(vramMatch[1], 10);
            if (vramMatch[2].toUpperCase() === "GB") memoryMB *= 1024;
          } else {
            // Apple Silicon shares system RAM — read total memory
            try {
              const memBytes = runCapture("sysctl -n hw.memsize", { ignoreError: true });
              if (memBytes) memoryMB = Math.floor(parseInt(memBytes, 10) / 1024 / 1024);
            } catch {}
          }

          return {
            type: "apple",
            name,
            count: 1,
            cores: coresMatch ? parseInt(coresMatch[1], 10) : null,
            totalMemoryMB: memoryMB,
            perGpuMB: memoryMB,
            nimCapable: false,
          };
        }
      }
    } catch {}
  }

  return null;
}

function pullNimImage(model) {
  const image = getImageForModel(model);
  if (!image) {
    console.error(`  Unknown model: ${model}`);
    process.exit(1);
  }
  console.log(`  Pulling NIM image: ${image}`);
  runArgv("docker", ["pull", image]);
  return image;
}

function startNimContainer(sandboxName, model, port = 8000) {
  assertSafeName(sandboxName, "sandbox name");
  const name = containerName(sandboxName);
  const image = getImageForModel(model);
  if (!image) {
    console.error(`  Unknown model: ${model}`);
    process.exit(1);
  }

  // Stop any existing container with same name
  runArgv("docker", ["rm", "-f", name], { ignoreError: true });

  console.log(`  Starting NIM container: ${name}`);
  runArgv("docker", [
    "run", "-d",
    "--gpus", "all",
    "-p", `${port}:8000`,
    "--name", name,
    "--shm-size", "16g",
    image,
  ]);
  return name;
}

function waitForNimHealth(port = 8000, timeout = 300) {
  const start = Date.now();
  const interval = 5000;
  console.log(`  Waiting for NIM health on port ${port} (timeout: ${timeout}s)...`);

  while ((Date.now() - start) / 1000 < timeout) {
    try {
      const result = runCaptureArgv("curl", ["-sf", `http://localhost:${port}/v1/models`], {
        ignoreError: true,
      });
      if (result) {
        console.log("  NIM is healthy.");
        return true;
      }
    } catch {}
    // Synchronous sleep via spawnSync
    require("child_process").spawnSync("sleep", ["5"]);
  }
  console.error(`  NIM did not become healthy within ${timeout}s.`);
  return false;
}

function stopNimContainer(sandboxName) {
  const name = containerName(sandboxName);
  console.log(`  Stopping NIM container: ${name}`);
  runArgv("docker", ["stop", name], { ignoreError: true });
  runArgv("docker", ["rm", name], { ignoreError: true });
}

function nimStatus(sandboxName) {
  const name = containerName(sandboxName);
  try {
    const state = runCaptureArgv(
      "docker", ["inspect", "--format", "{{.State.Status}}", name],
      { ignoreError: true }
    );
    if (!state) return { running: false, container: name };

    let healthy = false;
    if (state.trim() === "running") {
      const health = runCaptureArgv("curl", ["-sf", "http://localhost:8000/v1/models"], {
        ignoreError: true,
      });
      healthy = !!health;
    }
    return { running: state.trim() === "running", healthy, container: name, state: state.trim() };
  } catch {
    return { running: false, container: name };
  }
}

module.exports = {
  containerName,
  getImageForModel,
  listModels,
  detectGpu,
  pullNimImage,
  startNimContainer,
  waitForNimHealth,
  stopNimContainer,
  nimStatus,
};
