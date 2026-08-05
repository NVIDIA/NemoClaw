// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import * as agentRuntime from "../../agent/runtime";
import { prepareInteractiveSession } from "./connect";
import { prepareHermesLightTerminalSkin } from "./connect-hermes-light-skin";
import { execSandbox } from "./exec";

/**
 * Connect to a sandbox and start its agent in one host-side step (#6006).
 *
 * The preflight is the same one `connect` runs, and it must run first: the
 * agent started over `exec` without process recovery renders a TUI that sits
 * disconnected because the gateway was never checked or restarted.
 */
export async function launchSandbox(sandboxName: string): Promise<void> {
  const { agent, sb } = await prepareInteractiveSession(sandboxName);
  const agentCommand = agentRuntime.getInteractiveAgentCommand(agent, sb?.agent);

  // `connect` runs this immediately before opening its SSH session. It is not
  // part of prepareInteractiveSession, so `launch` must call it too: without it
  // a Hermes TUI on a light-background terminal keeps the default dark skin,
  // and a switch back to a dark terminal never removes the managed skin.
  prepareHermesLightTerminalSkin(sandboxName, agent, process.env);

  // Run the agent through a login shell. execSandbox wraps every command in
  // wrapExecCommandWithRuntimeEnv (runtime-env.ts), which sources
  // /tmp/nemoclaw-proxy-env.sh and then unsets OPENCLAW_GATEWAY_TOKEN so
  // ordinary caller argv cannot inherit it (#6291). The SSH path that
  // `connect` uses keeps the token because the login shell re-sources that
  // file through the profile. Passing bare argv here would silently start the
  // agent under a different auth mode than `connect` gives it, so `-l` is
  // load-bearing: do not flatten this to `bash -c` or to the split command.
  await execSandbox(sandboxName, ["bash", "-lc", agentCommand], {
    tty: true,
    stdin: true,
    // 0 means no timeout. Any other value kills a long interactive session.
    timeoutSeconds: 0,
  });
}
