# Riva NIM Deployment Readiness Checks

> **Agent:** When running the step-by-step system check, announce each step before presenting it: **Step N/6 — Step Title** (e.g., "**Step 1/6 — Check Architecture**").
>
> **Source of truth.** This skill describes the system-check workflow and shell commands, which are stable. For per-release minimums — driver version, compute capability, glibc, supported GPUs, OS list, WSL2 constraints — **fetch or open the canonical doc page and answer from that.** See [Looking up current information](#looking-up-current-information) below.

## Purpose

Verify host compatibility before deploying a Riva NIM. Covers hardware checks (architecture, GPU driver, VRAM, Container Toolkit), NGC access, and basic container health verification. This is a readiness reference, not an ASR/TTS/NMT troubleshooting guide; use the modality references for inference behavior, model options, and client-specific errors.

## Looking up current information

| Question type | Fetch this page |
|---|---|
| **Minimum driver version, compute capability, glibc, supported OSes, WSL2 constraints** | https://docs.nvidia.com/nim/speech/latest/get-started/prerequisites.html |
| **VRAM minimums + supported GPUs per model** | https://docs.nvidia.com/nim/speech/latest/reference/support-matrix/asr.html (and `/tts.html`, `/nmt.html`) |
| **Latency / throughput per GPU** | https://docs.nvidia.com/nim/speech/latest/reference/performances/asr/performance.html (and TTS / NMT) |
| **Current valid container image to test the registry pull** | https://docs.nvidia.com/nim/speech/latest/reference/support-matrix/asr.html (pick any model you have access to) |

**Do not infer driver minimums, compute-capability minimums, supported GPUs, or VRAM thresholds from this skill's text.** The prerequisites page and support matrix are the contract.

## Prerequisites

- Linux x86_64 system
- `nvidia-smi` accessible (NVIDIA driver installed)
- Docker and NVIDIA Container Toolkit installed (or being verified as part of this check)

## System Requirements

**Always fetch the prerequisites page** for current minimums (driver, compute capability, glibc, OS list). The checklist below is the *categories* to verify, not the version numbers — those rotate per release.

| Check | How to Verify |
|-------|---------------|
| CPU: x86_64 | `uname -m` |
| NVIDIA driver installed | `nvidia-smi` → check "Driver Version" meets prerequisites page minimum |
| GPU compute capability | `nvidia-smi --query-gpu=compute_cap --format=csv` — compare to prerequisites page |
| VRAM sufficient | `nvidia-smi --query-gpu=memory.total --format=csv` — compare to support matrix per model |
| OS / glibc | `ld -v` — compare to prerequisites page |
| Docker installed | `docker info` |
| NVIDIA Container Toolkit | `docker run --rm --gpus all ubuntu nvidia-smi` |
| NGC credentials | `[ -n "$NGC_API_KEY" ] && echo set` (non-empty), logged into `nvcr.io` |
| NVAIE license | Required for self-hosting |

---

## Instructions

Run the 6-step system check below to verify your hardware and environment before deploying any Riva NIM. All 6 steps must pass. Use the Container Health Check after deployment to confirm the NIM is ready for inference.

## Step-by-Step System Check

### 1. Check Architecture

```bash
uname -m
# Must output: x86_64
```

### 2. Check Driver Version

```bash
nvidia-smi
# Compare "Driver Version" against the minimum on the prerequisites page
```

### 3. Check GPU Compute Capability

```bash
nvidia-smi --query-gpu=name,compute_cap --format=csv,noheader
# Example output: NVIDIA A100-SXM4-80GB, 8.0
# Minimum required: see prerequisites page
```

### 4. Check Available VRAM

```bash
nvidia-smi --query-gpu=name,memory.total,memory.free --format=csv
# Ensure memory.free >= required for your model (per support matrix)
```

### 5. Verify Container Toolkit

```bash
docker run --rm --runtime=nvidia --gpus all ubuntu nvidia-smi
# Should show the same GPU info as host nvidia-smi
# If this fails, reinstall NVIDIA Container Toolkit
```

### 6. Verify NGC Authentication

```bash
[ -n "$NGC_API_KEY" ] && echo "NGC_API_KEY is set" || echo "NGC_API_KEY is NOT set"
# Never echo or log your API key value — use this non-printing check instead

# Test the registry pull with any current NIM image
# (fetch a current model name from the support matrix; the example below uses a placeholder)
docker pull nvcr.io/nim/nvidia/<container-id-from-support-matrix>:latest 2>&1 | head -3
# Should start "latest: Pulling from..." not "Error response from daemon"
```

---

## Container Health Check

After starting a NIM container, verify it is ready before sending inference requests:

```bash
# Wait for ready status (poll until "ready")
until curl -sf http://localhost:9000/v1/health/ready | grep -q '"ready"'; do
  echo "Waiting for NIM to be ready..."; sleep 10
done
echo "NIM is ready"
```

Single check:

```bash
curl -X GET http://localhost:9000/v1/health/ready
# Expected: {"status":"ready"}
```

---

## Examples

**Full quick system check:**

```bash
uname -m                                                        # must be x86_64
nvidia-smi                                                      # verify driver
docker run --rm --runtime=nvidia --gpus all ubuntu nvidia-smi   # verify Container Toolkit
[ -n "$NGC_API_KEY" ] && echo "NGC_API_KEY is set" || echo "NOT set"
```

**Poll until NIM is ready:**

```bash
until curl -sf http://localhost:9000/v1/health/ready | grep -q '"ready"'; do
  echo "Waiting..."; sleep 10
done && echo "NIM is ready"
```

**Lookup flow — agent question "can my GPU run Whisper Large v3?":**

1. Fetch or open the ASR support matrix
2. Locate the row for the requested model
3. Compare the listed VRAM and compute-capability minimum against the user's GPU (`nvidia-smi --query-gpu=name,memory.total,compute_cap --format=csv`)
4. Answer with the comparison

Do not answer hardware-compatibility questions from this skill's text alone.

## Common Readiness Failures

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| Container exits immediately | Wrong `NIM_TAGS_SELECTOR` — no matching profile | Check support matrix for correct tag values |
| `docker pull` returns 403 | Missing NGC credentials or no NVAIE license | Re-run `docker login nvcr.io`; verify `NGC_API_KEY` |
| Container stuck at "Downloading model" for >30 min | Large model (normal); slow network | Use model caching (`-v $LOCAL_NIM_CACHE:/opt/nim/.cache`) |
| `nvidia-smi` not found in container | Container Toolkit not configured | Reinstall/reconfigure NVIDIA Container Toolkit |
| Health check returns 503 | Model still loading | Wait and retry; first load can take 10–30 min |
| OOM error / container killed | Insufficient VRAM | Use a profile with lower VRAM (per support matrix) or upgrade GPU |
| gRPC connection refused | Container not ready, or wrong port | Wait for health check; verify `-p 50051:50051` flag |
| HTTP 404 on inference endpoint | Wrong API path | Use `curl http://localhost:9000/v1/health/ready` to verify container is up |

---

## WSL2 (Windows) Notes

WSL2 has stricter requirements than Linux — **fetch the prerequisites page for current minimums and the supported model subset**, both rotate per release.

Stable WSL2 conventions:

- Use **Podman** instead of Docker
- Only a subset of NIMs is supported on WSL2 (verify on the prerequisites page)
- Adjust WSL memory in `.wslconfig` if a container OOMs

> If any check fails, report which requirement is unmet. Driver, glibc, and compute-capability minimums change with releases — always verify against the prerequisites page before deploying.

## Limitations

- System checks apply to x86_64 Linux only — WSL2 has additional constraints (fetch prerequisites page).
- VRAM requirements are model-specific — always consult the support matrix for the NIM being deployed.
- Health check polling assumes default port 9000; adjust if a custom port is configured.
