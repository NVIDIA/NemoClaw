// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Shared with support tests so readiness policy runs without compiled CLI imports.
export const BEARERLESS_VLLM_READINESS_SCRIPT = String.raw`
// Docker can accept the published connection before Node listens, then reset it.
// Retry only refused/reset connections for this idempotent fixture GET.
const readinessDeadline = Date.now() + 10_000;
for (let attempt = 1; ; attempt += 1) {
  try {
    execFileSync('curl', ['--noproxy', '*', '--silent', '--show-error', '--fail',
      '--connect-timeout', '1', '--max-time', '2', 'http://127.0.0.1:18080/v1/models'],
      { encoding: 'utf8', timeout: Math.max(1, Math.min(2_000, readinessDeadline - Date.now())),
        stdio: ['ignore', 'pipe', 'inherit'] });
    break;
  } catch (error) {
    console.error('bearerless fixture readiness attempt', attempt, 'curl status', error.status);
    if (![7, 56].includes(error.status) || attempt === 6 || Date.now() + 1_000 >= readinessDeadline) throw error;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1_000);
  }
}
`;
