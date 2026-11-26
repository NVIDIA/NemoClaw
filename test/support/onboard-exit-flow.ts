import fs from "node:fs";
import path from "node:path";

export function writeSuccessfulOpenShell(tmpDir: string): string {
  const openshellPath = path.join(tmpDir, "openshell");
  fs.writeFileSync(openshellPath, `#!${process.execPath}\nprocess.exit(0);\n`, { mode: 0o755 });
  return openshellPath;
}

export function simulatedInitialProvisioning(onboardPath: string): string {
  return `
const fromLib = require("node:module").createRequire(${JSON.stringify(onboardPath)});
const initialPhases = fromLib("./onboard/machine/initial-flow-phases");
const corePhases = fromLib("./onboard/machine/core-flow-phases");
const finalPhases = fromLib("./onboard/machine/final-flow-phases");
const { advanceTo, branchTo, completeOnboardMachine } = fromLib("./onboard/machine/result");

initialPhases.runInitialOnboardFlowSlice = async ({ context, runtime }) => {
  await runtime.applyResult(advanceTo("preflight", { metadata: { state: "init" } }));
  await runtime.applyResult(advanceTo("gateway", { metadata: { state: "preflight" } }));
  await runtime.applyResult(advanceTo("provider_selection", { metadata: { state: "gateway" } }));
  const session = await runtime.session();
  return {
    context: {
      ...context,
      session,
      gpu: null,
      sandboxGpuConfig: { mode: "disabled", hostGpuPlatform: null },
      gpuPassthrough: false,
      requestedGpuPassthrough: false,
      resumeHasResolvedGpuIntent: true,
    },
    session,
  };
};
`;
}

export function simulatedProvisioning(onboardPath: string): string {
  return `${simulatedInitialProvisioning(onboardPath)}
corePhases.runCoreOnboardFlowSlice = async ({ context, runtime }) => {
  await runtime.applyResult(advanceTo("inference", { metadata: { state: "provider_selection" } }));
  await runtime.applyResult(advanceTo("sandbox", {
    metadata: { state: "inference" },
    updates: { provider: "nvidia", model: "nemotron-test" },
  }));
  await runtime.applyResult(branchTo("openclaw", {
    metadata: { state: "sandbox" },
    updates: { sandboxName: "complete-seam" },
  }));
  const session = await runtime.session();
  return {
    context: {
      ...context,
      session,
      sandboxName: "complete-seam",
      provider: "nvidia",
      model: "nemotron-test",
      endpointUrl: null,
      credentialEnv: "NVIDIA_API_KEY",
      nimContainer: null,
      webSearchConfig: null,
      webSearchSupported: false,
      selectedMessagingChannels: [],
    },
    session,
  };
};

finalPhases.runFinalOnboardFlowSlice = async ({ runtime }) => {
  await runtime.applyResult(advanceTo("policies", { metadata: { state: "openclaw" } }));
  await runtime.applyResult(advanceTo("finalizing", { metadata: { state: "policies" } }));
  await runtime.applyResult(advanceTo("post_verify", { metadata: { state: "finalizing" } }));
  if (process.env.NEMOCLAW_TEST_FINAL_STATE === "complete") {
    await runtime.applyResult(completeOnboardMachine(
      { sandboxName: "complete-seam", provider: "nvidia", model: "nemotron-test" },
      { state: "post_verify" },
    ));
  }
  return { context: null, session: await runtime.session() };
};
`;
}
