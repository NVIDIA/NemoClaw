import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import {
  preparePortableRetirement,
  publishAndRetirePortableEvidence,
} from "../../../src/lib/state/portable-uninstall-retirement";
import {
  minimalSpawnEnv,
  runOnboardProcess,
  testRepoRoot,
} from "../../helpers/onboard-child-process-harness";
import { testTimeoutOptions } from "../../helpers/timeouts";
import {
  simulatedInitialProvisioning,
  simulatedProvisioning,
  writeSuccessfulOpenShell,
} from "../../support/onboard-exit-flow";

const onboardPath = path.join(testRepoRoot, "dist/lib/onboard.js");

it.for([
  {
    phase: "finalization",
    flags: [],
    reason: "the session record is malformed",
    provisioning: `${simulatedProvisioning(onboardPath)}
const complete = finalPhases.runFinalOnboardFlowSlice;
finalPhases.runFinalOnboardFlowSlice = async (options) => {
  const result = await complete(options);
  rejectSession(Buffer.concat([Buffer.from('{"id":"'), Buffer.from([0xff]), Buffer.from('"}')]));
  return result;
};`,
  },
  {
    phase: "providerless APF sandbox completion",
    flags: ["--apf-interceptor"],
    reason: 'field "apfInterceptorRequested" must be a boolean',
    provisioning: `${simulatedInitialProvisioning(onboardPath)}
const { completeSession } = fromLib("./state/onboard-session");
corePhases.runCoreOnboardFlowSlice = async ({ phases, context, runtime }) => {
  const selected = await phases.providerInference.run(context);
  const [inference, sandbox] = selected.result;
  await runtime.applyResult(inference);
  await runtime.applyResult(sandbox);
  const session = completeSession({ sandboxName: selected.context.sandboxName });
  const saved = JSON.parse(fs.readFileSync(sessionPath, "utf8"));
  rejectSession(JSON.stringify({ ...saved, apfInterceptorRequested: "invalid" }));
  return { context: selected.context, session };
};`,
  },
])(
  "onboard reports the rejected session after $phase and retains both files on exit",
  testTimeoutOptions(35_000),
  ({ flags, reason, provisioning }, { onTestFinished }) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-retirement-"));
    onTestFinished(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
    const stateDir = path.join(tmpDir, ".nemoclaw");
    const receipts = path.join(stateDir, "portable-demo-lifecycle");
    const config = path.join(tmpDir, ".config/nemoclaw/portable");
    const receipt = `${"a".repeat(64)}.json`;
    fs.mkdirSync(receipts, { recursive: true, mode: 0o700 });
    fs.mkdirSync(config, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(receipts, receipt), "{}\n", { mode: 0o600 });
    fs.writeFileSync(path.join(config, "containers.conf"), "[engine]\n", { mode: 0o600 });
    fs.writeFileSync(path.join(stateDir, "sandboxes.json"), '{"sandboxes":{}}\n', {
      mode: 0o600,
    });
    const retirement = preparePortableRetirement(tmpDir, [receipt]);
    publishAndRetirePortableEvidence(retirement);

    const sessionPath = path.join(stateDir, "onboard-session.json");
    const beforeExit = path.join(tmpDir, "session-before-exit");
    const preload = path.join(tmpDir, "corrupt-completed-session.cjs");
    fs.writeFileSync(
      preload,
      `const fs = require("node:fs");
const sessionPath = ${JSON.stringify(sessionPath)};
function rejectSession(bytes) {
  fs.writeFileSync(sessionPath, bytes);
  fs.writeFileSync(${JSON.stringify(beforeExit)}, bytes);
}
${provisioning}`,
    );
    const result = runOnboardProcess(
      [
        "--require",
        preload,
        "bin/nemoclaw.js",
        "onboard",
        "--non-interactive",
        "--no-gpu",
        "--name",
        "complete-seam",
        ...flags,
      ],
      {
        env: minimalSpawnEnv(tmpDir, {
          PATH: ["/usr/bin", "/bin"].join(path.delimiter),
          TMPDIR: tmpDir,
          NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
          NEMOCLAW_GATEWAY_PORT: "8080",
          NEMOCLAW_OPENSHELL_BIN: writeSuccessfulOpenShell(tmpDir),
          NEMOCLAW_TEST_FINAL_STATE: "complete",
        }),
        timeoutMs: 30_000,
      },
    );
    expect(result.status, result.error?.message ?? result.stderr).toBe(1);
    expect(result.stderr).toContain(
      `Completed onboarding session authority is incomplete: ${reason}. ` +
        "Keep onboard-session.json unchanged and report this message in a NemoClaw GitHub issue for recovery guidance.",
    );
    expect(result.stderr).not.toMatch(/Refusing to load the onboarding session|^\s+at /m);
    expect(fs.readFileSync(sessionPath)).toEqual(fs.readFileSync(beforeExit));
    expect(fs.readFileSync(path.join(stateDir, "portable-uninstall-retirement.json"))).toEqual(
      retirement.recordBytes,
    );
  },
);
