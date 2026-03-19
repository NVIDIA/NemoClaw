# NemoKlaw

**NemoClaw on Kubernetes** — A safe, scalable sandbox for learning and experimenting with AI agents.

```
 _   _                      _  ___
| \ | | ___ _ __ ___   ___ | |/ / | __ ___      __
|  \| |/ _ \ '_ ` _ \ / _ \| ' /| |/ _` \ \ /\ / /
| |\  |  __/ | | | | | (_) | . \| | (_| |\ V  V /
|_| \_|\___|_| |_| |_|\___/|_|\_\_|\__,_| \_/\_/
```

Run [NemoClaw](https://github.com/NVIDIA/NemoClaw) on Kubernetes with GPU inference powered by [Dynamo](https://github.com/ai-dynamo/dynamo). Perfect for teams who want a shared, secure environment to explore autonomous AI agents without local GPU requirements.

---

## Why NemoKlaw?

| Challenge | NemoKlaw Solution |
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

### 1. Deploy NemoKlaw

```bash
# Set your Dynamo endpoint
export DYNAMO_ENDPOINT="http://vllm-frontend.dynamo.svc.cluster.local:8000/v1"
export DYNAMO_MODEL="meta-llama/Llama-3.1-8B-Instruct"

# Deploy (creates namespace 'nemoklaw' if needed)
kubectl apply -f https://raw.githubusercontent.com/NVIDIA/NemoClaw/main/k8s-testing/nemoklaw.yaml
```

### 2. Run the Installer

```bash
# Wait for pod to be ready
kubectl wait --for=condition=Ready pod/nemoklaw -n nemoklaw --timeout=120s

# Run unattended install
kubectl exec -it nemoklaw -n nemoklaw -c workspace -- bash -c '
  export NEMOCLAW_NON_INTERACTIVE=1
  export NEMOCLAW_PROVIDER=dynamo
  export NEMOCLAW_DYNAMO_ENDPOINT="http://vllm-frontend.dynamo.svc.cluster.local:8000/v1"
  export NEMOCLAW_DYNAMO_MODEL="meta-llama/Llama-3.1-8B-Instruct"
  curl -fsSL https://nvidia.com/nemoclaw.sh | bash
'
```

### 3. Connect to Your Sandbox

```bash
kubectl exec -it nemoklaw -n nemoklaw -c workspace -- nemoclaw my-assistant connect
```

You're now inside a secure sandbox with an AI agent ready to help!

---

## What Can You Do?

### Chat with the AI Agent

```bash
# Inside the sandbox
sandbox@my-assistant:~$ openclaw tui
```

This opens an interactive chat interface. Ask the agent to:
- Write and run code
- Explore files and directories
- Install packages and run tests
- Anything you'd do in a terminal — safely sandboxed

### Run Single Commands

```bash
sandbox@my-assistant:~$ openclaw agent -m "List all Python files and summarize what each one does"
```

### Test Inference Directly

```bash
# Verify inference.local routing works
sandbox@my-assistant:~$ curl -s https://inference.local/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"meta-llama/Llama-3.1-8B-Instruct","messages":[{"role":"user","content":"Hello!"}]}' | jq .
```

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           Kubernetes Cluster                                 │
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────────┐│
│  │                        NemoKlaw Pod                                     ││
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
1. NemoKlaw runs in a privileged pod with Docker-in-Docker (DinD)
2. OpenShell creates a nested k3s cluster for sandbox isolation
3. AI agents run inside sandboxes with network policies
4. Inference requests route through `inference.local` to your Dynamo endpoint
5. A socat proxy bridges the K8s network to the nested k3s environment

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

NemoKlaw is perfect for workshops, training sessions, or team experimentation. Each user gets their own isolated sandbox.

### Deploy One Pod Per User

```bash
# Create user-specific pods
for user in alice bob carol; do
  cat <<EOF | kubectl apply -f -
apiVersion: v1
kind: Pod
metadata:
  name: nemoklaw-${user}
  namespace: nemoklaw
  labels:
    app: nemoklaw
    user: ${user}
spec:
  # ... (use nemoklaw.yaml as template)
EOF
done
```

### Shared Dynamo Backend

All users share the same GPU-powered inference backend:
- Cost-effective: One Dynamo deployment serves many users
- Consistent: Everyone uses the same model version
- Scalable: Dynamo auto-scales based on demand

---

## Troubleshooting

### Pod won't start

```bash
# Check pod status
kubectl describe pod nemoklaw -n nemoklaw

# Common issues:
# - Missing privileged security context (DinD requires it)
# - Insufficient memory (needs ~8GB for DinD container)
```

### Docker daemon not starting

```bash
# Check DinD container logs
kubectl logs nemoklaw -n nemoklaw -c dind

# Usually resolves by waiting 30-60 seconds after pod starts
```

### Inference returns 502 Bad Gateway

The nested k3s cluster can't resolve Kubernetes DNS names. The socat proxy handles this automatically, but if you're setting up manually:

```bash
# Start socat proxy in workspace container
kubectl exec nemoklaw -n nemoklaw -c workspace -- \
  socat TCP-LISTEN:8000,fork,reuseaddr TCP:your-vllm.namespace.svc:8000 &

# Configure provider to use host.openshell.internal
kubectl exec nemoklaw -n nemoklaw -c workspace -- \
  openshell provider create \
    --name dynamo \
    --type openai \
    --credential "OPENAI_API_KEY=dummy" \
    --config "OPENAI_BASE_URL=http://host.openshell.internal:8000/v1"
```

### Can't connect to sandbox

```bash
# List available sandboxes
kubectl exec nemoklaw -n nemoklaw -c workspace -- openshell sandbox list

# Check sandbox status
kubectl exec nemoklaw -n nemoklaw -c workspace -- nemoclaw my-assistant status
```

---

## Learn More

- **[NemoClaw Documentation](https://docs.nvidia.com/nemoclaw)** — Full reference for NemoClaw
- **[OpenShell](https://github.com/NVIDIA/OpenShell)** — The sandbox runtime powering NemoKlaw
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
  <b>NemoKlaw</b> — Safe AI agent experimentation on Kubernetes
  <br>
  <sub>Built with NemoClaw + OpenShell + Dynamo</sub>
</p>
