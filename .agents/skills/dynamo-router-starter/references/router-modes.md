# Router Modes

<!--
SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
SPDX-License-Identifier: CC-BY-4.0
-->

## Common Modes

| Mode | Use When | Key Setting |
| --- | --- | --- |
| `round-robin` | simplest baseline | `DYN_ROUTER_MODE=round-robin` |
| `kv` | route by KV overlap and active load | `DYN_ROUTER_MODE=kv` |
| `least-loaded` | simple load-aware fallback | `DYN_ROUTER_MODE=least-loaded` |
| `device-aware-weighted` | heterogeneous CPU/GPU worker pools | `DYN_ROUTER_MODE=device-aware-weighted` |
| `random` | stateless randomized baseline | `DYN_ROUTER_MODE=random` |
| `direct` | external orchestrator chooses worker | `DYN_ROUTER_MODE=direct` |

## KV Routing Knobs

Kubernetes frontend env equivalents:

| Purpose | Env |
| --- | --- |
| Enable KV router | `DYN_ROUTER_MODE=kv` |
| Disable worker KV event consumption for approximate mode | `DYN_ROUTER_USE_KV_EVENTS=false` |
| Enable load-aware behavior | `DYN_ROUTER_LOAD_AWARE=true` |
| Set router randomness | `DYN_ROUTER_TEMPERATURE=<float>` |
| Set KV cache block size | `DYN_KV_CACHE_BLOCK_SIZE=<size>` |
| Tune KV overlap credit | `DYN_ROUTER_KV_OVERLAP_SCORE_CREDIT=<float>` |
| Scale prefill load | `DYN_ROUTER_PREFILL_LOAD_SCALE=<float>` |
| Set queue policy | `DYN_ROUTER_QUEUE_POLICY=fcfs\|wspt\|lcfs` |

CLI equivalents:

```bash
python3 -m dynamo.frontend --router-mode kv --http-port 8000
python3 -m dynamo.frontend --router-mode kv --no-router-kv-events --http-port 8000
python3 -m dynamo.frontend --router-mode least-loaded --http-port 8000
```

## Success Signals

- frontend process or pod is ready
- backend workers are registered
- `/v1/models` returns at least one model
- `/v1/chat/completions` succeeds
- repeated-prefix traffic does not error under KV mode

## When To Stop And Troubleshoot

Stop mode comparison and use `dynamo-troubleshoot` when:

- `/v1/models` is empty or unavailable
- frontend service exists but chat completions return 503/5xx
- no worker pods are ready
- frontend logs show no registered workers
- KV events are expected but worker logs do not show event publication
