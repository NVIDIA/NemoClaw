// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  appendResourceFlags,
  getHardwareResources,
  loadResourceProfiles,
  resolveResourceValue,
  type ResourceProfile,
} from "../resources-cmd";

export type ResourceProfileSelectionDeps = {
  isNonInteractive: () => boolean;
  note: (message: string) => void;
  prompt: (question: string) => Promise<string>;
  promptOrDefault: (
    question: string,
    envVar: string | null,
    defaultValue: string,
  ) => Promise<string>;
  env?: NodeJS.ProcessEnv;
};

function hasResourceEnvOverrides(env: NodeJS.ProcessEnv): boolean {
  return !!(env.NEMOCLAW_CPU || env.NEMOCLAW_RAM);
}

function applyResourceEnvOverrides(
  selectedProfile: ResourceProfile | null,
  deps: ResourceProfileSelectionDeps,
): ResourceProfile | null {
  const env = deps.env ?? process.env;
  if (!hasResourceEnvOverrides(env)) return selectedProfile;
  const nextProfile = selectedProfile ? { ...selectedProfile } : { cpu: "", memory: "" };
  if (env.NEMOCLAW_CPU) nextProfile.cpu = env.NEMOCLAW_CPU;
  if (env.NEMOCLAW_RAM) nextProfile.memory = env.NEMOCLAW_RAM;
  deps.note(
    `  Resource overrides (env): cpu=${nextProfile.cpu}, ram=${nextProfile.memory}`,
  );
  return nextProfile;
}

function exitWithResourceProfileError(message: string): never {
  console.error(`  ${message}`);
  process.exit(1);
}

function printResolvedResourceProfile(profile: ResourceProfile, cpuTotal: number, memTotal: number): void {
  const resolvedCpu = resolveResourceValue(profile.cpu, cpuTotal, "cpu");
  const resolvedMemory = resolveResourceValue(profile.memory, memTotal, "memory");
  console.log(
    `  Resolved: CPU=${resolvedCpu}, RAM=${resolvedMemory}`,
  );
}

export async function selectResourceProfileForSandbox(
  deps: ResourceProfileSelectionDeps,
): Promise<ResourceProfile | null> {
  const env = deps.env ?? process.env;
  const availableProfiles = loadResourceProfiles();
  const profileNames = Object.keys(availableProfiles).filter((name) => name !== "default");
  let selectedProfile: ResourceProfile | null = null;

  if (env.NEMOCLAW_RESOURCE_PROFILE) {
    const envProfile = env.NEMOCLAW_RESOURCE_PROFILE;
    if (envProfile === "default") {
      selectedProfile = null;
      deps.note("  Resource profile (env): default (OpenShell defaults)");
    } else if (Object.prototype.hasOwnProperty.call(availableProfiles, envProfile)) {
      selectedProfile = { ...availableProfiles[envProfile] };
      deps.note(`  Resource profile (env): ${envProfile}`);
    } else {
      console.error(`  Unknown resource profile: '${envProfile}'`);
      console.error(`  Valid profiles: ${["default", ...profileNames].join(", ")}`);
      process.exit(1);
    }
  } else if (profileNames.length > 0 && !deps.isNonInteractive() && !hasResourceEnvOverrides(env)) {
    const hw = getHardwareResources();
    console.log("");
    console.log("  Resource profiles:");
    profileNames.forEach((name: string, i: number) => {
      const p = availableProfiles[name];
      console.log(
        `    ${i + 1}) ${name} (cpu=${p.cpu}, ram=${p.memory})`,
      );
    });
    console.log(`    ${profileNames.length + 1}) custom (enter values manually)`);
    console.log(`    ${profileNames.length + 2}) No profile (OpenShell defaults)`);
    const choice = await deps.promptOrDefault(
      `  Choose [${profileNames.length + 2}]: `,
      null,
      String(profileNames.length + 2),
    );
    const trimmedChoice = choice.trim();
    const idx = Number.parseInt(trimmedChoice, 10) - 1;
    if (!/^\d+$/.test(trimmedChoice) || idx < 0 || idx > profileNames.length + 1) {
      exitWithResourceProfileError(
        `Invalid resource profile selection '${choice}'. Choose a number from 1 to ${profileNames.length + 2}.`,
      );
    }
    if (idx >= 0 && idx < profileNames.length) {
      selectedProfile = { ...availableProfiles[profileNames[idx]] };
      console.log(`  Using profile: ${profileNames[idx]}`);
    } else if (idx === profileNames.length) {
      console.log("");
      console.log(`  Available: ${hw.cpu.cores} CPU cores, ${hw.memory.totalMB} MB RAM`);
      console.log("  Enter values as percentages (e.g. 25%) or absolutes (e.g. 4, 8Gi)");
      console.log("");
      const cpu = (await deps.prompt(`  CPU [25%]: `)).trim() || "25%";
      const memory = (await deps.prompt(`  RAM [25%]: `)).trim() || "25%";
      selectedProfile = {
        cpu,
        memory,
      };
      try {
        printResolvedResourceProfile(selectedProfile, hw.cpu.cores, hw.memory.totalMB);
      } catch (e: unknown) {
        exitWithResourceProfileError((e as Error).message);
      }
    }
  }

  return applyResourceEnvOverrides(selectedProfile, deps);
}

export function appendResourceFlagsForProfile(
  args: string[],
  profile: ResourceProfile | null,
  openshellBinary: string,
  deps: ResourceProfileSelectionDeps,
): void {
  if (profile && !appendResourceFlags(args, profile, openshellBinary)) {
    deps.note("  OpenShell does not support resource flags — sandbox will use default limits.");
  }
}
