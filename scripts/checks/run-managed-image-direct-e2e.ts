#!/usr/bin/env -S node --no-warnings --experimental-strip-types

// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  createManagedBootstrapIdentity,
  renderManagedBootstrapHeldCommand,
} from "../../src/lib/onboard/managed-bootstrap/adapter.ts";
import {
  MANAGED_BOOTSTRAP_REQUEST_FILE,
  serializeManagedBootstrapEnvelopeTar,
} from "../../src/lib/onboard/managed-bootstrap/envelope.ts";
import {
  managedImageRuntimeIdentity,
  SHIPPED_MANAGED_IMAGE_AGENTS,
  type ShippedManagedImageAgent,
} from "../../src/lib/onboard/managed-image/contract.ts";
import { MANAGED_STARTUP_EXECUTABLE } from "../../src/lib/onboard/managed-startup/hold.ts";
import { encodeManagedStartupProfile } from "../../src/lib/onboard/managed-startup/profile.ts";
import {
  createManagedStartupRootApplyRequest,
  type ManagedStartupRootApplyRequest,
  serializeManagedStartupRootApplyRequest,
} from "../../src/lib/onboard/managed-startup/root-apply.ts";
import {
  MANAGED_STARTUP_E2E_CORPORATE_CA_PEM,
  managedStartupE2eProfile,
} from "./generate-managed-startup-profile-fixture.mts";
import type { ProtectedManagedImagePlatform } from "./protected-managed-image-contract.ts";

const CONTAINER_ID_RE = /^[a-f0-9]{64}$/u;
const IMMUTABLE_IMAGE_RE = /^sha256:[a-f0-9]{64}$/u;
const IMMUTABLE_REFERENCE_RE = /^(?:sha256:[a-f0-9]{64}|[^\s@]+@sha256:[a-f0-9]{64})$/u;
const MANAGED_BOOTSTRAP = "/usr/local/bin/nemoclaw-managed-bootstrap";
const MANAGED_BOOTSTRAP_BODY = "/usr/local/lib/nemoclaw/managed-bootstrap-trampoline.sh";
const RUNTIME = "/usr/local/lib/nemoclaw/managed-startup-image-runtime.cjs";
const FIXED_ROOT_ENV = [
  "HOME=/root",
  "LANG=C.UTF-8",
  "LC_ALL=C.UTF-8",
  "NEMOCLAW_MANAGED_IMAGE_CAPABILITY_UNION=1",
  "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
] as const;

export interface ManagedImageDirectE2eInputs {
  readonly agent: ShippedManagedImageAgent;
  readonly image: string;
  readonly platform: ProtectedManagedImagePlatform;
}

interface CommandResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface ContainerInspect {
  readonly Id?: string;
  readonly Image?: string;
  readonly Config?: {
    readonly Cmd?: readonly string[] | null;
    readonly Entrypoint?: readonly string[] | null;
    readonly Env?: readonly string[] | null;
  } | null;
  readonly State?: {
    readonly Running?: boolean;
  } | null;
}

function requiredArgument(argv: readonly string[], flag: string): string {
  const index = argv.indexOf(flag);
  const value = index >= 0 ? argv[index + 1] : undefined;
  if (!value || value.startsWith("--")) throw new Error(`${flag} is required`);
  return value;
}

export function parseManagedImageDirectE2eInputs(
  argv: readonly string[],
): ManagedImageDirectE2eInputs {
  const agent = requiredArgument(argv, "--agent");
  const image = requiredArgument(argv, "--image");
  const platform = requiredArgument(argv, "--platform");
  const knownFlags = new Set(["--agent", "--image", "--platform"]);
  if (argv.length !== 6 || argv.some((value, index) => index % 2 === 0 && !knownFlags.has(value))) {
    throw new Error(
      "usage: --agent <agent> --image <immutable> --platform <linux/amd64|linux/arm64>",
    );
  }
  if (!(SHIPPED_MANAGED_IMAGE_AGENTS as readonly string[]).includes(agent)) {
    throw new Error("--agent must identify a shipped managed-image agent");
  }
  if (!IMMUTABLE_REFERENCE_RE.test(image)) {
    throw new Error("--image must be an immutable image ID or digest reference");
  }
  if (platform !== "linux/amd64" && platform !== "linux/arm64") {
    throw new Error("--platform must be linux/amd64 or linux/arm64");
  }
  return { agent: agent as ShippedManagedImageAgent, image, platform };
}

function commandDetail(result: CommandResult): string {
  return `${result.stderr} ${result.stdout}`.trim().slice(-2000);
}

function docker(
  args: readonly string[],
  options: {
    readonly ignoreError?: boolean;
    readonly input?: string | Buffer;
    readonly timeout?: number;
  } = {},
): CommandResult {
  const result = spawnSync("docker", [...args], {
    encoding: "utf8",
    input: options.input,
    maxBuffer: 16 * 1024 * 1024,
    timeout: options.timeout ?? 120_000,
  });
  const normalized = {
    status: Number(result.status ?? 1),
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? result.error?.message ?? ""),
  };
  if (normalized.status !== 0 && options.ignoreError !== true) {
    throw new Error(`docker ${args[0] ?? "command"} failed: ${commandDetail(normalized)}`);
  }
  return normalized;
}

function requestFor(agent: ShippedManagedImageAgent, changed = false): ManagedStartupRootApplyRequest {
  return createManagedStartupRootApplyRequest({
    agent,
    encodedProfile: encodeManagedStartupProfile(
      managedStartupE2eProfile(agent, changed, true, true),
    ),
    corporateCaB64: Buffer.from(MANAGED_STARTUP_E2E_CORPORATE_CA_PEM, "utf8").toString("base64"),
  });
}

function rootRuntimeArgs(
  containerId: string,
  agent: ShippedManagedImageAgent,
  action: "--apply-root-stdin" | "--commit-shared-state-transaction",
  user = "0:0",
  bootstrapIdentity?: string,
): string[] {
  return [
    "exec",
    ...(action === "--apply-root-stdin" ? ["--interactive"] : []),
    "--user",
    user,
    "--workdir",
    "/",
    containerId,
    "/usr/bin/env",
    "-i",
    ...FIXED_ROOT_ENV,
    "/usr/local/bin/node",
    RUNTIME,
    action,
    "--agent",
    agent,
    ...(bootstrapIdentity ? ["--bootstrap-identity", bootstrapIdentity] : []),
  ];
}

function stageManagedBootstrapEnvelope(
  containerId: string,
  bootstrapIdentity: string,
  request: ManagedStartupRootApplyRequest,
): void {
  docker(["cp", "-", `${containerId}:/`], {
    input: serializeManagedBootstrapEnvelopeTar({
      bootstrapIdentity,
      rootApplyRequest: request,
    }),
  });
}

function verifyManagedBootstrapPidOneBoundary(
  input: ManagedImageDirectE2eInputs,
  request: ManagedStartupRootApplyRequest,
  bootstrapIdentity: string,
  sandboxUid: string,
  sandboxGid: string,
): void {
  const marker = "/tmp/nemoclaw-managed-pid1-resumed";
  let containerId = "";
  try {
    containerId = docker([
      "create",
      "--platform",
      input.platform,
      "--network",
      "none",
      "--user",
      "root",
      "--entrypoint",
      MANAGED_BOOTSTRAP,
      input.image,
      "--agent",
      input.agent,
      "--profile-fingerprint",
      request.profileFingerprint,
      "--bootstrap-identity",
      bootstrapIdentity,
      "--agent-uid",
      sandboxUid,
      "--agent-gid",
      sandboxGid,
      "--agent-workdir",
      "/sandbox",
      "--request-file",
      MANAGED_BOOTSTRAP_REQUEST_FILE,
      "--",
      "/bin/sh",
      "-eu",
      "-c",
      `printf 'resumed\\n' > ${marker}; exec /usr/bin/tail -f /dev/null`,
    ]).stdout.trim();
    if (!CONTAINER_ID_RE.test(containerId)) {
      throw new Error("docker create did not return one exact PID 1 bootstrap container");
    }
    docker(["cp", "-", `${containerId}:/`], {
      input: serializeManagedBootstrapEnvelopeTar({
        bootstrapIdentity,
        rootApplyRequest: request,
      }),
    });
    docker(["start", containerId]);

    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      const resumed = docker(["exec", "--user", "0:0", containerId, "test", "-s", marker], {
        ignoreError: true,
        timeout: 15_000,
      });
      if (resumed.status === 0) {
        process.stdout.write(
          `Validated exact ${input.agent} managed image through stopped-container PID 1 bootstrap.\n`,
        );
        return;
      }
      const running = docker(["inspect", "--format", "{{.State.Running}}", containerId], {
        ignoreError: true,
        timeout: 15_000,
      });
      if (running.status !== 0 || running.stdout.trim() !== "true") {
        const state = docker(["inspect", "--format", "{{json .State}}", containerId], {
          ignoreError: true,
          timeout: 15_000,
        });
        const logs = docker(["logs", containerId], { ignoreError: true, timeout: 15_000 });
        throw new Error(
          `managed bootstrap PID 1 exited before supervisor resume: ${commandDetail(state)} ${commandDetail(logs)}`,
        );
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
    }
    throw new Error("managed bootstrap PID 1 did not resume the supervisor");
  } finally {
    if (CONTAINER_ID_RE.test(containerId)) {
      docker(["rm", "-f", containerId], { ignoreError: true, timeout: 30_000 });
    }
  }
}

function managedConfig(agent: ShippedManagedImageAgent): string {
  switch (agent) {
    case "openclaw":
      return "/sandbox/.openclaw/openclaw.json";
    case "hermes":
      return "/sandbox/.hermes/config.yaml";
    case "langchain-deepagents-code":
      return "/sandbox/.deepagents/config.toml";
  }
}

function waitForAgentCommand(containerId: string): void {
  // The image-owned hold allows up to 600 seconds for managed startup
  // completion. Keep this observer from abandoning a still-running container
  // before that bounded product wait can finish.
  const deadline = Date.now() + 600_000;
  while (Date.now() < deadline) {
    const ready = docker(
      [
        "exec",
        "--user",
        "0:0",
        containerId,
        "/bin/sh",
        "-eu",
        "-c",
        "test -s /tmp/nemoclaw-managed-command-uid && test -s /run/nemoclaw/managed-startup-complete.json",
      ],
      { ignoreError: true, timeout: 15_000 },
    );
    if (ready.status === 0) return;
    const running = docker(["inspect", "--format", "{{.State.Running}}", containerId], {
      ignoreError: true,
      timeout: 15_000,
    });
    if (running.status !== 0 || running.stdout.trim() !== "true") {
      const logs = docker(["logs", containerId], { ignoreError: true, timeout: 15_000 });
      throw new Error(`managed image exited before agent command: ${commandDetail(logs)}`);
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
  }
  throw new Error("managed image did not reach the forwarded sandbox command");
}

function exactProxyEnvironment(): string {
  return [
    "HTTP_PROXY=http://10.200.0.1:3128",
    "HTTPS_PROXY=http://10.200.0.1:3128",
    "NO_PROXY=localhost,127.0.0.1,::1,10.200.0.1",
    "http_proxy=http://10.200.0.1:3128",
    "https_proxy=http://10.200.0.1:3128",
    "no_proxy=localhost,127.0.0.1,::1,10.200.0.1",
  ].join("\n");
}

function verifyManagedBootstrapNativeBoundary(
  containerId: string,
  platform: ManagedImageDirectE2eInputs["platform"],
): void {
  docker([
    "exec",
    "--user",
    "0:0",
    containerId,
    "/bin/sh",
    "-eu",
    "-c",
    [
      `test -f ${MANAGED_BOOTSTRAP}`,
      `test ! -L ${MANAGED_BOOTSTRAP}`,
      `test "$(stat -c '%u:%g:%a' ${MANAGED_BOOTSTRAP})" = '0:0:755'`,
      `test -f ${MANAGED_BOOTSTRAP_BODY}`,
      `test ! -L ${MANAGED_BOOTSTRAP_BODY}`,
      `test "$(stat -c '%u:%g:%a' ${MANAGED_BOOTSTRAP_BODY})" = '0:0:444'`,
      `test ! -x ${MANAGED_BOOTSTRAP_BODY}`,
    ].join("\n"),
  ]);

  const expectedMachine = platform === "linux/amd64" ? 62 : 183;
  docker([
    "exec",
    "--user",
    "0:0",
    containerId,
    "/usr/local/bin/node",
    "-e",
    `
const fs = require("node:fs");
const image = fs.readFileSync(${JSON.stringify(MANAGED_BOOTSTRAP)});
const fail = (detail) => { throw new Error("invalid managed bootstrap ELF: " + detail); };
if (image.length < 64) fail("truncated header");
if (image.subarray(0, 4).toString("hex") !== "7f454c46") fail("magic");
if (image[4] !== 2 || image[5] !== 1 || image[6] !== 1) fail("class, byte order, or version");
if (image.readUInt16LE(16) !== 2) fail("not an executable file");
if (image.readUInt16LE(18) !== Number(process.argv[1])) fail("wrong target architecture");
const programOffset = Number(image.readBigUInt64LE(32));
const programEntrySize = image.readUInt16LE(54);
const programCount = image.readUInt16LE(56);
if (!Number.isSafeInteger(programOffset) || programEntrySize < 56) fail("program header bounds");
if (programOffset + programEntrySize * programCount > image.length) fail("truncated program headers");
for (let index = 0; index < programCount; index += 1) {
  const type = image.readUInt32LE(programOffset + index * programEntrySize);
  if (type === 2) fail("dynamic segment");
  if (type === 3) fail("interpreter segment");
}
`,
    String(expectedMachine),
  ]);

  const smoke = docker(["exec", "--user", "0:0", containerId, MANAGED_BOOTSTRAP], {
    ignoreError: true,
    timeout: 30_000,
  });
  if (
    smoke.status === 0 ||
    !smoke.stderr.includes(
      "[SECURITY] Managed bootstrap trampoline: managed bootstrap arguments are incomplete",
    )
  ) {
    throw new Error(`managed bootstrap native smoke failed: ${commandDetail(smoke)}`);
  }
}

export function runManagedImageDirectE2e(input: ManagedImageDirectE2eInputs): void {
  const request = requestFor(input.agent);
  const payload = serializeManagedStartupRootApplyRequest(request);
  const bootstrapIdentity = createManagedBootstrapIdentity();
  const expectedImageId = docker([
    "image",
    "inspect",
    "--format",
    "{{.Id}}",
    input.image,
  ]).stdout.trim();
  if (!IMMUTABLE_IMAGE_RE.test(expectedImageId)) {
    throw new Error("managed image reference did not resolve to one immutable local image ID");
  }
  const finalCommand = [
    "if [ -x /usr/local/bin/dcode ]; then",
    '  timeout 10 /usr/local/bin/dcode -n "" > /tmp/nemoclaw-managed-dcode-empty-prompt-output 2>&1',
    '  printf "%s\\n" "$?" > /tmp/nemoclaw-managed-dcode-empty-prompt-status',
    "fi",
    "id -u > /tmp/nemoclaw-managed-command-uid",
    "{",
    '  printf "HTTP_PROXY=%s\\n" "${HTTP_PROXY-__UNSET__}"',
    '  printf "HTTPS_PROXY=%s\\n" "${HTTPS_PROXY-__UNSET__}"',
    '  printf "NO_PROXY=%s\\n" "${NO_PROXY-__UNSET__}"',
    '  printf "http_proxy=%s\\n" "${http_proxy-__UNSET__}"',
    '  printf "https_proxy=%s\\n" "${https_proxy-__UNSET__}"',
    '  printf "no_proxy=%s\\n" "${no_proxy-__UNSET__}"',
    "} > /tmp/nemoclaw-managed-command-proxy-env",
    "exec /usr/bin/tail -f /dev/null",
  ].join("\n");
  const heldWorkloadArgv = renderManagedBootstrapHeldCommand(request, bootstrapIdentity, [
    "env",
    MANAGED_STARTUP_EXECUTABLE,
    "/bin/sh",
    "-c",
    finalCommand,
  ]);
  if (heldWorkloadArgv[0] !== "env") {
    throw new Error("production managed hold renderer did not preserve the env launcher");
  }
  let containerId = "";
  try {
    // Mirror the supported OpenShell split: the image OCI user is root for its
    // supervisor, while the supervisor enters the sandbox startup command as
    // sandbox:sandbox.
    containerId = docker([
      "run",
      "-d",
      "--platform",
      input.platform,
      "--network",
      "none",
      "--user",
      "sandbox",
      "--env",
      "HTTP_PROXY=http://upper-http:upper-secret@upper-http.example.test:18080",
      "--env",
      "HTTPS_PROXY=http://upper-https:upper-secret@upper-https.example.test:18443",
      "--env",
      "NO_PROXY=upper.internal",
      "--env",
      "http_proxy=http://lower-http:lower-secret@lower-http.example.test:28080",
      "--env",
      "https_proxy=http://lower-https:lower-secret@lower-https.example.test:28443",
      "--env",
      "no_proxy=lower.internal",
      "--entrypoint",
      "/usr/bin/env",
      input.image,
      ...heldWorkloadArgv.slice(1),
    ]).stdout.trim();
    if (!CONTAINER_ID_RE.test(containerId)) {
      throw new Error("docker run did not return one exact container identity");
    }

    const inspectOutput = docker(["inspect", "--type", "container", containerId]).stdout;
    const parsed = JSON.parse(inspectOutput) as unknown;
    if (!Array.isArray(parsed) || parsed.length !== 1) {
      throw new Error("docker inspect did not return one exact container");
    }
    const inspect = parsed[0] as ContainerInspect;
    if (
      inspect.Id !== containerId ||
      inspect.Image !== expectedImageId ||
      inspect.State?.Running !== true ||
      JSON.stringify(inspect.Config?.Entrypoint) !== JSON.stringify(["/usr/bin/env"]) ||
      JSON.stringify(inspect.Config?.Cmd) !== JSON.stringify(heldWorkloadArgv.slice(1))
    ) {
      throw new Error(
        "managed startup did not pin one running exact-image container with the rendered hold",
      );
    }
    const inspectText = JSON.stringify(inspect);
    if (
      inspectText.includes(request.encodedProfile) ||
      inspectText.includes(String(request.corporateCaB64)) ||
      (inspect.Config?.Env ?? []).some((value) =>
        /^(?:NEMOCLAW_STARTUP_PROFILE_B64|NEMOCLAW_CORPORATE_CA_B64)=/u.test(value),
      )
    ) {
      throw new Error("managed profile or corporate CA entered Docker argv/env metadata");
    }
    verifyManagedBootstrapNativeBoundary(containerId, input.platform);

    const sandboxUid = docker([
      "exec",
      "--user",
      "0:0",
      containerId,
      "id",
      "-u",
      "sandbox",
    ]).stdout.trim();
    const sandboxGid = docker([
      "exec",
      "--user",
      "0:0",
      containerId,
      "id",
      "-g",
      "sandbox",
    ]).stdout.trim();
    const expectedIdentity = managedImageRuntimeIdentity(input.agent);
    const imageWorkdir = docker([
      "image",
      "inspect",
      "--format",
      "{{.Config.WorkingDir}}",
      input.image,
    ]).stdout.trim();
    if (
      sandboxUid !== String(expectedIdentity.uid) ||
      sandboxGid !== String(expectedIdentity.gid) ||
      imageWorkdir !== expectedIdentity.workdir
    ) {
      throw new Error(
        `managed image runtime identity drifted: expected ${expectedIdentity.uid}:${expectedIdentity.gid}:${expectedIdentity.workdir}, received ${sandboxUid}:${sandboxGid}:${imageWorkdir}`,
      );
    }
    verifyManagedBootstrapPidOneBoundary(
      input,
      request,
      createManagedBootstrapIdentity(),
      sandboxUid,
      sandboxGid,
    );
    stageManagedBootstrapEnvelope(containerId, bootstrapIdentity, request);
    const applied = docker(
      [
        "exec",
        "--user",
        "0:0",
        "--workdir",
        "/",
        containerId,
        MANAGED_BOOTSTRAP,
        "--agent",
        input.agent,
        "--profile-fingerprint",
        request.profileFingerprint,
        "--bootstrap-identity",
        bootstrapIdentity,
        "--agent-uid",
        sandboxUid,
        "--agent-gid",
        sandboxGid,
        "--agent-workdir",
        "/sandbox",
        "--request-file",
        MANAGED_BOOTSTRAP_REQUEST_FILE,
        "--",
        "/bin/true",
      ],
      { timeout: 300_000 },
    );
    if (!applied.stdout.includes("transaction pending")) {
      throw new Error("root application did not leave a pending shared-state transaction");
    }
    waitForAgentCommand(containerId);

    const commandUid = docker([
      "exec",
      "--user",
      "0:0",
      containerId,
      "cat",
      "/tmp/nemoclaw-managed-command-uid",
    ]).stdout.trim();
    if (commandUid !== sandboxUid) {
      throw new Error(
        "managed hold or legacy entrypoint did not preserve the sandbox command identity",
      );
    }
    const proxyEnvironment = docker([
      "exec",
      "--user",
      "sandbox",
      containerId,
      "cat",
      "/tmp/nemoclaw-managed-command-proxy-env",
    ]).stdout.trim();
    if (proxyEnvironment !== exactProxyEnvironment()) {
      throw new Error("managed hold did not replace hostile inherited proxy material");
    }

    const config = docker([
      "exec",
      "--user",
      "sandbox",
      containerId,
      "cat",
      managedConfig(input.agent),
    ]).stdout;
    if (!config.includes("nvidia/nemotron-3-ultra-550b-a55b")) {
      throw new Error("managed agent configuration does not contain the requested model");
    }
    const runtimeEnvironment = docker([
      "exec",
      "--user",
      "0:0",
      containerId,
      "cat",
      "/run/nemoclaw/managed-startup-runtime.env",
    ]).stdout;
    if (
      runtimeEnvironment.includes("upper-secret") ||
      runtimeEnvironment.includes("lower-secret") ||
      runtimeEnvironment.includes(request.encodedProfile) ||
      runtimeEnvironment.includes(String(request.corporateCaB64))
    ) {
      throw new Error("managed runtime handoff contains a forbidden transport or credential");
    }
    const installedCa = docker([
      "exec",
      "--user",
      "0:0",
      containerId,
      "cat",
      "/usr/local/share/nemoclaw/corporate-ca.pem",
    ]).stdout;
    const installedSystemCaAnchor = docker([
      "exec",
      "--user",
      "0:0",
      containerId,
      "cat",
      "/usr/local/share/ca-certificates/nemoclaw-corporate-ca-01.crt",
    ]).stdout;
    const mergedCa = docker([
      "exec",
      "--user",
      "0:0",
      containerId,
      "cat",
      "/run/nemoclaw/managed-startup-ca-bundle.pem",
    ]).stdout;
    if (
      installedCa !== MANAGED_STARTUP_E2E_CORPORATE_CA_PEM ||
      installedSystemCaAnchor !== MANAGED_STARTUP_E2E_CORPORATE_CA_PEM ||
      !mergedCa.endsWith(MANAGED_STARTUP_E2E_CORPORATE_CA_PEM)
    ) {
      throw new Error("managed corporate CA was not installed and merged exactly");
    }
    docker([
      "exec",
      "--user",
      "0:0",
      containerId,
      "/bin/sh",
      "-eu",
      "-c",
      [
        'test "$(stat -c "%u:%g:%a" /run/nemoclaw/managed-startup-runtime.env)" = "0:0:444"',
        'test "$(stat -c "%u:%g:%a" /run/nemoclaw/managed-startup-complete.json)" = "0:0:444"',
        'test "$(stat -c "%u:%g:%a" /usr/local/share/nemoclaw/corporate-ca.pem)" = "0:0:444"',
        'test "$(stat -c "%u:%g:%a" /usr/local/share/ca-certificates/nemoclaw-corporate-ca-01.crt)" = "0:0:444"',
        "openssl verify -CAfile /etc/ssl/certs/ca-certificates.crt /usr/local/share/nemoclaw/corporate-ca.pem >/dev/null",
        'test "$(stat -c "%u:%g:%a" /run/nemoclaw/managed-startup-ca-bundle.pem)" = "0:0:444"',
        "test -d /var/lib/nemoclaw/managed-startup-shared-state-transaction-v1",
      ].join("\n"),
    ]);

    if (input.agent === "langchain-deepagents-code") {
      const status = docker([
        "exec",
        "--user",
        "0:0",
        containerId,
        "cat",
        "/tmp/nemoclaw-managed-dcode-empty-prompt-status",
      ]).stdout.trim();
      const output = docker([
        "exec",
        "--user",
        "0:0",
        containerId,
        "cat",
        "/tmp/nemoclaw-managed-dcode-empty-prompt-output",
      ]).stdout.trim();
      if (
        status !== "2" ||
        output !== "NemoClaw: empty non-interactive prompt for -n; provide prompt text."
      ) {
        throw new Error("managed DCode launcher/supervisor empty-prompt contract failed");
      }
    }

    docker(
      rootRuntimeArgs(
        containerId,
        input.agent,
        "--commit-shared-state-transaction",
        "0:0",
        bootstrapIdentity,
      ),
    );
    docker([
      "exec",
      "--user",
      "0:0",
      containerId,
      "test",
      "!",
      "-e",
      "/var/lib/nemoclaw/managed-startup-shared-state-transaction-v1",
    ]);

    const replay = docker(rootRuntimeArgs(containerId, input.agent, "--apply-root-stdin"), {
      input: payload,
      timeout: 300_000,
    });
    if (!replay.stdout.includes("was already complete")) {
      throw new Error("same-profile root application was not idempotent");
    }
    const changed = docker(rootRuntimeArgs(containerId, input.agent, "--apply-root-stdin"), {
      ignoreError: true,
      input: serializeManagedStartupRootApplyRequest(requestFor(input.agent, true)),
      timeout: 300_000,
    });
    if (
      changed.status === 0 ||
      !commandDetail(changed).includes("completion marker does not match the requested profile")
    ) {
      throw new Error("changed profile did not require a fresh sandbox");
    }
    const nonroot = docker(
      rootRuntimeArgs(containerId, input.agent, "--apply-root-stdin", "sandbox"),
      { ignoreError: true, input: payload, timeout: 300_000 },
    );
    if (
      nonroot.status === 0 ||
      !commandDetail(nonroot).includes("requires container effective uid 0")
    ) {
      throw new Error("sandbox account bypassed root-only profile application");
    }

    process.stdout.write(
      `Validated exact ${input.agent} managed image ${input.image} through native bootstrap and the rendered sandbox hold.\n`,
    );
  } finally {
    if (CONTAINER_ID_RE.test(containerId)) {
      docker(["rm", "-f", containerId], { ignoreError: true, timeout: 30_000 });
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    runManagedImageDirectE2e(parseManagedImageDirectE2eInputs(process.argv.slice(2)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
