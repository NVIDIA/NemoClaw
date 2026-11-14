// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Use the image's existing same-UID lifecycle, transaction lock, descriptor
// checks and hash owner. Configuration travels through stdin, never argv.
export const HERMES_NATIVE_CONFIG_WRITE = String.raw`
import hashlib, importlib.util, os, re, secrets, sys

def update():
    expected = sys.argv[1]
    mode = sys.argv[2] if len(sys.argv) > 2 else "reload"
    if mode not in ("reload", "deferred", "restore-native-local"):
        raise RuntimeError("Invalid native Hermes configuration mode")
    if not re.fullmatch(r"[0-9a-f]{64}", expected) or os.geteuid() == 0:
        raise RuntimeError("Invalid native Hermes configuration transaction")
    spec = importlib.util.spec_from_file_location("nemoclaw_mcp", "/usr/local/lib/nemoclaw/hermes-mcp-config-transaction.py")
    helper = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(helper)
    helper._assert_non_root_lifecycle_identity()
    helper._configure_gateway_public_port()
    guard = helper._load_guard()
    candidate = sys.stdin.buffer.read(guard.MAX_CONFIG_INPUT_BYTES + 1)
    if len(candidate) > guard.MAX_CONFIG_INPUT_BYTES:
        raise RuntimeError("Hermes configuration input is too large")
    guard._validate_hermes_config_candidate(candidate)
    replacement = candidate.decode("utf-8")
    with helper._mcp_transaction_lock():
        helper._assert_non_root_lifecycle_identity()
        original, original_snapshot = guard._read_text(helper.CONFIG_PATH)
        helper._assert_mutable_snapshot(original_snapshot)
        if not secrets.compare_digest(hashlib.sha256(original.encode("utf-8")).hexdigest(), expected):
            raise RuntimeError("Hermes configuration changed after it was read")
        if guard._canonical_mcp_servers_digest(original) != guard._canonical_mcp_servers_digest(replacement):
            raise RuntimeError("Inference configuration cannot change MCP servers")
        hashes = {path: guard._read_text(path) for path in helper._managed_hash_paths(False)}
        if mode == "restore-native-local":
            source, source_snapshot, _env, env_snapshot = guard._validate_restored_native_local_source(
                helper.HERMES_DIR, expected, candidate,
            )
            if source != original or source_snapshot != original_snapshot:
                raise RuntimeError("Restored Hermes configuration changed during validation")
            # Archive hashes can belong to the prior generation. Adopt only the
            # validated credential replacement, preserving every other input.
            snapshots = [(helper.CONFIG_PATH, source_snapshot),
                         (helper.HERMES_DIR + "/.env", env_snapshot)]
            for path, (text, snapshot) in hashes.items():
                guard._parse_config_hash(text, helper.CONFIG_PATH, helper.HERMES_DIR + "/.env")
                snapshots.append((path, snapshot))
            metadata = guard._inode_metadata(os.lstat(helper.HERMES_DIR))
            file_states = {os.path.basename(path): {"original": {
                "uid": snapshot.uid, "gid": snapshot.gid, "mode": snapshot.mode,
            }} for path, snapshot in snapshots}
            if not guard._mutable_nonroot_reconciliation_posture_is_allowed(metadata, file_states):
                raise RuntimeError("Restored Hermes inputs are not owned mutable sandbox state")
            for path, snapshot in snapshots:
                helper._assert_mutable_snapshot(snapshot)
                opened = guard._open_regular(path)
                try:
                    if opened.snapshot != snapshot:
                        raise RuntimeError("Restored Hermes inputs changed before writing")
                finally:
                    opened.close()
        else:
            integrity = guard.inspect_mcp_integrity_snapshot(helper.HERMES_DIR, helper.HERMES_DIR + "/.config-hash")
            guard.assert_mcp_integrity_snapshot_current(integrity)
            env_snapshot = integrity.env_snapshot
        replacement_snapshot = None
        def verify_written_inputs():
            for path, snapshot in ((helper.CONFIG_PATH, replacement_snapshot),
                                   (helper.HERMES_DIR + "/.env", env_snapshot)):
                opened = guard._open_regular(path)
                try:
                    if opened.snapshot != snapshot:
                        raise RuntimeError("Hermes inputs changed during configuration commit")
                finally:
                    opened.close()
        try:
            guard._write_existing(helper.CONFIG_PATH, replacement, original_snapshot)
            written, observed_snapshot = guard._read_text(helper.CONFIG_PATH)
            if written != replacement:
                raise RuntimeError("Hermes configuration changed during the transaction")
            replacement_snapshot = observed_snapshot
            environment = guard._open_regular(helper.HERMES_DIR + "/.env")
            try:
                if environment.snapshot != env_snapshot:
                    raise RuntimeError("Hermes environment changed during configuration write")
            finally:
                environment.close()
            helper._refresh_and_verify_hashes(guard, False)
            verify_written_inputs()
            if mode == "reload" and not helper.reload_gateway():
                raise RuntimeError("Hermes gateway stopped before configuration reload")
            current, current_snapshot = guard._read_text(helper.CONFIG_PATH)
            if current != replacement:
                raise RuntimeError("Hermes configuration changed during reload")
            replacement_snapshot = current_snapshot
            helper._refresh_and_verify_hashes(guard, False)
            verify_written_inputs()
        except Exception:
            if replacement_snapshot is not None:
                # The guarded replacement refuses to overwrite a concurrent writer.
                guard._write_existing(helper.CONFIG_PATH, original, replacement_snapshot)
                helper._restore_hash_snapshots(guard, hashes)
                if mode == "reload" and not helper.reload_gateway():
                    raise RuntimeError("Hermes configuration rollback reload was not confirmed")
            raise
    print("updated=1")

try:
    update()
except Exception:
    # Config parser and filesystem errors can include private values.
    sys.stderr.write("Native Hermes configuration transaction failed; configuration application was not confirmed.\n")
    sys.exit(1)
`;

export function writeHermesConfigNatively(
  binary: string,
  sandboxName: string,
  gateway: string,
  expectedConfigSha256: string,
  content: string,
  execute: typeof import("../adapters/openshell/client").runOpenshellCommand,
  options: {
    deferReload?: true;
    restoreNativeLocalCredential?: true;
    env?: Record<string, string>;
  } = {},
): void {
  const result = execute(
    binary,
    [
      "-g",
      gateway,
      "sandbox",
      "exec",
      "--name",
      sandboxName,
      "--no-tty",
      "--no-login-shell",
      "--timeout",
      "620",
      "--",
      "/opt/hermes/.venv/bin/python",
      "-I",
      "-c",
      HERMES_NATIVE_CONFIG_WRITE,
      expectedConfigSha256,
      ...(options.restoreNativeLocalCredential
        ? ["restore-native-local"]
        : options.deferReload
          ? ["deferred"]
          : []),
    ],
    {
      ...(options.env ? { env: options.env, replaceEnv: true } : {}),
      input: content,
      timeout: 650_000,
      maxBuffer: 64 * 1024,
      ignoreError: true,
      stdio: "pipe",
    },
  );
  if (
    result.error ||
    result.signal ||
    result.status !== 0 ||
    result.stdout?.trim() !== "updated=1"
  ) {
    throw new Error(
      "Native Hermes configuration transaction failed; configuration application was not confirmed.",
    );
  }
}
