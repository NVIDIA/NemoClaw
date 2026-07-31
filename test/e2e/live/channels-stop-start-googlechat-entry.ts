// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";
import { fileURLToPath } from "node:url";

import type { AddSandboxChannelDependencies } from "../../../src/lib/actions/sandbox/policy-channel.ts";
import * as policyChannelModule from "../../../src/lib/actions/sandbox/policy-channel.ts";
import { assertChannelsStopStartSandboxName } from "./channels-stop-start-safety.ts";

type PolicyChannelModule = typeof import("../../../src/lib/actions/sandbox/policy-channel.ts");

const policyChannel = (
  "default" in policyChannelModule ? policyChannelModule.default : policyChannelModule
) as PolicyChannelModule;
const { addSandboxChannel } = policyChannel;

interface GooglechatLiveE2eComposition {
  readonly sandboxName: string;
  readonly audience: string;
}

interface GooglechatLiveE2eDependencies {
  readonly addSandboxChannel: (
    sandboxName: string,
    options: { readonly channel: string },
    dependencies: AddSandboxChannelDependencies,
  ) => Promise<void>;
}

const DEFAULT_DEPENDENCIES: GooglechatLiveE2eDependencies = {
  addSandboxChannel,
};

/**
 * The sole composition root that grants non-interactive Google Chat audience
 * enrollment. Production CLI composition does not receive this capability.
 */
export async function addGooglechatForChannelsStopStartLiveE2e(
  input: GooglechatLiveE2eComposition,
  dependencies: GooglechatLiveE2eDependencies = DEFAULT_DEPENDENCIES,
): Promise<void> {
  assertChannelsStopStartSandboxName(input.sandboxName);
  const audience = input.audience.trim();
  if (!audience) {
    throw new Error("GOOGLECHAT_AUDIENCE is required for the channels-stop-start live target");
  }

  await dependencies.addSandboxChannel(
    input.sandboxName,
    { channel: "googlechat" },
    {
      googlechatNonInteractiveAudienceCapability: Object.freeze({ audience }),
    },
  );
}

async function main(): Promise<void> {
  await addGooglechatForChannelsStopStartLiveE2e({
    sandboxName: process.argv[2] ?? "",
    audience: process.env.GOOGLECHAT_AUDIENCE ?? "",
  });
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "")) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
