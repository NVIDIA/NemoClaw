# NemoClaw on Kubernetes

Test NemoClaw with [OpenShell](https://github.com/NVIDIA/OpenShell) on AWS EKS, using Dynamo vLLM for inference.

> **Note:** The public installer test (`test-installer.sh`) requires unattended install support. See PR #225.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        EKS Cluster                               │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │              openshell-gateway Pod (DinD)                  │ │
│  │                                                            │ │
│  │  ┌──────────────┐     ┌─────────────────────────────────┐ │ │
│  │  │    dind      │     │          workspace              │ │ │
│  │  │  container   │     │         container               │ │ │
│  │  │              │     │                                 │ │ │
│  │  │  Docker      │◄────│  openshell CLI                  │ │ │
│  │  │  daemon      │     │  NemoClaw source                │ │ │
│  │  │              │     │                                 │ │ │
│  │  │  ┌────────┐  │     │  ┌───────────────────────────┐ │ │ │
│  │  │  │  k3s   │  │     │  │ OpenShell Gateway         │ │ │ │
│  │  │  │cluster │  │     │  │ (runs inside Docker)      │ │ │ │
│  │  │  │        │  │     │  │                           │ │ │ │
│  │  │  │Sandbox │  │     │  │ → Policy Engine           │ │ │ │
│  │  │  │Pods    │  │     │  │ → Inference Router        │ │ │ │
│  │  │  └────────┘  │     │  └───────────────────────────┘ │ │ │
│  │  └──────────────┘     └─────────────────────────────────┘ │ │
│  └────────────────────────────────────────────────────────────┘ │
│                               │                                  │
│                               ▼                                  │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │                    Dynamo Platform                         │ │
│  │                                                            │ │
│  │  vllm-agg-frontend.robert.svc:8000                        │ │
│  │  └── Llama-3.1-8B-Instruct                                │ │
│  └────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

OpenShell runs a k3s cluster inside Docker to provide sandboxed execution. On Kubernetes, we use Docker-in-Docker (DinD) to provide the Docker daemon that OpenShell requires.

## Prerequisites

- EKS cluster with kubectl access
- Dynamo vLLM deployment (or other OpenAI-compatible endpoint)
- OpenShell repo cloned to `../OpenShell` (optional, for reference)

## Quick Start

### Option A: Public Installer (Recommended)

Uses the official NemoClaw installer with unattended mode. Requires PR #225 merged.

```bash
# Run the public installer test
./test-installer.sh
```

This will:
1. Deploy a DinD pod with unattended install env vars
2. Run `curl -fsSL https://nvidia.com/nemoclaw.sh | bash`
3. Configure Dynamo vLLM automatically via `NEMOCLAW_DYNAMO_ENDPOINT`

Environment variables (set before running):
```bash
export NEMOCLAW_DYNAMO_ENDPOINT=http://vllm-agg-frontend.robert.svc.cluster.local:8000/v1
export NEMOCLAW_DYNAMO_MODEL=meta-llama/Llama-3.1-8B-Instruct
./test-installer.sh
```

### Option B: Manual Setup (Development)

For testing with local NemoClaw source changes:

```bash
# Run the full setup from source
./setup.sh
```

The setup script will:
1. Deploy the DinD pod (`openshell-gateway`)
2. Install the `openshell` CLI
3. Copy and build NemoClaw from source
4. Start the OpenShell gateway
5. Configure Dynamo vLLM as the inference provider

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `NAMESPACE` | `default` | Kubernetes namespace |
| `GATEWAY_NAME` | `nemoclaw` | OpenShell gateway name |
| `VLLM_ENDPOINT` | `http://vllm-agg-frontend.robert.svc.cluster.local:8000/v1` | vLLM API endpoint |
| `VLLM_MODEL` | `meta-llama/Llama-3.1-8B-Instruct` | Model name |
| `NEMOCLAW_DIR` | `..` (repo root) | Path to NemoClaw repo |

### Custom vLLM Endpoint

```bash
VLLM_ENDPOINT=http://my-vllm.namespace.svc:8000/v1 \
VLLM_MODEL=my-model-name \
./setup.sh
```

## Usage

### Create a Sandbox

```bash
# Create the NemoClaw sandbox (with OpenClaw pre-installed)
kubectl exec openshell-gateway -c workspace -- \
  openshell sandbox create --from /workspace/Dockerfile --name nemoclaw

# Or create a basic test sandbox
kubectl exec openshell-gateway -c workspace -- \
  openshell sandbox create --name test -- bash
```

### Connect to a Sandbox

```bash
kubectl exec -it openshell-gateway -c workspace -- \
  openshell sandbox connect test
```

### Test Inference

Inside the sandbox:

```bash
# Test inference.local routing
curl -X POST https://inference.local/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"meta-llama/Llama-3.1-8B-Instruct","messages":[{"role":"user","content":"hello"}]}'
```

### OpenShell Commands

```bash
# Run from host
kubectl exec openshell-gateway -c workspace -- openshell status
kubectl exec openshell-gateway -c workspace -- openshell sandbox list
kubectl exec openshell-gateway -c workspace -- openshell provider list
kubectl exec openshell-gateway -c workspace -- openshell inference get
```

## Manual Provider Configuration

If the vLLM endpoint changes or wasn't reachable during setup:

```bash
kubectl exec openshell-gateway -c workspace -- \
  openshell provider create \
    --name dynamo-vllm \
    --type openai \
    --credential "OPENAI_API_KEY=dummy" \
    --config "OPENAI_BASE_URL=http://vllm-agg-frontend.robert.svc.cluster.local:8000/v1"

kubectl exec openshell-gateway -c workspace -- \
  openshell inference set \
    --no-verify \
    --provider dynamo-vllm \
    --model meta-llama/Llama-3.1-8B-Instruct
```

## Files

| File | Description |
|------|-------------|
| `test-installer.sh` | Public installer test script (recommended) |
| `nemoclaw-installer-test.yaml` | K8s pod manifest for public installer test |
| `setup.sh` | Manual setup from source (development) |
| `openshell-gateway.yaml` | K8s pod manifest for manual setup |

## Cleanup

```bash
# Public installer test
./test-installer.sh --cleanup

# Manual setup
kubectl delete -f openshell-gateway.yaml
```

## Troubleshooting

### Docker daemon not starting

Check the dind container logs:
```bash
kubectl logs openshell-gateway -c dind
```

### Gateway not healthy

Check openshell status and logs:
```bash
kubectl exec openshell-gateway -c workspace -- openshell status
kubectl exec openshell-gateway -c workspace -- openshell gateway info
```

### Inference returns 403

The policy proxy may be blocking requests. Check the network policy:
```bash
kubectl exec openshell-gateway -c workspace -- openshell policy get <sandbox-name>
```

### vLLM not reachable

Test connectivity from the workspace container:
```bash
kubectl exec openshell-gateway -c workspace -- \
  curl -s http://vllm-agg-frontend.robert.svc.cluster.local:8000/v1/models
```

## Known Limitations

- **Privileged mode required**: DinD needs privileged containers
- **Memory**: Gateway pod needs ~8GB; workspace needs ~4GB
- **Nested virtualization**: Running k3s inside Docker inside K8s adds overhead
