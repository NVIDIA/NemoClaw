// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";

const START_SCRIPT = path.join(import.meta.dirname, "..", "scripts", "nemoclaw-start.sh");

describe("nemoclaw-start non-root fallback", () => {
  it("detaches gateway output from sandbox create in non-root mode", () => {
    const src = fs.readFileSync(START_SCRIPT, "utf-8");

    expect(src).toMatch(/if \[ "\$\(id -u\)" -ne 0 \]; then/);
    expect(src).toMatch(/touch \/tmp\/gateway\.log/);
    expect(src).toMatch(/nohup "\$OPENCLAW" gateway run >\/tmp\/gateway\.log 2>&1 &/);
  });

  it("generates a runtime config and launches the gateway with OPENCLAW_CONFIG_PATH", () => {
    const src = fs.readFileSync(START_SCRIPT, "utf-8");

    expect(src).toMatch(/RUNTIME_CONFIG_DIR="\/tmp\/nemoclaw"/);
    expect(src).toMatch(/RUNTIME_CONFIG_PATH="\$\{RUNTIME_CONFIG_DIR\}\/openclaw\.json"/);
    expect(src).toMatch(/prepare_runtime_config/);
    expect(src).toMatch(/export OPENCLAW_CONFIG_PATH="\$RUNTIME_CONFIG_PATH"/);
    expect(src).toMatch(
      /gosu gateway env OPENCLAW_CONFIG_PATH="\$OPENCLAW_CONFIG_PATH" "\$OPENCLAW" gateway run/,
    );
  });

  it("merges persisted agent overlays into the runtime config", () => {
    const src = fs.readFileSync(START_SCRIPT, "utf-8");

    expect(src).toMatch(/PERSISTENT_AGENTS_PATH="\/sandbox\/\.nemoclaw\/agents-overlay\.json"/);
    expect(src).toMatch(/overlay_path = '\/sandbox\/\.nemoclaw\/agents-overlay\.json'/);
    expect(src).toMatch(/def sanitize_subagents\(subagents\):/);
    expect(src).toMatch(/if not workspace and not agent_dir and not sanitized_subagents:/);
    expect(src).toMatch(/def merge_agent_entries\(base_agent, overlay_agent\):/);
    expect(src).toMatch(/def merge_agent_lists\(base_agents, overlay_agents\):/);
    expect(src).toMatch(/def load_overlay_agents\(overlay_path\):/);
    expect(src).toMatch(/def ensure_primary_agent_config\(cfg\):/);
    expect(src).toMatch(/defaults_cfg\['workspace'\] = default_workspace/);
    expect(src).toMatch(/'id': 'main'/);
    expect(src).toMatch(/'agentDir': '\/sandbox\/.openclaw\/agents\/main\/agent'/);
    expect(src).toMatch(
      /agents_cfg\['list'\] = merge_agent_lists\(\[main_entry\], existing_agents\)/,
    );
    expect(src).toMatch(
      /merged\[positions\[agent_id\]\] = merge_agent_entries\(merged\[positions\[agent_id\]\], agent\)/,
    );
    expect(src).toMatch(/overlay_agents = load_overlay_agents\(overlay_path\)/);
    expect(src).toMatch(
      /cfg_agents\['list'\] = merge_agent_lists\(existing_agents, overlay_agents\)/,
    );
    expect(src).toMatch(/ensure_primary_agent_config\(cfg\)/);
    expect(src).toMatch(
      /if os\.path\.exists\(selection_path\):[\s\S]*with open\(runtime_path, 'w'\) as f:[\s\S]*else:[\s\S]*with open\(runtime_path, 'w'\) as f:/,
    );
  });
});
