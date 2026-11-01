import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { readWindowsInstallerWorkflowSources } from "../../../tools/windows-installer/workflow-boundary.mts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const evidencePowerShell = process.platform === "win32" ? "pwsh.exe" : "pwsh";
const skipEvidenceProcesses =
  process.platform !== "win32" &&
  spawnSync(evidencePowerShell, ["-NoProfile", "-NonInteractive", "-Command", "exit 0"], {
    timeout: 10_000,
  }).status !== 0;

it.skipIf(skipEvidenceProcesses)(
  "native helper gate requires all 33 controls without failures or ignores",
  () => {
    const owner = Object.values(readWindowsInstallerWorkflowSources(repoRoot).workflow.jobs).find(
      (job) => job.steps?.some((item) => item.name === "Check the native transaction helper"),
    );
    expect(owner).toBeDefined();
    const command = owner!.steps!.find(
      (item) => item.name === "Check the native transaction helper",
    )!.run;
    const cases = [
      { output: "test result: ok. 33 passed; 0 failed; 0 ignored;", exitCode: 0, accepted: true },
      { output: "test result: ok. 31 passed; 0 failed; 0 ignored;", exitCode: 0, accepted: false },
      { output: "test result: ok. 32 passed; 0 failed; 0 ignored;", exitCode: 0, accepted: false },
      { output: "test result: ok. 34 passed; 0 failed; 0 ignored;", exitCode: 0, accepted: false },
      {
        output: "test result: FAILED. 32 passed; 1 failed; 0 ignored;",
        exitCode: 0,
        accepted: false,
      },
      { output: "test result: ok. 33 passed; 0 failed; 1 ignored;", exitCode: 0, accepted: false },
      { output: "test result: ok. 33 passed; 0 failed; 0 ignored;", exitCode: 1, accepted: false },
      { output: "", exitCode: 0, accepted: false },
    ];
    const script = String.raw`
$ErrorActionPreference = 'Stop'
$payload = [Console]::In.ReadToEnd() | ConvertFrom-Json
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseInput($payload.command, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'Workflow step does not parse.' }
$conditions = @($ast.EndBlock.Statements | Where-Object { $_ -is [Management.Automation.Language.IfStatementAst] })
if ($conditions.Count -ne 1) { throw 'Expected one final helper result gate.' }
$gate = [scriptblock]::Create($conditions[0].Extent.Text)
function Get-Content { param($LiteralPath, [switch]$Raw) return $script:output }
$log = 'controlled-cargo-output'
$observed = foreach ($case in $payload.cases) {
  $result = $case.exitCode
  $script:output = $case.output
  try { & $gate; $true } catch { $false }
}
ConvertTo-Json -InputObject @($observed) -Compress
`;
    const observed = spawnSync(
      evidencePowerShell,
      ["-NoProfile", "-NonInteractive", "-Command", script],
      {
        input: JSON.stringify({ command, cases }),
        encoding: "utf8",
        windowsHide: true,
        timeout: 30_000,
      },
    );
    expect(observed.status, observed.stderr).toBe(0);
    expect(JSON.parse(observed.stdout)).toEqual(cases.map((item) => item.accepted));
  },
);
