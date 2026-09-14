// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import { help as renderRootHelp } from "../../src/lib/actions/root-help";

describe("root help", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("describes mutable agent config and durable host-side settings", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    renderRootHelp();

    const output = log.mock.calls.map(([line]) => String(line)).join("\n");
    expect(output).toContain("Agent config is writable in the default sandbox");
    expect(output).toContain("Use host-side commands or re-run onboard");
    expect(output).not.toContain("Agent config is read-only inside the sandbox");
    expect(output).not.toContain("Landlock enforced");
  });

  it("explains global commands versus sandbox-scoped commands", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    renderRootHelp();

    const output = log.mock.calls.map(([line]) => String(line)).join("\n");
    expect(output).toContain("Global commands run without a sandbox-name prefix");
    expect(output).toContain("sandbox commands start with a sandbox name");
    expect(output).toContain("nemoclaw status");
    expect(output).toContain("nemoclaw <name> status");
    expect(output).toContain("nemoclaw doctor");
    expect(output).toContain("nemoclaw <name> doctor");
  });

  it("describes onboard agent selection and the global agent runtime list", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    renderRootHelp();

    const output = log.mock.calls.map(([line]) => String(line)).join("\n");
    expect(output).toContain("nemoclaw onboard");
    expect(output).toContain(
      "Configure inference endpoint and credentials (--agent to choose runtime)",
    );
    expect(output).toContain("nemoclaw agents list");
    expect(output).toContain("List available agent runtimes for onboard --agent");
  });

  it.each(["add", "remove", "start", "stop"])(
    "shows channel as a required positional argument in channel command signatures [%s]",
    (action) => {
      const log = vi.spyOn(console, "log").mockImplementation(() => {});

      renderRootHelp();

      const output = log.mock.calls.map(([line]) => String(line)).join("\n");

      expect(output).toContain(`nemoclaw <name> channels ${action} <channel>`);
      expect(output).not.toMatch(
        new RegExp(`nemoclaw <name> channels ${action}\\\\s{2,}[^\\n]*<channel>`),
      );
    },
  );

  it("shows the supported policy acknowledgement flags", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    renderRootHelp();

    const output = log.mock.calls.map(([line]) => String(line)).join("\n");
    expect(output).toMatch(
      /nemoclaw <name> policy exclude <key>[^\n]*\(--force, --yes, -y, --dry-run\)/,
    );
    expect(output).toMatch(
      /nemoclaw <name> policy restore <key>[^\n]*\(--force, --yes, -y, --dry-run\)/,
    );
    expect(output).not.toContain("(--force, -f, --yes, -y, --dry-run)");
  });

  it("lists --destroy-user-data under uninstall flags without unsupported --keep flags", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    renderRootHelp();

    const output = log.mock.calls.map(([line]) => String(line)).join("\n");
    expect(output).toMatch(
      /--destroy-user-data[^\n]*remove managed CLI shims only when no sibling gateway is confirmed/,
    );
    expect(output).not.toMatch(/--keep-user-data/);
    expect(output).not.toMatch(/--keep-backups/);
  });
});
