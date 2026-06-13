// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { SandboxCancelRollback } from "./cancel-rollback";
import type { TierDefinition } from "../policy/tiers";

type PresetWithDescription = { name: string; description?: string };
type PresetWithAccess = { name: string; access: string };
type PolicyPromptInput = {
  isTTY?: boolean;
  on(event: "data", listener: (key: string) => void): unknown;
  pause(): unknown;
  removeListener(event: "data", listener: (key: string) => void): unknown;
  resume(): unknown;
  setEncoding(encoding: BufferEncoding): unknown;
  setRawMode(mode: boolean): unknown;
  ref?: () => void;
  unref?: () => void;
};
type PolicyPromptOutput = {
  isTTY?: boolean;
  write(chunk: string): unknown;
};
type PolicyPromptProcessEvents = {
  once(event: "SIGTERM", listener: () => void): unknown;
  removeListener(event: "SIGTERM", listener: () => void): unknown;
};

export interface PolicySelectionPromptDeps {
  tiers: {
    listTiers(): TierDefinition[];
    getTier(name: string): TierDefinition | null;
  };
  policyTierEnv: {
    resolvePolicyTierFromEnv(): string;
  };
  isNonInteractive(): boolean;
  note(message: string): void;
  prompt(question: string): Promise<string>;
  selectFromNumberedMenuOrExit<T>(rawChoice: string, defaultIdx: number, options: T[]): T;
  makeOnboardCancelExit(
    rollback: Pick<SandboxCancelRollback, "markCancelled">,
    cleanup: () => void,
  ): () => void;
  sandboxCancelRollback: Pick<SandboxCancelRollback, "markCancelled">;
  useColor: boolean;
  stdin?: PolicyPromptInput;
  stdout?: PolicyPromptOutput;
  processEvents?: PolicyPromptProcessEvents;
}

export function createPolicySelectionPromptHelpers(deps: PolicySelectionPromptDeps): {
  selectPolicyTier(): Promise<string>;
  selectTierPresetsAndAccess(
    tierName: string,
    allPresets: PresetWithDescription[],
    extraSelected?: string[],
  ): Promise<PresetWithAccess[]>;
  presetsCheckboxSelector(
    allPresets: Array<{ name: string; description: string }>,
    initialSelected: string[],
  ): Promise<string[]>;
} {
  const {
    tiers,
    policyTierEnv,
    isNonInteractive,
    note,
    prompt,
    selectFromNumberedMenuOrExit,
    makeOnboardCancelExit,
    sandboxCancelRollback,
    useColor,
  } = deps;
  const stdin = deps.stdin ?? process.stdin;
  const stdout = deps.stdout ?? process.stdout;
  const processEvents = deps.processEvents ?? process;

  /**
   * Prompt the user to select a policy tier (restricted / balanced / open).
   * Uses the same radio-style TUI as presetsCheckboxSelector (single-select).
   * In non-interactive mode reads NEMOCLAW_POLICY_TIER (default: balanced).
   * Returns the tier name string.
   */
  async function selectPolicyTier(): Promise<string> {
    const allTiers = tiers.listTiers();
    const defaultTier = allTiers.find((tier) => tier.name === "balanced") ?? allTiers[1];

    if (!defaultTier) {
      throw new Error("No policy tiers are configured.");
    }

    if (isNonInteractive()) {
      const name = policyTierEnv.resolvePolicyTierFromEnv();
      note(`  [non-interactive] Policy tier: ${name}`);
      return name;
    }

    const RADIO_ON = useColor ? "[\x1b[32m✓\x1b[0m]" : "[✓]";
    const RADIO_OFF = useColor ? "\x1b[2m[ ]\x1b[0m" : "[ ]";

    // ── Fallback: non-TTY ─────────────────────────────────────────────
    if (!stdin.isTTY || !stdout.isTTY) {
      console.log("");
      console.log("  Policy tier — controls which network presets are enabled:");
      allTiers.forEach((tier) => {
        const marker = tier.name === defaultTier.name ? RADIO_ON : RADIO_OFF;
        console.log(`    ${marker} ${tier.label}`);
      });
      console.log("");
      const answer = await prompt(
        `  Select tier [1-${allTiers.length}] (default: ${allTiers.indexOf(defaultTier) + 1} ${defaultTier.name}): `,
      );
      const chosen = selectFromNumberedMenuOrExit(
        answer,
        allTiers.indexOf(defaultTier) + 1,
        allTiers,
      );
      console.log(`  Tier: ${chosen.label}`);
      return chosen.name;
    }

    // ── Raw-mode TUI (radio — single selection) ───────────────────────
    let cursor = allTiers.indexOf(defaultTier);
    let selectedIdx = cursor;
    const n = allTiers.length;

    const G = useColor ? "\x1b[32m" : "";
    const D = useColor ? "\x1b[2m" : "";
    const R = useColor ? "\x1b[0m" : "";
    const HINT = useColor
      ? `  ${G}↑/↓ j/k${R}  ${D}move${R}    ${G}Space${R}  ${D}select${R}    ${G}Enter${R}  ${D}confirm${R}`
      : "  ↑/↓ j/k  move    Space  select    Enter  confirm";

    const renderLines = () => {
      const lines = ["  Policy tier — controls which network presets are enabled:"];
      allTiers.forEach((tier, index) => {
        const radio = index === selectedIdx ? RADIO_ON : RADIO_OFF;
        const arrow = index === cursor ? ">" : " ";
        lines.push(`   ${arrow} ${radio} ${tier.label}`);
      });
      lines.push("");
      lines.push(HINT);
      return lines;
    };

    stdout.write("\n");
    const initial = renderLines();
    for (const line of initial) stdout.write(`${line}\n`);
    let lineCount = initial.length;

    const redraw = () => {
      stdout.write(`\x1b[${lineCount}A`);
      const lines = renderLines();
      for (const line of lines) stdout.write(`\r\x1b[2K${line}\n`);
      lineCount = lines.length;
    };

    // Re-attach stdin to the event loop. A prior prompt cleanup may have
    // unref'd it (sticky), and resume() alone would leave the raw-mode read
    // detached from the loop.
    if (typeof stdin.ref === "function") stdin.ref();
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");

    return new Promise<string>((resolve) => {
      const cleanup = () => {
        stdin.setRawMode(false);
        stdin.pause();
        // Symmetric with the ref() at the entry; lets the wizard exit
        // naturally if this is the last prompt.
        if (typeof stdin.unref === "function") stdin.unref();
        stdin.removeListener("data", onData);
        processEvents.removeListener("SIGTERM", onSigterm);
      };

      const onSigterm = makeOnboardCancelExit(sandboxCancelRollback, cleanup);
      processEvents.once("SIGTERM", onSigterm);

      const onData = (key: string) => {
        if (key === "\r" || key === "\n") {
          cleanup();
          stdout.write("\n");
          resolve(allTiers[selectedIdx].name);
        } else if (key === " ") {
          selectedIdx = cursor;
          redraw();
        } else if (key === "\x03") {
          makeOnboardCancelExit(sandboxCancelRollback, cleanup)();
        } else if (key === "\x1b[A" || key === "k") {
          cursor = (cursor - 1 + n) % n;
          redraw();
        } else if (key === "\x1b[B" || key === "j") {
          cursor = (cursor + 1) % n;
          redraw();
        }
      };

      stdin.on("data", onData);
    });
  }

  /**
   * Combined preset selector: shows ALL available presets, pre-checks those in
   * the chosen tier, and lets the user include/exclude any preset and toggle
   * per-preset access (read vs read-write).
   *
   * Tier presets are listed first (in tier order), then remaining presets
   * alphabetically. Tier presets are pre-checked; others start unchecked.
   */
  async function selectTierPresetsAndAccess(
    tierName: string,
    allPresets: PresetWithDescription[],
    extraSelected: string[] = [],
  ): Promise<PresetWithAccess[]> {
    const tierDef = tiers.getTier(tierName);
    const tierPresetMap: Record<string, string> = {};
    if (tierDef) {
      for (const preset of tierDef.presets) {
        tierPresetMap[preset.name] = preset.access;
      }
    }

    // Tier presets first (in tier order), then the rest in their original order.
    const tierNames = tierDef ? tierDef.presets.map((preset) => preset.name) : [];
    const tierSet = new Set(tierNames);
    const ordered: PresetWithDescription[] = [
      ...tierNames
        .map((name) => allPresets.find((preset) => preset.name === name))
        .filter((preset): preset is PresetWithDescription => Boolean(preset)),
      ...allPresets.filter((preset) => !tierSet.has(preset.name)),
    ];

    // Initial inclusion: tier presets + any already-applied extras.
    const included = new Set([
      ...tierNames,
      ...extraSelected.filter((name) => ordered.find((preset) => preset.name === name)),
    ]);

    // Access levels: tier defaults for tier presets, read-write default for others.
    const accessModes: Record<string, string> = {};
    for (const preset of ordered) {
      accessModes[preset.name] = tierPresetMap[preset.name] ?? "read-write";
    }

    const G = useColor ? "\x1b[32m" : "";
    const O = useColor ? "\x1b[38;5;208m" : "";
    const D = useColor ? "\x1b[2m" : "";
    const R = useColor ? "\x1b[0m" : "";
    const GREEN_CHECK = useColor ? `[${G}✓${R}]` : "[✓]";
    const EMPTY_CHECK = useColor ? `${D}[ ]${R}` : "[ ]";
    const TOGGLE_RW = useColor ? `[${O}rw${R}]` : "[rw]";
    const TOGGLE_R = useColor ? `${D}[ r]${R}` : "[ r]";

    const label = tierDef ? `  Presets  (${tierDef.label} defaults):` : "  Presets:";
    const n = ordered.length;

    // ── Non-interactive: return tier defaults silently ─────────────────
    if (isNonInteractive()) {
      return ordered
        .filter((preset) => included.has(preset.name))
        .map((preset) => ({ name: preset.name, access: accessModes[preset.name] }));
    }

    // ── Fallback: non-TTY ─────────────────────────────────────────────
    if (!stdin.isTTY || !stdout.isTTY) {
      console.log("");
      console.log(label);
      ordered.forEach((preset) => {
        const isIncluded = included.has(preset.name);
        const isRw = accessModes[preset.name] === "read-write";
        const check = isIncluded ? GREEN_CHECK : EMPTY_CHECK;
        const badge = isIncluded ? (isRw ? "[rw]" : "[ r]") : "    ";
        console.log(`    ${check} ${badge} ${preset.name}`);
      });
      console.log("");
      const rawInclude = await prompt(
        "  Include presets (comma-separated names, Enter to keep defaults): ",
      );
      if (rawInclude.trim()) {
        const knownNames = new Set(ordered.map((preset) => preset.name));
        included.clear();
        for (const name of rawInclude
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean)) {
          if (knownNames.has(name)) {
            included.add(name);
          } else {
            console.error(`  Unknown preset name ignored: ${name}`);
          }
        }
      }
      return ordered
        .filter((preset) => included.has(preset.name))
        .map((preset) => ({ name: preset.name, access: accessModes[preset.name] }));
    }

    // ── Raw-mode TUI ─────────────────────────────────────────────────
    let cursor = 0;

    const HINT = useColor
      ? `  ${G}↑/↓ j/k${R}  ${D}move${R}    ${G}Space${R}  ${D}include${R}    ${G}r${R}  ${D}toggle rw${R}    ${G}Enter${R}  ${D}confirm${R}`
      : "  ↑/↓ j/k  move    Space  include    r  toggle rw    Enter  confirm";

    const renderLines = () => {
      const lines = [label];
      ordered.forEach((preset, index) => {
        const isIncluded = included.has(preset.name);
        const isRw = accessModes[preset.name] === "read-write";
        const check = isIncluded ? GREEN_CHECK : EMPTY_CHECK;
        // badge is 4 visible chars + 1 space; blank when unchecked to keep name aligned
        const badge = isIncluded ? (isRw ? TOGGLE_RW + " " : TOGGLE_R + " ") : "     ";
        const arrow = index === cursor ? ">" : " ";
        lines.push(`   ${arrow} ${check} ${badge}${preset.name}`);
      });
      lines.push("");
      lines.push(HINT);
      return lines;
    };

    stdout.write("\n");
    const initial = renderLines();
    for (const line of initial) stdout.write(`${line}\n`);
    let lineCount = initial.length;

    const redraw = () => {
      stdout.write(`\x1b[${lineCount}A`);
      const lines = renderLines();
      for (const line of lines) stdout.write(`\r\x1b[2K${line}\n`);
      lineCount = lines.length;
    };

    // Re-attach stdin to the event loop. A prior prompt cleanup may have
    // unref'd it (sticky), and resume() alone would leave the raw-mode read
    // detached from the loop.
    if (typeof stdin.ref === "function") stdin.ref();
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");

    return new Promise<PresetWithAccess[]>((resolve) => {
      const cleanup = () => {
        stdin.setRawMode(false);
        stdin.pause();
        // Symmetric with the ref() at the entry; lets the wizard exit
        // naturally if this is the last prompt.
        if (typeof stdin.unref === "function") stdin.unref();
        stdin.removeListener("data", onData);
        processEvents.removeListener("SIGTERM", onSigterm);
      };

      const onSigterm = makeOnboardCancelExit(sandboxCancelRollback, cleanup);
      processEvents.once("SIGTERM", onSigterm);

      const onData = (key: string) => {
        if (key === "\r" || key === "\n") {
          cleanup();
          stdout.write("\n");
          resolve(
            ordered
              .filter((preset) => included.has(preset.name))
              .map((preset) => ({ name: preset.name, access: accessModes[preset.name] })),
          );
        } else if (key === "\x03") {
          makeOnboardCancelExit(sandboxCancelRollback, cleanup)();
        } else if (key === "\x1b[A" || key === "k") {
          cursor = (cursor - 1 + n) % n;
          redraw();
        } else if (key === "\x1b[B" || key === "j") {
          cursor = (cursor + 1) % n;
          redraw();
        } else if (key === " ") {
          const currentPreset = ordered[cursor];
          if (!currentPreset) return;
          const name = currentPreset.name;
          if (included.has(name)) {
            included.delete(name);
          } else {
            included.add(name);
          }
          redraw();
        } else if (key === "r" || key === "R") {
          const currentPreset = ordered[cursor];
          if (!currentPreset) return;
          const name = currentPreset.name;
          accessModes[name] = accessModes[name] === "read-write" ? "read" : "read-write";
          redraw();
        }
      };

      stdin.on("data", onData);
    });
  }

  /**
   * Raw-mode TUI preset selector.
   * Keys: ↑/↓ or k/j to move, Space to toggle, a to select/unselect all, Enter to confirm.
   * Falls back to a simple line-based prompt when stdin is not a TTY.
   */
  async function presetsCheckboxSelector(
    allPresets: Array<{ name: string; description: string }>,
    initialSelected: string[],
  ): Promise<string[]> {
    const selected = new Set<string>(initialSelected);
    const n = allPresets.length;

    // ── Zero-presets guard ────────────────────────────────────────────
    if (n === 0) {
      console.log("  No policy presets are available.");
      return [];
    }

    const GREEN_CHECK = useColor ? "[\x1b[32m✓\x1b[0m]" : "[✓]";

    // ── Fallback: non-TTY or redirected stdout (piped input) ──────────
    if (!stdin.isTTY || !stdout.isTTY) {
      console.log("");
      console.log("  Available policy presets:");
      allPresets.forEach((preset) => {
        const marker = selected.has(preset.name) ? GREEN_CHECK : "[ ]";
        console.log(`    ${marker} ${preset.name.padEnd(14)} — ${preset.description}`);
      });
      console.log("");
      const raw = await prompt("  Select presets (comma-separated names, Enter to skip): ");
      if (!raw.trim()) {
        console.log("  Skipping policy presets.");
        return [];
      }
      const knownNames = new Set(allPresets.map((preset) => preset.name));
      const chosen = [];
      for (const name of raw
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)) {
        if (knownNames.has(name)) {
          chosen.push(name);
        } else {
          console.error(`  Unknown preset name ignored: ${name}`);
        }
      }
      return chosen;
    }

    // ── Raw-mode TUI ─────────────────────────────────────────────────
    let cursor = 0;

    const G = useColor ? "\x1b[32m" : "";
    const D = useColor ? "\x1b[2m" : "";
    const R = useColor ? "\x1b[0m" : "";
    const HINT = useColor
      ? `  ${G}↑/↓ j/k${R}  ${D}move${R}    ${G}Space${R}  ${D}toggle${R}    ${G}a${R}  ${D}all/none${R}    ${G}Enter${R}  ${D}confirm${R}`
      : "  ↑/↓ j/k  move    Space  toggle    a  all/none    Enter  confirm";

    const renderLines = () => {
      const lines = ["  Available policy presets:"];
      allPresets.forEach((preset, index) => {
        const check = selected.has(preset.name) ? GREEN_CHECK : "[ ]";
        const arrow = index === cursor ? ">" : " ";
        lines.push(`   ${arrow} ${check} ${preset.name.padEnd(14)} — ${preset.description}`);
      });
      lines.push("");
      lines.push(HINT);
      return lines;
    };

    // Initial paint
    stdout.write("\n");
    const initial = renderLines();
    for (const line of initial) stdout.write(`${line}\n`);
    let lineCount = initial.length;

    const redraw = () => {
      stdout.write(`\x1b[${lineCount}A`);
      const lines = renderLines();
      for (const line of lines) stdout.write(`\r\x1b[2K${line}\n`);
      lineCount = lines.length;
    };

    // Re-attach stdin to the event loop. A prior prompt cleanup may have
    // unref'd it (sticky), and resume() alone would leave the raw-mode read
    // detached from the loop.
    if (typeof stdin.ref === "function") stdin.ref();
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");

    return new Promise<string[]>((resolve) => {
      const cleanup = () => {
        stdin.setRawMode(false);
        stdin.pause();
        // Symmetric with the ref() at the entry; lets the wizard exit
        // naturally if this is the last prompt.
        if (typeof stdin.unref === "function") stdin.unref();
        stdin.removeListener("data", onData);
        processEvents.removeListener("SIGTERM", onSigterm);
      };

      const onSigterm = makeOnboardCancelExit(sandboxCancelRollback, cleanup);
      processEvents.once("SIGTERM", onSigterm);

      const onData = (key: string) => {
        if (key === "\r" || key === "\n") {
          cleanup();
          stdout.write("\n");
          resolve([...selected]);
        } else if (key === "\x03") {
          makeOnboardCancelExit(sandboxCancelRollback, cleanup)();
        } else if (key === "\x1b[A" || key === "k") {
          cursor = (cursor - 1 + n) % n;
          redraw();
        } else if (key === "\x1b[B" || key === "j") {
          cursor = (cursor + 1) % n;
          redraw();
        } else if (key === " ") {
          const currentPreset = allPresets[cursor];
          if (!currentPreset) return;
          const name = currentPreset.name;
          if (selected.has(name)) selected.delete(name);
          else selected.add(name);
          redraw();
        } else if (key === "a") {
          if (selected.size === n) selected.clear();
          else for (const preset of allPresets) selected.add(preset.name);
          redraw();
        }
      };

      stdin.on("data", onData);
    });
  }

  return {
    selectPolicyTier,
    selectTierPresetsAndAccess,
    presetsCheckboxSelector,
  };
}
