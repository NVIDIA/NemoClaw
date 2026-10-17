// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ReviewedModelCode } from "./types.js";

// This path cannot redirect a tokenizer, draft model, config, plugin or loader away from verified files.
export const REVIEWED_MODEL_SERVE_ARGUMENTS = new Set([
  "--host",
  "--port",
  "--revision",
  "--served-model-name",
  "--tensor-parallel-size",
  "--pipeline-parallel-size",
  "--data-parallel-size",
  "--max-model-len",
  "--async-scheduling",
  "--gpu-memory-utilization",
  "--max-num-seqs",
  "--max-num-batched-tokens",
  "--mamba-backend",
  "--kv-cache-dtype",
  "--mamba-ssm-cache-dtype",
  "--enable-mamba-cache-stochastic-rounding",
  "--mamba-cache-philox-rounds",
  "--enable-mamba-shared-prefix-checkpoint",
  "--prefix-match-unit",
  "--spec-method",
  "--spec-tokens",
  "--enable-auto-tool-choice",
  "--tool-call-parser",
  "--reasoning-parser",
  "--chat-template",
  "--tool-strict-level",
  "--default-chat-template-kwargs",
  "--limit-mm-per-prompt",
  "--allowed-media-domains",
]);

export function reviewedModelCodeError(
  revision: string,
  policy: ReviewedModelCode,
): string | undefined {
  if (!/^[0-9a-f]{40}$/.test(revision) || policy.revision !== revision) {
    return "reviewed model code must match the immutable model revision";
  }
  const files = policy.files;
  if (!Array.isArray(files) || files.length < 2 || files.length > 64) {
    return "reviewed model code requires a bounded file manifest";
  }
  if (
    files.some(
      ({ path, digest }) =>
        !/^[A-Za-z0-9_.-]+$/.test(path) ||
        path === "." ||
        path === ".." ||
        path.endsWith(".safetensors") ||
        !/^sha256:[0-9a-f]{64}$/.test(digest),
    )
  ) {
    return "reviewed model code contains an invalid metadata path or digest";
  }
  if (
    new Set(files.map(({ path }) => path)).size !== files.length ||
    !files.some(({ path }) => path === "config.json") ||
    !files.some(({ path }) => path.endsWith(".py"))
  ) {
    return "reviewed model code requires unique files, config.json and Python code";
  }
  return undefined;
}

/** Freeze verified metadata before imports; only safetensors remain linked to the read-only cache. */
export const REVIEWED_MODEL_CODE_BOOTSTRAP = String.raw`
import hashlib, json, os, pathlib, re, shutil, signal, subprocess, sys, tempfile

model_id, revision, encoded = sys.argv[1:4]
manifest = json.loads(encoded)
root = pathlib.Path(os.environ['HF_HOME']) / 'hub' / ('models--' + model_id.replace('/', '--'))
root = root.resolve(strict=True)
source = root / 'snapshots' / revision
if source.is_symlink() or source.resolve(strict=True) != source:
    raise RuntimeError('reviewed model snapshot is not a canonical directory')
expected = {row['path']: row['digest'].removeprefix('sha256:') for row in manifest}
def check_auto_map(value):
    if isinstance(value, dict):
        for key, item in value.items():
            if key == 'auto_map':
                if not isinstance(item, dict):
                    raise RuntimeError('invalid reviewed auto_map')
                for refs in item.values():
                    for ref in (refs if isinstance(refs, list) else [refs]):
                        if ref is not None and (not isinstance(ref, str) or
                            not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]*[.][A-Za-z_][A-Za-z0-9_]*', ref) or
                            ref.split('.')[0] + '.py' not in expected):
                            raise RuntimeError('auto_map references unreviewed code')
            else:
                check_auto_map(item)
    elif isinstance(value, list):
        for item in value:
            check_auto_map(item)
entries = list(source.iterdir())
metadata = {p.name for p in entries if not p.name.endswith('.safetensors')}
if metadata != set(expected):
    raise RuntimeError('reviewed model metadata inventory changed')
temporary = pathlib.Path(tempfile.mkdtemp(prefix='nemoclaw-reviewed-model-'))
snapshot = temporary / 'model'
snapshot.mkdir(mode=0o700)
child = None
starting = False
pending_signal = None
def forward_signal(signum, frame):
    global pending_signal
    if child is not None:
        child.send_signal(signum)
    elif starting:
        pending_signal = signum
    else:
        sys.exit(128 + signum)
try:
    for signum in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(signum, forward_signal)
    for path in entries:
        target = path.resolve(strict=True)
        if not target.is_relative_to(root) or not target.is_file():
            raise RuntimeError('reviewed model file escapes its cache or is not regular')
        destination = snapshot / path.name
        if path.name in expected:
            with target.open('rb') as stream:
                data = stream.read(64 * 1024 * 1024 + 1)
            if len(data) > 64 * 1024 * 1024 or hashlib.sha256(data).hexdigest() != expected[path.name]:
                raise RuntimeError('reviewed model metadata digest mismatch: ' + path.name)
            if path.name.endswith('.json'):
                check_auto_map(json.loads(data))
            destination.write_bytes(data)
            destination.chmod(0o400)
        elif re.fullmatch(r'[A-Za-z0-9_.-]+[.]safetensors', path.name):
            destination.symlink_to(target)
        else:
            raise RuntimeError('unreviewed model artifact')
    snapshot.chmod(0o500)
    environment = dict(os.environ)
    environment.update(HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1',
                       HF_MODULES_CACHE=str(temporary / 'modules'))
    starting = True
    child = subprocess.Popen(['/usr/local/bin/vllm', 'serve', str(snapshot),
              '--trust-remote-code', '--code-revision', revision, *sys.argv[4:]], env=environment)
    if pending_signal is not None:
        child.send_signal(pending_signal)
    status = child.wait()
    sys.exit(status if status >= 0 else 128 - status)
finally:
    snapshot.chmod(0o700)
    shutil.rmtree(temporary)
`.trim();

export function buildReviewedModelCodeCommand(
  model: {
    id: string;
    revision?: string;
    reviewedCode?: ReviewedModelCode;
    fixedServeCommand?: boolean;
    managedBearerAuth?: boolean;
    installFastSafetensors?: boolean;
  },
  args: readonly string[],
  quote: (value: string) => string,
): string {
  const policy = model.reviewedCode;
  if (!policy || !model.revision || !/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(model.id)) {
    throw new Error("Reviewed model code requires a pinned model identity and manifest");
  }
  const error = reviewedModelCodeError(model.revision, policy);
  if (error) throw new Error(error);
  if (
    !model.fixedServeCommand ||
    !model.managedBearerAuth ||
    model.installFastSafetensors !== false
  ) {
    throw new Error(
      "Reviewed model code requires fixed authenticated serving without startup installs",
    );
  }
  if (args.some((arg) => arg.startsWith("--") && !REVIEWED_MODEL_SERVE_ARGUMENTS.has(arg))) {
    throw new Error(
      "Reviewed model code does not permit a serving argument that can bypass verification",
    );
  }
  return [
    "python3",
    "-c",
    REVIEWED_MODEL_CODE_BOOTSTRAP,
    model.id,
    model.revision,
    JSON.stringify(policy.files),
    ...args,
  ]
    .map(quote)
    .join(" ");
}
