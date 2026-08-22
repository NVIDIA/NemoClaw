// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ChildProcess } from "node:child_process";

import { launchVoiceGateway, type VoiceGatewayLaunchOptions } from "../../voice-gateway/launcher";

/** Start the voice gateway for a trusted external integration. */
export async function runVoiceGatewayLaunch(
  options: VoiceGatewayLaunchOptions,
): Promise<ChildProcess> {
  return launchVoiceGateway(options);
}
