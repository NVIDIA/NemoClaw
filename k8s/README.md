# NemoClaw on Kubernetes

Run [NemoClaw](https://github.com/NVIDIA/NemoClaw) on Kubernetes with GPU inference powered by [Dynamo](https://github.com/ai-dynamo/dynamo). A safe, scalable sandbox for teams who want a shared, secure environment to explore autonomous AI agents without local GPU requirements.

> **Status: Work in Progress**
>
> This integration is under active development. See [Known Limitations](#known-limitations) for current status.

---

## Why Kubernetes?

| Challenge | Solution |
|-----------|-------------------|
| "I don't have a GPU" | Connect to shared Dynamo vLLM clusters on K8s |
| "AI agents are unpredictable" | Every agent runs in an isolated sandbox with network policies |
| "Setup is complicated" | One command unattended install with environment variables |
| "I want to learn safely" | Sandboxed execution prevents agents from affecting your system |

---

## Quick Start

### Prerequisites

- Kubernetes cluster with `kubectl` access
- A Dynamo vLLM endpoint (or any OpenAI-compatible inference API)
- Namespace with permissions to create privileged pods

### 1. Deploy NemoClaw

```bash
# Set your Dynamo endpoint
export DYNAMO_ENDPOINT="http://vllm-frontend.dynamo.svc.cluster.local:8000/v1"
export DYNAMO_MODEL="meta-llama/Llama-3.1-8B-Instruct"

# Deploy (creates namespace 'nemoclaw' if needed)
kubectl apply -f https://raw.githubusercontent.com/NVIDIA/NemoClaw/main/k8s/nemoclaw-k8s.yaml
```

### 2. Run the Installer

```bash
# Wait for pod to be ready
kubectl wait --for=condition=Ready pod/nemoclaw -n nemoclaw --timeout=120s

# Run unattended install
kubectl exec -it nemoclaw -n nemoclaw -c workspace -- bash -c '
  export NEMOCLAW_NON_INTERACTIVE=1
  export NEMOCLAW_PROVIDER=dynamo
  export NEMOCLAW_DYNAMO_ENDPOINT="http://vllm-frontend.dynamo.svc.cluster.local:8000/v1"
  export NEMOCLAW_DYNAMO_MODEL="meta-llama/Llama-3.1-8B-Instruct"
  curl -fsSL https://nvidia.com/nemoclaw.sh | bash
'
```

### 3. Connect to Your Sandbox

```bash
kubectl exec -it nemoclaw -n nemoclaw -c workspace -- nemoclaw my-assistant connect
```

You're now inside a secure sandbox with an AI agent ready to help!

---

## What Can You Do?

### Test Inference Connectivity

```bash
# Inside the sandbox - verify the inference endpoint is reachable
sandbox@my-assistant:~$ curl -s http://inference.local:8000/v1/models | jq .
```

### Chat with the AI Agent (Coming Soon)

```bash
# Inside the sandbox
sandbox@my-assistant:~$ openclaw tui
```

> **Note**: The `openclaw` commands currently don't work due to an HTTPS proxy routing issue in OpenShell. See [Known Limitations](#known-limitations).

### Run Single Commands (Coming Soon)

```bash
sandbox@my-assistant:~$ openclaw agent -m "List all Python files and summarize what each one does"
```

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           Kubernetes Cluster                                 │
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────────┐│
│  │                        NemoClaw Pod                                     ││
│  │                                                                         ││
│  │  ┌─────────────────────┐    ┌─────────────────────────────────────────┐││
│  │  │    Docker-in-Docker │    │           Workspace Container           │││
│  │  │                     │    │                                         │││
│  │  │  ┌───────────────┐  │    │  nemoclaw CLI    ┌───────────────────┐ │││
│  │  │  │     k3s       │  │◄───│  openshell CLI   │  socat proxy      │ │││
│  │  │  │   cluster     │  │    │                  │  localhost:8000   │ │││
│  │  │  │               │  │    │                  └─────────┬─────────┘ │││
│  │  │  │ ┌───────────┐ │  │    │                            │           │││
│  │  │  │ │  Sandbox  │ │  │    │  inference.local ──────────┘           │││
│  │  │  │ │   Pods    │ │  │    │  (via host.openshell.internal)         │││
│  │  │  │ └───────────┘ │  │    │                                        │││
│  │  │  └───────────────┘  │    └─────────────────────────────────────────┘││
│  │  └─────────────────────┘                                               ││
│  └────────────────────────────────────────────────────────────────────────┘│
│                                        │                                    │
│                                        ▼                                    │
│  ┌─────────────────────────────────────────────────────────────────────────┐│
│  │                         Dynamo vLLM Service                             ││
│  │                                                                         ││
│  │    vllm-frontend.dynamo.svc.cluster.local:8000                         ││
│  │    └── meta-llama/Llama-3.1-8B-Instruct (or your model)                ││
│  │    └── Scales across multiple GPUs                                      ││
│  └─────────────────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────────────────┘
```

**How it works:**
1. NemoClaw runs in a privileged pod with Docker-in-Docker (DinD)
2. OpenShell creates a nested k3s cluster for sandbox isolation
3. AI agents run inside sandboxes with network policies
4. A socat proxy in the workspace container bridges K8s DNS to the nested k3s environment
5. Inside the sandbox, `inference.local:8000` routes to the Dynamo endpoint via `host.openshell.internal`

> **Note**: The HTTPS proxy (`https://inference.local`) has routing issues. HTTP (`http://inference.local:8000`) works correctly.

---

## Configuration

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `NEMOCLAW_NON_INTERACTIVE` | Yes | - | Set to `1` for unattended install |
| `NEMOCLAW_PROVIDER` | Yes | - | Set to `dynamo` for K8s deployments |
| `NEMOCLAW_DYNAMO_ENDPOINT` | Yes | - | Full URL to vLLM API (e.g., `http://....:8000/v1`) |
| `NEMOCLAW_DYNAMO_MODEL` | No | `dynamo` | Model name to use |
| `NEMOCLAW_SANDBOX_NAME` | No | `my-assistant` | Name for your sandbox |
| `NEMOCLAW_POLICY_MODE` | No | - | Set to `skip` to skip policy setup |

### Custom Dynamo Endpoint

```bash
# Point to your own vLLM deployment
export NEMOCLAW_DYNAMO_ENDPOINT="http://my-vllm.my-namespace.svc.cluster.local:8000/v1"
export NEMOCLAW_DYNAMO_MODEL="mistralai/Mistral-7B-Instruct-v0.3"
```

---

## For Teams: Multi-User Setup

NemoClaw is perfect for workshops, training sessions, or team experimentation. Each user gets their own isolated sandbox.

### Deploy One Pod Per User

```bash
# Create user-specific pods
for user in alice bob carol; do
  cat <<EOF | kubectl apply -f -
apiVersion: v1
kind: Pod
metadata:
  name: nemoclaw-${user}
  namespace: nemoclaw
  labels:
    app: nemoclaw
    user: ${user}
spec:
  # ... (use nemoclaw-k8s.yaml as template)
EOF
done
```

### Shared Dynamo Backend

All users share the same GPU-powered inference backend:
- Cost-effective: One Dynamo deployment serves many users
- Consistent: Everyone uses the same model version
- Scalable: Dynamo auto-scales based on demand

---

## Known Limitations

This Kubernetes integration is a work in progress. Here's the current status:

### What Works

| Feature | Status | Notes |
|---------|--------|-------|
| Unattended onboard | ✅ Working | Full automated setup from `kubectl apply` to running sandbox |
| Sandbox creation | ✅ Working | OpenShell creates isolated k3s sandbox |
| Connect to sandbox | ✅ Working | `nemoclaw my-assistant connect` works |
| HTTP inference | ✅ Working | `curl http://inference.local:8000/v1/models` works inside sandbox |
| Socat proxy bridge | ✅ Working | Bridges K8s DNS to nested k3s environment |

### What Doesn't Work Yet

| Feature | Status | Issue |
|---------|--------|-------|
| `openclaw tui` | ❌ Blocked | Uses HTTPS which fails through OpenShell proxy |
| `openclaw agent` | ❌ Blocked | Same HTTPS proxy issue |
| HTTPS inference | ❌ Blocked | `https://inference.local/v1/*` returns connection errors |

### Root Cause

OpenClaw is configured to use `https://inference.local/v1` (HTTPS on port 443). The OpenShell sandbox proxy should intercept these requests and forward them to the upstream Dynamo endpoint, but the proxy has routing issues with HTTPS traffic.

**Workaround**: Direct HTTP calls to `http://inference.local:8000/v1` work correctly. The fix requires updates to OpenShell's inference proxy routing.

---

## Troubleshooting

### Pod won't start

```bash
# Check pod status
kubectl describe pod nemoclaw -n nemoclaw

# Common issues:
# - Missing privileged security context (DinD requires it)
# - Insufficient memory (needs ~8GB for DinD container)
```

### Docker daemon not starting

```bash
# Check DinD container logs
kubectl logs nemoclaw -n nemoclaw -c dind

# Usually resolves by waiting 30-60 seconds after pod starts
```

### Inference returns 502 Bad Gateway or connection errors

**For HTTP (port 8000)**: The nested k3s cluster can't resolve Kubernetes DNS names. The socat proxy handles this automatically, but verify it's running:

```bash
# Check if socat is running in workspace container
kubectl exec nemoclaw -n nemoclaw -c workspace -- pgrep -a socat

# If not running, start it manually
kubectl exec nemoclaw -n nemoclaw -c workspace -- \
  socat TCP-LISTEN:8000,fork,reuseaddr TCP:your-vllm.namespace.svc:8000 &
```

**For HTTPS (port 443)**: This is a known issue with OpenShell's proxy routing. Use HTTP instead:

```bash
# Inside sandbox - use HTTP, not HTTPS
curl http://inference.local:8000/v1/models
```

### Can't connect to sandbox

```bash
# List available sandboxes
kubectl exec nemoclaw -n nemoclaw -c workspace -- openshell sandbox list

# Check sandbox status
kubectl exec nemoclaw -n nemoclaw -c workspace -- nemoclaw my-assistant status
```

---

## Learn More

- **[NemoClaw Documentation](https://docs.nvidia.com/nemoclaw)** — Full reference for NemoClaw
- **[OpenShell](https://github.com/NVIDIA/OpenShell)** — The sandbox runtime powering NemoClaw
- **[Dynamo](https://github.com/ai-dynamo/dynamo)** — Distributed vLLM inference for K8s
- **[OpenClaw](https://openclaw.ai)** — The AI agent framework

---

## Contributing

Found an issue? Have an idea? We'd love your input!

- [Report a bug](https://github.com/NVIDIA/NemoClaw/issues/new)
- [Request a feature](https://github.com/NVIDIA/NemoClaw/issues/new)
- [Join the discussion](https://github.com/NVIDIA/NemoClaw/discussions)

---

## Requirements

- **Kubernetes**: 1.25+
- **kubectl**: Configured with cluster access
- **Dynamo/vLLM**: Running and accessible from cluster
- **Resources**:
  - DinD container: 8GB RAM, 2 CPU
  - Workspace container: 2GB RAM, 1 CPU
- **Permissions**: Ability to create privileged pods

---

<p align="center">
  <b>NemoClaw</b> — Safe AI agent experimentation on Kubernetes
  <br>
  <sub>Built with NemoClaw + OpenShell + Dynamo</sub>
</p>
