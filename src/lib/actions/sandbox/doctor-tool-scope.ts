// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `doctor` diagnostics for late OpenClaw dashboard/tool-call device-scope
 * approvals (#4616).
 *
 * The reported symptom is "cron job creation fails" / "Tool exec not found",
 * but the underlying failure is broader: an OpenClaw tool subprocess inherits
 * `OPENCLAW_GATEWAY_URL=ws://127.0.0.1:<dashboardPort>`, opens a connection
 * that requests a scope upgrade, and the upgrade never gets approved — so the
 * gateway closes the socket (1006 abnormal closure) and OpenShell logs a
 * loopback policy denial to `127.0.0.1:<dashboardPort>`. Dashboard-only users
 * never run `nemoclaw connect`, so the connect-time approval pass never runs
 * and the pending upgrade sits forever once the in-sandbox auto-pair watcher
 * has exited.
 *
 * This module adds a read-only in-sandbox probe that surfaces the actual
 * blocker (pending allowlisted scope upgrades, gateway 1006, scope-upgrade
 * pending, loopback denial, auto-pair watcher state) and points the user at
 * `doctor --fix`, which runs the same narrow allowlisted approval pass that
 * `connect` runs. See `auto-pair-approval.ts` for the repair side.
 */

import { readAutoPairApprovalPolicyModule } from "./auto-pair-approval";

export type DoctorToolScopeStatus = "ok" | "warn" | "fail" | "info";

export type DoctorToolScopeCheck = {
  group: string;
  label: string;
  status: DoctorToolScopeStatus;
  detail: string;
  hint?: string;
};

const TOOL_SCOPE_GROUP = "Gateway";
const TOOL_SCOPE_LABEL = "Tool-call device scope";

export type ToolScopeProbe = {
  ok: boolean;
  devicesListOk: boolean;
  pendingTotal: number;
  pendingAllowlisted: number;
  pendingUnknown: number;
  watcherActive: boolean;
  dashboardPort: number | null;
  signals: {
    gateway1006: boolean;
    scopePending: boolean;
    loopbackDenied: boolean;
    watcherDeadline: boolean;
    rejectedClients: number;
  };
};

export type SandboxExecResult = { status: number; stdout: string; stderr: string } | null;
export type SandboxExec = (sandboxName: string, script: string) => SandboxExecResult;

const PROBE_MARKER = "__NEMOCLAW_TOOL_SCOPE_PROBE__";

/**
 * Build the read-only in-sandbox probe script. It sources the proxy env so the
 * gateway-pinned `openclaw devices list` sees the live gateway, classifies the
 * pending requests with the shared approval policy, scans the gateway and
 * auto-pair logs for the #4616 signatures, and prints a single JSON line
 * prefixed with PROBE_MARKER. It never approves anything.
 */
export function buildToolScopeProbeScript(approvalPolicyModuleB64: string): string {
  return `
PROXY_ENV=/tmp/nemoclaw-proxy-env.sh
[ -r "$PROXY_ENV" ] && . "$PROXY_ENV"
command -v python3 >/dev/null 2>&1 || { echo '${PROBE_MARKER}{"ok": false}'; exit 0; }
OPENCLAW_BIN="$(command -v openclaw 2>/dev/null || echo openclaw)" \
NEMOCLAW_APPROVAL_POLICY_B64=${approvalPolicyModuleB64 ? `'${approvalPolicyModuleB64}'` : "''"} \
NEMOCLAW_TOOL_SCOPE_MARKER='${PROBE_MARKER}' python3 - <<'PYPROBE'
import base64
import json
import os
import re
import subprocess

MARKER = os.environ.get('NEMOCLAW_TOOL_SCOPE_MARKER', '')


def emit(payload):
    print(MARKER + json.dumps(payload, sort_keys=True))


result = {
    'ok': True,
    'devicesListOk': False,
    'pendingTotal': 0,
    'pendingAllowlisted': 0,
    'pendingUnknown': 0,
    'watcherActive': False,
    'dashboardPort': None,
    'signals': {
        'gateway1006': False,
        'scopePending': False,
        'loopbackDenied': False,
        'watcherDeadline': False,
        'rejectedClients': 0,
    },
}

# Dashboard/gateway port the tool subprocess connects back to.
port = ''
for key in ('OPENCLAW_GATEWAY_PORT', 'NEMOCLAW_DASHBOARD_PORT'):
    raw = os.environ.get(key, '').strip()
    if raw.isdigit():
        port = raw
        break
if not port:
    url = os.environ.get('OPENCLAW_GATEWAY_URL', '')
    m = re.search(r':(\\d+)', url)
    if m:
        port = m.group(1)
if port.isdigit():
    result['dashboardPort'] = int(port)

# Classify pending device requests with the shared approval policy.
approval_request_decision = None
try:
    policy_source = base64.b64decode(
        os.environ.get('NEMOCLAW_APPROVAL_POLICY_B64', ''), validate=True,
    ).decode('utf-8')
    policy_globals = {}
    exec(compile(policy_source, 'openclaw_device_approval_policy.py', 'exec'), policy_globals)
    approval_request_decision = policy_globals.get('approval_request_decision')
except Exception:
    approval_request_decision = None

openclaw = os.environ.get('OPENCLAW_BIN', 'openclaw')
try:
    proc = subprocess.run(
        [openclaw, 'devices', 'list', '--json'],
        capture_output=True, text=True, timeout=5,
    )
    if proc.returncode == 0 and proc.stdout.strip():
        data = json.loads(proc.stdout)
        if isinstance(data, dict):
            pending = data.get('pending')
            if isinstance(pending, list):
                result['devicesListOk'] = True
                for device in pending:
                    if not isinstance(device, dict):
                        continue
                    result['pendingTotal'] += 1
                    allowed = False
                    if approval_request_decision is not None:
                        try:
                            allowed = bool(approval_request_decision(device).get('allowed'))
                        except Exception:
                            allowed = False
                    if allowed:
                        result['pendingAllowlisted'] += 1
                    else:
                        result['pendingUnknown'] += 1
except Exception:
    pass


def tail_text(path, limit=400, max_bytes=131072):
    # /tmp/gateway.log and /tmp/auto-pair.log are never truncated, so read only
    # the last max_bytes from the end instead of loading the whole file: bounds
    # both memory and the time spent inside the 15s sandbox-exec budget.
    try:
        with open(path, 'rb') as handle:
            handle.seek(0, 2)
            size = handle.tell()
            handle.seek(max(0, size - max_bytes))
            data = handle.read()
        return data.decode('utf-8', 'replace').splitlines(keepends=True)[-limit:]
    except Exception:
        return []


gateway_lines = tail_text('/tmp/gateway.log')
auto_pair_lines = tail_text('/tmp/auto-pair.log')
gateway_blob = ''.join(gateway_lines)
auto_pair_blob = ''.join(auto_pair_lines)

if re.search(r'1006|abnormal closure', gateway_blob, re.IGNORECASE):
    result['signals']['gateway1006'] = True
if re.search(r'scope upgrade pending approval', gateway_blob + auto_pair_blob, re.IGNORECASE):
    result['signals']['scopePending'] = True
if port:
    denial = re.compile(
        r'(DENIED|not in policy).*127\\.0\\.0\\.1:' + re.escape(port),
        re.IGNORECASE,
    )
    alt = re.compile(
        r'127\\.0\\.0\\.1:' + re.escape(port) + r'.*(DENIED|not in policy)',
        re.IGNORECASE,
    )
    for line in gateway_lines:
        if denial.search(line) or alt.search(line):
            result['signals']['loopbackDenied'] = True
            break
if '[auto-pair] watcher deadline reached' in auto_pair_blob:
    result['signals']['watcherDeadline'] = True
result['signals']['rejectedClients'] = auto_pair_blob.count('[auto-pair] rejected')

# Auto-pair watcher liveness: a live python3 whose stdout/stderr is the
# auto-pair log. Mirrors the e2e watcher-inactivity probe.
watcher_active = False
try:
    for entry in os.listdir('/proc'):
        if not entry.isdigit():
            continue
        try:
            with open('/proc/%s/cmdline' % entry, 'rb') as handle:
                cmd = handle.read().replace(b'\\x00', b' ').decode('utf-8', 'replace')
        except Exception:
            continue
        if 'python3' not in cmd:
            continue
        for fd in ('1', '2'):
            try:
                target = os.readlink('/proc/%s/fd/%s' % (entry, fd))
            except Exception:
                continue
            if target == '/tmp/auto-pair.log':
                watcher_active = True
                break
        if watcher_active:
            break
except Exception:
    watcher_active = False
result['watcherActive'] = watcher_active

emit(result)
PYPROBE
exit 0
`;
}

/** Extract and parse the probe's JSON payload from raw stdout. */
export function parseToolScopeProbe(raw: string): ToolScopeProbe | null {
  if (!raw) return null;
  const idx = raw.lastIndexOf(PROBE_MARKER);
  if (idx < 0) return null;
  const jsonStart = idx + PROBE_MARKER.length;
  const newline = raw.indexOf("\n", jsonStart);
  const slice = (newline === -1 ? raw.slice(jsonStart) : raw.slice(jsonStart, newline)).trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(slice);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  if (obj.ok === false) {
    return {
      ok: false,
      devicesListOk: false,
      pendingTotal: 0,
      pendingAllowlisted: 0,
      pendingUnknown: 0,
      watcherActive: false,
      dashboardPort: null,
      signals: {
        gateway1006: false,
        scopePending: false,
        loopbackDenied: false,
        watcherDeadline: false,
        rejectedClients: 0,
      },
    };
  }
  const signals = (obj.signals && typeof obj.signals === "object" ? obj.signals : {}) as Record<
    string,
    unknown
  >;
  const num = (value: unknown): number =>
    typeof value === "number" && Number.isFinite(value) ? value : 0;
  return {
    ok: obj.ok !== false,
    devicesListOk: obj.devicesListOk === true,
    pendingTotal: num(obj.pendingTotal),
    pendingAllowlisted: num(obj.pendingAllowlisted),
    pendingUnknown: num(obj.pendingUnknown),
    watcherActive: obj.watcherActive === true,
    dashboardPort:
      typeof obj.dashboardPort === "number" && Number.isFinite(obj.dashboardPort)
        ? obj.dashboardPort
        : null,
    signals: {
      gateway1006: signals.gateway1006 === true,
      scopePending: signals.scopePending === true,
      loopbackDenied: signals.loopbackDenied === true,
      watcherDeadline: signals.watcherDeadline === true,
      rejectedClients: num(signals.rejectedClients),
    },
  };
}

export type ToolScopeInterpretOptions = {
  sandboxName: string;
  cliName: string;
  wantsFix: boolean;
  /** Outcome of the `--fix` approval pass, when it ran. */
  fix?: { reported: boolean; approved: number };
};

function fixHint(cliName: string, sandboxName: string): string {
  return `run \`${cliName} ${sandboxName} doctor --fix\` to approve pending dashboard/CLI tool-scope upgrades without an SSH connect`;
}

/**
 * Turn a probe (and an optional `--fix` outcome) into doctor checks. Pure so it
 * can be unit-tested without a live sandbox.
 */
export function interpretToolScopeProbe(
  probe: ToolScopeProbe | null,
  options: ToolScopeInterpretOptions,
): DoctorToolScopeCheck[] {
  const { sandboxName, cliName, wantsFix, fix } = options;
  const checks: DoctorToolScopeCheck[] = [];

  if (!probe || !probe.ok) {
    checks.push({
      group: TOOL_SCOPE_GROUP,
      label: TOOL_SCOPE_LABEL,
      status: "info",
      detail: "tool-scope diagnostics unavailable (sandbox not reachable)",
    });
    return checks;
  }

  const sig = probe.signals;
  const symptomParts: string[] = [];
  if (sig.gateway1006) symptomParts.push("gateway closed 1006");
  if (sig.scopePending) symptomParts.push("scope upgrade pending approval");
  if (sig.loopbackDenied) {
    const portText = probe.dashboardPort ? `127.0.0.1:${probe.dashboardPort}` : "the dashboard port";
    symptomParts.push(`policy denial to ${portText}`);
  }

  // When --fix just approved something, lead with the repair outcome.
  if (wantsFix && fix?.reported && fix.approved > 0) {
    checks.push({
      group: TOOL_SCOPE_GROUP,
      label: `${TOOL_SCOPE_LABEL} (repair)`,
      status: "ok",
      detail: `approved ${fix.approved} pending tool-scope upgrade(s)`,
    });
  }

  // Current device-list state is authoritative over log signatures. The gateway
  // and auto-pair logs are never truncated, so a just-completed `doctor --fix`
  // (or any older incident) leaves stale 1006/scope-pending/denial lines behind;
  // keying off them would re-warn with another `--fix` hint even though nothing
  // is pending. So when the device list is readable, decide from it and use the
  // log symptoms only as supporting detail on the actionable failure.
  if (probe.devicesListOk) {
    // Primary actionable signal: pending allowlisted scope upgrades that --fix
    // can repair. After a successful fix the re-probe shows 0.
    if (probe.pendingAllowlisted > 0) {
      const watcherNote = probe.watcherActive
        ? ""
        : "; the in-sandbox auto-pair watcher is not running";
      const detail =
        `${probe.pendingAllowlisted} pending allowlisted tool-scope upgrade(s) blocking OpenClaw tool calls` +
        (symptomParts.length ? ` (${symptomParts.join("; ")})` : "") +
        watcherNote;
      checks.push({
        group: TOOL_SCOPE_GROUP,
        label: TOOL_SCOPE_LABEL,
        status: "fail",
        detail,
        hint: fixHint(cliName, sandboxName),
      });
      return checks;
    }

    // Pending requests exist but none are allowlisted — do NOT auto-approve;
    // they are unknown clients that the operator must review explicitly.
    if (probe.pendingUnknown > 0) {
      checks.push({
        group: TOOL_SCOPE_GROUP,
        label: TOOL_SCOPE_LABEL,
        status: "warn",
        detail: `${probe.pendingUnknown} pending device request(s) from non-allowlisted clients; not auto-approved`,
        hint: `review with \`openclaw devices list\` inside \`${cliName} ${sandboxName} connect\` before approving`,
      });
      return checks;
    }

    // Nothing pending — healthy, regardless of stale log lines.
    checks.push({
      group: TOOL_SCOPE_GROUP,
      label: TOOL_SCOPE_LABEL,
      status: "ok",
      detail: "no pending tool-scope approvals",
    });
    return checks;
  }

  // Device list unreadable: we cannot confirm pending state, so fall back to the
  // log signature. When it shows the #4616 signature, surface it so the user
  // knows tools were blocked by device scope, not by cron or a missing package.
  // Do NOT hint `doctor --fix` here: the approval pass only runs when the device
  // list is readable with an allowlisted backlog, so `--fix` would dead-end on
  // this same branch. An unreadable device list points at gateway health, so
  // steer the user to recover the gateway and re-probe instead.
  if (symptomParts.length > 0) {
    checks.push({
      group: TOOL_SCOPE_GROUP,
      label: TOOL_SCOPE_LABEL,
      status: "warn",
      detail:
        `recent OpenClaw tool-scope failure in logs (${symptomParts.join("; ")}); ` +
        "could not read the device list to confirm pending approvals",
      hint:
        `recover the gateway with \`${cliName} ${sandboxName} recover\`, ` +
        `then re-run \`${cliName} ${sandboxName} doctor --fix\` to approve any pending tool-scope upgrades`,
    });
    return checks;
  }

  checks.push({
    group: TOOL_SCOPE_GROUP,
    label: TOOL_SCOPE_LABEL,
    status: "info",
    detail: "could not read OpenClaw device list from the sandbox",
  });
  return checks;
}

export type BuildToolScopeChecksDeps = {
  exec: SandboxExec;
  /** Repair callback used when wantsFix is set; defaults wired by the caller. */
  runApprovalPass?: (sandboxName: string) => { reported: boolean; approved: number };
  readPolicyModule?: () => string | null;
};

/**
 * Orchestrate the probe, the optional `--fix` repair, and a re-probe, returning
 * doctor checks. The exec/repair/policy dependencies are injected for testing.
 */
export function buildToolScopeChecks(
  sandboxName: string,
  cliName: string,
  wantsFix: boolean,
  deps: BuildToolScopeChecksDeps,
): DoctorToolScopeCheck[] {
  const readPolicy = deps.readPolicyModule ?? readAutoPairApprovalPolicyModule;
  const policyModule = readPolicy();
  const policyModuleB64 = policyModule
    ? Buffer.from(policyModule, "utf-8").toString("base64")
    : "";
  const script = buildToolScopeProbeScript(policyModuleB64);

  const firstRaw = deps.exec(sandboxName, script);
  const firstProbe = parseToolScopeProbe(firstRaw?.stdout ?? "");

  // Only repair when --fix is set AND the probe shows an allowlisted backlog.
  // Avoids running an approval pass when there is nothing to approve.
  if (
    wantsFix &&
    deps.runApprovalPass &&
    firstProbe &&
    firstProbe.ok &&
    firstProbe.devicesListOk &&
    firstProbe.pendingAllowlisted > 0
  ) {
    const passResult = deps.runApprovalPass(sandboxName);
    const secondRaw = deps.exec(sandboxName, script);
    const secondProbe = parseToolScopeProbe(secondRaw?.stdout ?? "") ?? firstProbe;
    // Derive the repaired count from the pending delta rather than the approval
    // pass's self-report: OpenClaw's local-fallback `devices approve` can apply
    // the upgrade server-side after the bounded client subprocess has already
    // timed out, so the delta is the authoritative "net cleared" signal.
    const repaired = Math.max(
      0,
      firstProbe.pendingAllowlisted - secondProbe.pendingAllowlisted,
    );
    const fix = { reported: repaired > 0 || passResult.reported, approved: repaired };
    return interpretToolScopeProbe(secondProbe, { sandboxName, cliName, wantsFix, fix });
  }

  return interpretToolScopeProbe(firstProbe, { sandboxName, cliName, wantsFix });
}
