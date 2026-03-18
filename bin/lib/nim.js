// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// NIM container management — pull, start, stop, health-check NIM images.

const { run, runCapture } = require("./runner");
const nimImages = require("./nim-images.json");

/** @param {string} sandboxName @returns {string} Docker container name. */
function containerName(sandboxName) {
  return `nemoclaw-nim-${sandboxName}`;
}

/** @param {string} modelName @returns {string|null} NIM container image or null. */
function getImageForModel(modelName) {
  const entry = nimImages.models.find((m) => m.name === modelName);
  return entry ? entry.image : null;
}

/** @returns {Array<{name: string, image: string, minGpuMemoryMB: number}>} */
function listModels() {
  return nimImages.models.map((m) => ({
    name: m.name,
    image: m.image,
    minGpuMemoryMB: m.minGpuMemoryMB,
  }));
}

/**
 * Detect GPU hardware. Returns an object describing the GPU (type, count,
 * memory, capabilities) or null if no GPU is found.
 * @param {object} [opts] - Optional overrides for dependency injection.
 * @param {Function} [opts.runCapture] - Command runner (default: runner.runCapture).
 * @param {string} [opts.platform] - OS platform (default: process.platform).
 * @returns {{ type: string, count: number, totalMemoryMB: number, perGpuMB: number, nimCapable: boolean, spark?: boolean, name?: string, cores?: number } | null}
 */
function detectGpu(opts) {
  const runCmd = (opts && opts.runCapture) || runCapture;
  const platform = (opts && opts.platform) || process.platform;

  // Try NVIDIA first — query VRAM
  try {
    const output = runCmd(
      "nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits",
      { ignoreError: true }
    );
    if (output) {
      const lines = output.split("\n").filter((l) => l.trim());
      const perGpuMB = lines.map((l) => parseInt(l.trim(), 10)).filter((n) => !isNaN(n));
      if (perGpuMB.length > 0) {
        const totalMemoryMB = perGpuMB.reduce((a, b) => a + b, 0);
        // Query GPU name for display
        let name;
        try {
          name = runCmd(
            "nvidia-smi --query-gpu=name --format=csv,noheader,nounits",
            { ignoreError: true }
          );
          if (name) name = name.split("\n")[0].trim();
        } catch {}
        return {
          type: "nvidia",
          name,
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
    const nameOutput = runCmd(
      "nvidia-smi --query-gpu=name --format=csv,noheader,nounits",
      { ignoreError: true }
    );
    if (nameOutput && nameOutput.includes("GB10")) {
      // GB10 has 128GB unified memory shared with Grace CPU — use system RAM
      let totalMemoryMB = 0;
      try {
        const memLine = runCmd("free -m | awk '/Mem:/ {print $2}'", { ignoreError: true });
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
  if (platform === "darwin") {
    try {
      const spOutput = runCmd(
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
              const memBytes = runCmd("sysctl -n hw.memsize", { ignoreError: true });
              if (memBytes) memoryMB = Math.floor(parseInt(memBytes, 10) / 1024 / 1024);
            } catch {}
          }

          return {
            type: "apple",
            name,
            count: 1,
            ...(coresMatch ? { cores: parseInt(coresMatch[1], 10) } : {}),
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

/** @param {string} model - Model name to pull. @returns {string} Image tag. */
/**
 * Suggest NIM models ranked by fit for a given GPU.
 * Returns models sorted by VRAM requirement (descending), with the largest
 * model that uses <=90% of available VRAM marked as recommended.
 * @param {{ totalMemoryMB: number, nimCapable: boolean } | null} gpu
 * @returns {Array<{ name: string, image: string, minGpuMemoryMB: number, recommended: boolean }>}
 */
function suggestModelsForGpu(gpu) {
  if (!gpu || !gpu.nimCapable) return [];
  const vram = gpu.totalMemoryMB;
  const fits = listModels()
    .filter((m) => m.minGpuMemoryMB <= vram)
    .sort((a, b) => b.minGpuMemoryMB - a.minGpuMemoryMB);

  const threshold = vram * 0.9;
  let recommended = false;
  return fits.map((m) => {
    const rec = !recommended && m.minGpuMemoryMB <= threshold;
    if (rec) recommended = true;
    return { ...m, recommended: rec };
  });
}

function pullNimImage(model) {
  const image = getImageForModel(model);
  if (!image) {
    console.error(`  Unknown model: ${model}`);
    process.exit(1);
  }
  console.log(`  Pulling NIM image: ${image}`);
  run(`docker pull ${image}`);
  return image;
}

/** @param {string} sandboxName @param {string} model @param {number} [port=8000] @returns {string} Container name. */
function startNimContainer(sandboxName, model, port = 8000) {
  const name = containerName(sandboxName);
  const image = getImageForModel(model);
  if (!image) {
    console.error(`  Unknown model: ${model}`);
    process.exit(1);
  }

  // Stop any existing container with same name
  run(`docker rm -f ${name} 2>/dev/null || true`, { ignoreError: true });

  console.log(`  Starting NIM container: ${name}`);
  run(
    `docker run -d --gpus all -p ${port}:8000 --name ${name} --shm-size 16g ${image}`
  );
  return name;
}

/** @param {number} [port=8000] @param {number} [timeout=300] @returns {boolean} True if healthy. */
function waitForNimHealth(port = 8000, timeout = 300) {
  const start = Date.now();
  const interval = 5000;
  console.log(`  Waiting for NIM health on port ${port} (timeout: ${timeout}s)...`);

  while ((Date.now() - start) / 1000 < timeout) {
    try {
      const result = runCapture(`curl -sf http://localhost:${port}/v1/models`, {
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

/** @param {string} sandboxName - Stop and remove the NIM container. */
function stopNimContainer(sandboxName) {
  const name = containerName(sandboxName);
  console.log(`  Stopping NIM container: ${name}`);
  run(`docker stop ${name} 2>/dev/null || true`, { ignoreError: true });
  run(`docker rm ${name} 2>/dev/null || true`, { ignoreError: true });
}

/** @param {string} sandboxName @returns {{running: boolean, healthy?: boolean, container: string, state?: string}} */
function nimStatus(sandboxName) {
  const name = containerName(sandboxName);
  try {
    const state = runCapture(
      `docker inspect --format '{{.State.Status}}' ${name} 2>/dev/null`,
      { ignoreError: true }
    );
    if (!state) return { running: false, container: name };

    let healthy = false;
    if (state === "running") {
      const health = runCapture(`curl -sf http://localhost:8000/v1/models 2>/dev/null`, {
        ignoreError: true,
      });
      healthy = !!health;
    }
    return { running: state === "running", healthy, container: name, state };
  } catch {
    return { running: false, container: name };
  }
}

module.exports = {
  containerName,
  getImageForModel,
  listModels,
  detectGpu,
  suggestModelsForGpu,
  pullNimImage,
  startNimContainer,
  waitForNimHealth,
  stopNimContainer,
  nimStatus,
};
