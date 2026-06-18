# Dynamo Interconnect Env Vars & IB Capability Checklist

<!--
SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
SPDX-License-Identifier: CC-BY-4.0
-->

Disaggregated serving moves KV cache between prefill and decode workers over
NIXL (which uses UCX underneath), and tensor/expert-parallel workers exchange
data over NCCL. Both ride the same fabric — InfiniBand/RoCE RDMA across nodes
and NVLink within a node. If that fabric is misconfigured, a deployment still
serves `/v1/models` but disagg is slow or wrong. The variables below decide
which transport gets used.

## NIXL / UCX (KV cache transport)

| Variable | Disagg-critical | Purpose |
|----------|:---:|---------|
| `UCX_TLS` | yes | Allowed transports. Include `rc`/IB and `cuda_ipc`/`cuda_copy` for RDMA + NVLink. If it resolves to `tcp` only, KV transfer crawls. |
| `UCX_NET_DEVICES` | yes | Pins UCX to a specific HCA/port (e.g. `mlx5_0:1`). Unset or wrong device falls back to the management NIC. |
| `UCX_IB_GPU_DIRECT_RDMA` | yes | Enables GPUDirect RDMA so the NIC DMAs straight to/from GPU memory. |
| `UCX_RNDV_SCHEME` | no | Rendezvous scheme for large messages (`put_zcopy` / `get_zcopy` / `auto`). |
| `NIXL_PLUGIN_DIR` | no | Backend plugin search path; only for non-default install layouts. |

## NCCL (collective transport)

| Variable | Disagg-critical | Purpose |
|----------|:---:|---------|
| `NCCL_IB_HCA` | yes | IB HCAs NCCL may use (e.g. `mlx5_0,mlx5_1`). |
| `NCCL_SOCKET_IFNAME` | yes | NIC for NCCL bootstrap/rendezvous (e.g. `eth0`, `ib0`). A wrong guess hangs init. |
| `NCCL_IB_DISABLE` | yes | Must be `0`/unset to use InfiniBand; `1` forces sockets. |
| `NCCL_NET_GDR_LEVEL` | no | GPUDirect RDMA aggressiveness (`SYS`/`PHB`/`PIX`). |
| `NCCL_P2P_LEVEL` | no | NVLink/PCIe peer-to-peer level for intra-node collectives. |
| `NCCL_IB_GID_INDEX` | no | GID index for RoCE/EFA fabrics; not needed on classic IB. |
| `NCCL_DEBUG` | no | Set to `INFO` to print the transport NCCL actually selected. |

## IB / GPUDirect / NVLink capability checklist

The `node` check probes these read-only; here is what each tells you:

- **`/dev/infiniband` + `ibv_devinfo -l`** — RDMA devices are exposed to the
  pod. Empty means no RDMA (often a missing device plugin or `hostNetwork`/
  resource request).
- **`ibstat` → `State: Active` / `LinkUp`** — the IB/RoCE port is actually up.
  `Down`/`Polling` means cabling, subnet manager, or fabric issues.
- **`nvidia_peermem` (or legacy `nv_peer_mem`) loaded** — GPUDirect RDMA kernel
  support; without it RDMA stages through host memory.
- **`/dev/gdrdrv`** — GDRCopy present, used for low-latency small transfers.
- **`nvidia-smi topo -m` showing `NV#`** — NVLink links between GPUs for
  intra-node KV/collective traffic; `PIX`/`PXB` rows show GPU↔NIC affinity,
  which should line up with `UCX_NET_DEVICES` / `NCCL_IB_HCA`.

## Validating NIXL reachability

Capabilities being present does not prove two workers can talk. To actually
exercise the path, run a pairwise transfer between a prefill pod and a decode
pod (different nodes for the RDMA path, same node for NVLink) using the NIXL
test/bench tooling shipped in the worker image, e.g.:

```bash
# in the worker image; exact binary/flags depend on the NIXL build
kubectl exec -n "${NAMESPACE}" <prefill-pod> -- nixlbench --help
```

If the transfer fails or silently uses TCP, fix the env vars and capabilities
above before trusting any disagg result. Set `NCCL_DEBUG=INFO` and inspect UCX
logs to confirm the selected transport.
