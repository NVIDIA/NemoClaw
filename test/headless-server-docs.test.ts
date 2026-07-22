// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { renderAgentVariantPage } from "../scripts/sync-agent-variant-docs.mts";
import { DEFAULT_INSTALL_REF } from "../src/lib/domain/installer/ref";

const repoRoot = path.join(import.meta.dirname, "..");
const guidePath = path.join(repoRoot, "docs", "deployment", "deploy-to-headless-server.mdx");
const guide = fs.readFileSync(guidePath, "utf-8");
const overview = fs.readFileSync(path.join(repoRoot, "docs", "about", "overview.mdx"), "utf-8");
const commands = fs.readFileSync(path.join(repoRoot, "docs", "reference", "commands.mdx"), "utf-8");
const openclawGuide = renderAgentVariantPage(guide, "openclaw", { sourcePath: guidePath });
const hermesGuide = renderAgentVariantPage(guide, "hermes", { sourcePath: guidePath });
const deepAgentsGuide = renderAgentVariantPage(guide, "deepagents", { sourcePath: guidePath });

describe("headless server deployment guide contracts", () => {
  it("keeps unattended onboarding aligned with the maintained installer default (#7180)", () => {
    expect(DEFAULT_INSTALL_REF).toBe("lkg");
    expect(guide).toContain("maintained last-known-good `lkg` reference");
    expect(guide).toContain("NEMOCLAW_NON_INTERACTIVE=1");
    expect(guide).toContain("NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1");
    expect(guide).toContain('NEMOCLAW_AGENT="$NEMOCLAW_AGENT"');
    expect(guide).toContain('NEMOCLAW_PROVIDER="$NEMOCLAW_PROVIDER"');
    expect(guide).toContain('NVIDIA_INFERENCE_API_KEY="$NVIDIA_INFERENCE_API_KEY"');
    expect(guide).toContain('NEMOCLAW_SANDBOX_NAME="$NEMOCLAW_SANDBOX_NAME"');
  });

  it("keeps the supported noninteractive policy and skill commands copyable (#7180)", () => {
    expect(guide).toContain(
      "$$nemoclaw headless-agent policy-add --from-file ./presets/internal-status.yaml --yes",
    );
    expect(guide).toContain("$$nemoclaw headless-agent skill install ./my-skill/");
  });

  it("separates tmux and screen session creation from later reattachment (#7180)", () => {
    expect(guide).toContain("tmux new-session -s nemoclaw-onboard\n```");
    expect(guide).toContain("tmux attach-session -t nemoclaw-onboard\n```");
    expect(guide).toContain("screen -S nemoclaw-onboard\n```");
    expect(guide).toContain("screen -r nemoclaw-onboard\n```");
    expect(guide).not.toContain(
      "tmux new-session -s nemoclaw-onboard\ntmux attach-session -t nemoclaw-onboard",
    );
  });

  it("uses authoritative readiness and manual reboot recovery signals (#7180)", () => {
    expect(guide).toContain("openshell sandbox list");
    expect(guide).toContain("The substring `NotReady` is not a ready state.");
    expect(guide).toContain("$$nemoclaw headless-agent connect --probe-only");
    expect(guide).toContain("$$nemoclaw headless-agent status");
    expect(guide).toContain("$$nemoclaw headless-agent start");
    expect(guide).toContain("does not guarantee");
  });

  it("retrieves dashboard and API secrets through supported commands (#7180)", () => {
    expect(guide).toContain("$$nemoclaw headless-agent dashboard-url --quiet");
    expect(guide).toContain("TOKEN=$($$nemoclaw headless-agent gateway-token --quiet)");
    expect(guide).toContain('curl -fsS -H "Authorization: Bearer $TOKEN"');
    expect(guide.match(/unset TOKEN/gu)).toHaveLength(2);
  });

  it("keeps dashboard access and token lifecycles specific to each agent (#7180)", () => {
    expect(openclawGuide).toContain("OpenClaw generates a new gateway token each time");
    expect(openclawGuide).toContain(
      "| OpenClaw gateway token | Rotated when the container starts |",
    );
    expect(openclawGuide).not.toContain("Hermes preserves its `API_SERVER_KEY`");

    expect(hermesGuide).toContain(
      "Hermes preserves its `API_SERVER_KEY` when the same sandbox container restarts.",
    );
    expect(hermesGuide).toContain("| Hermes `API_SERVER_KEY` | Preserved |");
    expect(hermesGuide).not.toContain("OpenClaw generates a new gateway token each time");

    expect(deepAgentsGuide).not.toContain("### Dashboard or Token Retrieval Fails");
    expect(deepAgentsGuide).not.toContain("OpenClaw gateway token | Rotated");
    expect(deepAgentsGuide).not.toContain("Hermes `API_SERVER_KEY` | Preserved");
  });

  it("documents rebuild survival and arbitrary environment boundaries (#7180)", () => {
    expect(guide).toContain(
      "| Item | Same-container restart | Snapshot and restore | Rebuild or sandbox upgrade |",
    );
    expect(guide).toContain("| Custom preset YAML applied with `policy-add` |");
    expect(guide).toContain("| Arbitrary files outside manifest state |");
    expect(guide).toContain("| Manually installed system or global packages |");
    expect(guide).toContain("| Direct edits to generated profile, config, or environment files |");
    expect(guide).toContain("| Host tunnel process |");
  });

  it("does not retain the retired Brev-specific deployment flow (#7180)", () => {
    expect(guide).not.toContain("Brev");
    expect(overview).toContain("| Headless server deployment |");
    expect(overview).not.toContain("| Remote GPU deployment |");
    expect(commands).toContain("### Deprecated Brev Deployment");
    expect(commands).not.toContain("onboard --remote");
    expect(commands).not.toContain("For a remote Brev instance");
    expect(
      fs.existsSync(path.join(repoRoot, "docs", "deployment", "deploy-to-remote-gpu.mdx")),
    ).toBe(false);
    expect(fs.existsSync(path.join(repoRoot, "docs", "deployment", "brev-web-ui.mdx"))).toBe(false);
  });
});
