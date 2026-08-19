// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";
import policy from "../agents/hermes/unattended-approval-policy.json" with { type: "json" };

const root = path.join(import.meta.dirname, "..");
const helper = path.join(root, "agents", "hermes", "nemoclaw_unattended_approval.py");
const patcher = path.join(root, "agents", "hermes", "patch-unattended-approval.py");
const wikidataRead = path.join(root, "agents", "hermes", "hermes-wikidata-reference-read");

function policyAllows(policyPath: string, command: string, platform: string): boolean {
  const harness = `\
import importlib.util
import os
import pathlib
import sys

spec = importlib.util.spec_from_file_location("nemoclaw_unattended_approval", sys.argv[1])
assert spec and spec.loader
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
allowed = module.is_reviewed_unattended_command(
    sys.argv[3],
    sys.argv[4],
    policy_path=pathlib.Path(sys.argv[2]),
    trusted_uid=os.getuid(),
    trusted_gid=os.getgid(),
)
raise SystemExit(0 if allowed else 3)
`;
  const result = spawnSync(
    "python3",
    ["-I", "-c", harness, helper, policyPath, command, platform],
    {
      encoding: "utf8",
      timeout: 5000,
    },
  );
  return result.status === 0;
}

function withPolicy(run: (policyPath: string) => void) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-unattended-approval-"));
  const policyPath = path.join(directory, "policy.json");
  fs.writeFileSync(policyPath, `${JSON.stringify(policy)}\n`, { mode: 0o444 });
  try {
    run(policyPath);
  } finally {
    fs.chmodSync(policyPath, 0o644);
    fs.rmSync(directory, { force: true, recursive: true });
  }
}

const sourceFixture = `\
from tools.interrupt import is_interrupted

def check_all_command_guards(command, env_type, approval_callback=None,
                             has_host_access=False):
    # Skip isolated container backends for both checks. Docker stops skipping
    # once host paths are bind-mounted into the sandbox.
    if _should_skip_container_guards(env_type, has_host_access=has_host_access):
        return {"approved": True, "message": None}

    is_hardline, hardline_desc = detect_hardline_command(command)
    if is_hardline:
        return _hardline_block_result(hardline_desc)

    is_sudo_guess, sudo_guess_desc = _check_sudo_stdin_guard(command)
    if is_sudo_guess:
        return _sudo_stdin_block_result(sudo_guess_desc)

    deny_pattern = _match_user_deny_rule(command)
    if deny_pattern is not None:
        logger.warning("User deny rule %r blocked command: %s",
                       deny_pattern, command[:200])
        return _user_deny_block_result(deny_pattern)

    # --yolo or approvals.mode=off: bypass all approval prompts.
    return {"approved": False}
`;

function patchSource(source: string, semver = "0.19.0") {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-approval-patch-"));
  const sourcePath = path.join(directory, "approval.py");
  fs.writeFileSync(sourcePath, source);
  const hash = createHash("sha256").update(source).digest("hex");
  const harness = `\
import importlib.util
import pathlib
import sys

spec = importlib.util.spec_from_file_location("patch_unattended_approval", sys.argv[1])
assert spec and spec.loader
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
module.HERMES_APPROVAL_SHA256 = sys.argv[4]
module.patch_file(pathlib.Path(sys.argv[2]), sys.argv[3])
`;
  const result = spawnSync("python3", ["-I", "-c", harness, patcher, sourcePath, semver, hash], {
    encoding: "utf8",
    timeout: 5000,
  });
  const patched = fs.readFileSync(sourcePath, "utf8");
  fs.rmSync(directory, { force: true, recursive: true });
  return { ...result, patched };
}

describe("Hermes unattended approval policy", () => {
  it("keeps the reviewed wrapper fixed to the Wikidata Q30 result (#9528)", () => {
    const harness = `\
import importlib.machinery
import importlib.util
import io
import json
import pathlib
import sys
import tempfile

loader = importlib.machinery.SourceFileLoader("wikidata_read", sys.argv[1])
spec = importlib.util.spec_from_loader(loader.name, loader)
assert spec
module = importlib.util.module_from_spec(spec)
loader.exec_module(module)

class Response(io.BytesIO):
    def __enter__(self):
        return self
    def __exit__(self, *_args):
        self.close()
    def geturl(self):
        return module.URL

def open_response():
    return Response(b'{"success":1,"entities":{"Q30":{"labels":{"en":{"value":"United States"}}}}}')

module._open_response = open_response
module.sys.argv = [sys.argv[1]]
with tempfile.TemporaryDirectory() as directory:
    module.RESULT_PATH = pathlib.Path(directory) / "result.json"
    status = module.main()
    assert json.loads(module.RESULT_PATH.read_text()) == {
        "schemaVersion": 1,
        "entity": "Q30",
        "label": "United States",
        "status": "ok",
    }
raise SystemExit(status)
`;
    const result = spawnSync("python3", ["-I", "-c", harness, wikidataRead], {
      encoding: "utf8",
      timeout: 5000,
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("HERMES_REFERENCE_AGENT_OK\n");
  });

  it.each(["redirect", "oversized"])(
    "rejects a %s Wikidata response without writing a result (#9528)",
    (responseCase) => {
      const harness = `\
import importlib.machinery
import importlib.util
import io
import pathlib
import sys
import tempfile

loader = importlib.machinery.SourceFileLoader("wikidata_read", sys.argv[1])
spec = importlib.util.spec_from_loader(loader.name, loader)
assert spec
module = importlib.util.module_from_spec(spec)
loader.exec_module(module)

class Response(io.BytesIO):
    def __init__(self, payload, final_url):
        super().__init__(payload)
        self.final_url = final_url
    def __enter__(self):
        return self
    def __exit__(self, *_args):
        self.close()
    def geturl(self):
        return self.final_url

assert module._RejectRedirects().redirect_request(None, None, None, None, None, None, None) is None
if sys.argv[2] == "redirect":
    response = Response(b'{}', "https://redirected.invalid/result")
else:
    response = Response(b'x' * (module.MAX_RESPONSE_BYTES + 1), module.URL)
module._open_response = lambda: response
module.sys.argv = [sys.argv[1]]
with tempfile.TemporaryDirectory() as directory:
    module.RESULT_PATH = pathlib.Path(directory) / "result.json"
    status = module.main()
    assert status == 1
    assert not module.RESULT_PATH.exists()
raise SystemExit(0)
`;
      const result = spawnSync("python3", ["-I", "-c", harness, wikidataRead, responseCase], {
        encoding: "utf8",
        timeout: 5000,
      });

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe("HERMES_REFERENCE_AGENT_BAD\n");
    },
  );

  // source-shape-contract: security -- Executes the shipped approval helper against root-owned read-only policy bytes to prove the exact authorization boundary
  it("allows only the reviewed Wikidata read in an API-server session (#9528)", () => {
    withPolicy((policyPath) => {
      const action = policy.wikidataReferenceRead;
      expect(policyAllows(policyPath, action.command, action.platform)).toBe(true);
    });
  });

  it.each([
    [policy.wikidataReferenceRead.command, "local"],
    [`${policy.wikidataReferenceRead.command} --help`, "api_server"],
    [`${policy.wikidataReferenceRead.command}; echo extra`, "api_server"],
    [`sudo ${policy.wikidataReferenceRead.command}`, "api_server"],
  ])(
    "denies an invocation outside the reviewed command and platform [case %#] (#9528)",
    (command, platform) => {
      withPolicy((policyPath) => {
        expect(policyAllows(policyPath, command, platform)).toBe(false);
      });
    },
  );

  // source-shape-contract: security -- Mutating policy metadata and symlink topology proves the shipped authorization helper rejects untrusted state
  it("fails closed when the reviewed policy file can be changed or redirected (#9528)", () => {
    withPolicy((policyPath) => {
      fs.chmodSync(policyPath, 0o644);
      expect(policyAllows(policyPath, policy.wikidataReferenceRead.command, "api_server")).toBe(
        false,
      );

      const target = `${policyPath}.target`;
      fs.renameSync(policyPath, target);
      fs.symlinkSync(target, policyPath);
      expect(policyAllows(policyPath, policy.wikidataReferenceRead.command, "api_server")).toBe(
        false,
      );
      fs.unlinkSync(policyPath);
      fs.renameSync(target, policyPath);
    });
  });

  it("patches only the version-bound guard after unconditional denials (#9528)", () => {
    const result = patchSource(sourceFixture);

    expect(result.status, result.stderr).toBe(0);
    expect(result.patched).toContain(
      "from tools.nemoclaw_unattended_approval import reviewed_unattended_action_decision",
    );
    const context = result.patched.indexOf("reviewed_action =");
    const containerSkip = result.patched.indexOf("if _should_skip_container_guards(");
    const deny = result.patched.indexOf("return _user_deny_block_result(deny_pattern)");
    const reviewed = result.patched.indexOf("if reviewed_context:");
    const yolo = result.patched.indexOf("# --yolo or approvals.mode=off");
    expect(context).toBeLessThan(containerSkip);
    expect(deny).toBeLessThan(reviewed);
    expect(reviewed).toBeLessThan(yolo);
    expect(result.patched.match(/reviewed_unattended_action_decision\(/gu)).toHaveLength(1);
  });

  it("executes the patched guard only in the reviewed local API context (#9528)", () => {
    const patched = patchSource(sourceFixture);
    expect(patched.status, patched.stderr).toBe(0);
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-patched-approval-"));
    const sourcePath = path.join(directory, "approval.py");
    fs.writeFileSync(sourcePath, patched.patched);
    const harness = `\
import importlib.util
import json
import sys
import types

tools = types.ModuleType("tools")
tools.__path__ = []
interrupt = types.ModuleType("tools.interrupt")
interrupt.is_interrupted = lambda: False
reviewed = types.ModuleType("tools.nemoclaw_unattended_approval")
command = "/usr/local/lib/nemoclaw/hermes-wikidata-reference-read"
reviewed.reviewed_unattended_action_decision = lambda candidate, platform: (
    ("allow" if platform == "api_server" else "deny") if candidate == command else None
)
sys.modules["tools"] = tools
sys.modules["tools.interrupt"] = interrupt
sys.modules["tools.nemoclaw_unattended_approval"] = reviewed

spec = importlib.util.spec_from_file_location("patched_approval", sys.argv[1])
assert spec and spec.loader
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
module.logger = types.SimpleNamespace(warning=lambda *_args, **_kwargs: None)
module._hardline_block_result = lambda _description: {"approved": False}
module._sudo_stdin_block_result = lambda _description: {"approved": False}
module._user_deny_block_result = lambda _pattern: {"approved": False}

cases = json.loads(sys.argv[2])
observed = []
for case in cases:
    module._get_session_platform = lambda case=case: case["platform"]
    module._is_gateway_approval_context = lambda case=case: case["gateway"]
    module.env_var_enabled = lambda name, case=case: (
        name == "HERMES_CRON_SESSION" and case["cron"]
    )
    module._should_skip_container_guards = lambda env_type, has_host_access=False: (
        env_type == "docker" and not has_host_access
    )
    module.detect_hardline_command = lambda _command, case=case: (
        case.get("hardline", False), "blocked"
    )
    module._check_sudo_stdin_guard = lambda _command: (False, "")
    module._match_user_deny_rule = lambda _command, case=case: (
        "*" if case.get("user_deny", False) else None
    )
    decision = module.check_all_command_guards(
        case.get("command", command),
        case["env_type"],
        has_host_access=case["host_access"],
    )
    observed.append(bool(decision.get("approved")))
print(json.dumps(observed))
`;
    const cases = [
      {
        platform: "api_server",
        gateway: true,
        cron: false,
        env_type: "local",
        host_access: false,
      },
      {
        platform: "api_server",
        gateway: true,
        cron: true,
        env_type: "local",
        host_access: false,
      },
      {
        platform: "api_server",
        gateway: true,
        cron: false,
        env_type: "ssh",
        host_access: false,
      },
      {
        platform: "api_server",
        gateway: true,
        cron: false,
        env_type: "docker",
        host_access: true,
      },
      {
        platform: "api_server",
        gateway: true,
        cron: false,
        env_type: "docker",
        host_access: false,
      },
      {
        platform: "slack",
        gateway: true,
        cron: false,
        env_type: "local",
        host_access: false,
      },
      {
        platform: "api_server",
        gateway: false,
        cron: false,
        env_type: "local",
        host_access: false,
      },
      {
        platform: "api_server",
        gateway: true,
        cron: false,
        env_type: "local",
        host_access: false,
        hardline: true,
      },
      {
        platform: "api_server",
        gateway: true,
        cron: false,
        env_type: "local",
        host_access: false,
        user_deny: true,
      },
      {
        command: "printf safe",
        platform: "slack",
        gateway: true,
        cron: false,
        env_type: "docker",
        host_access: false,
      },
    ];
    try {
      const result = spawnSync(
        "python3",
        ["-I", "-c", harness, sourcePath, JSON.stringify(cases)],
        {
          encoding: "utf8",
          timeout: 5000,
        },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual([
        true,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        true,
      ]);
    } finally {
      fs.rmSync(directory, { force: true, recursive: true });
    }
  });

  it("rejects an unreviewed Hermes version or approval source shape (#9528)", () => {
    expect(patchSource(sourceFixture, "0.20.0").status).toBe(1);
    expect(patchSource(sourceFixture.replace("# --yolo", "# changed")).status).toBe(1);
  });
});
