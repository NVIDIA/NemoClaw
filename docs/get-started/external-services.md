# Set up external services

Use this local Docker topology to supply the gateway and inference prerequisites for a deployment.
Run commands from the repository root.

## Prerequisites and access

Use the [pinned Go toolchain](../reference/dependencies.md), Docker, and the `openshell-gateway` executable selected by the [dependency pins](../reference/dependencies.md).
The gateway is a prerequisite separate from the NemoClaw bundle.
This configuration is for one local developer: its user API binds to loopback without TLS and permits unauthenticated users.
Sandbox callbacks authenticate with JWTs.
Use a fresh `.local/runtime` directory for a new test; do not overwrite keys or configuration used by an existing deployment.
The commands download an Ollama image and two models and retain their cache on disk.

## Start the gateway

From this checkout, create a private directory and gateway keys:

```sh
nc_test_dir="$(pwd)/.local/runtime"
mkdir -p "$nc_test_dir"
chmod 700 "$nc_test_dir"
openshell-gateway generate-certs --output-dir "$nc_test_dir/tls" --server-san 127.0.0.1
cat > "$nc_test_dir/gateway.toml" <<EOF
[openshell.drivers.docker]
network_name = "nc-prototype-test"
ssh_socket_path = "$nc_test_dir/ssh"

[openshell.gateway.gateway_jwt]
signing_key_path = "$nc_test_dir/tls/jwt/signing.pem"
public_key_path = "$nc_test_dir/tls/jwt/public.pem"
kid_path = "$nc_test_dir/tls/jwt/kid"
gateway_id = "nc-prototype-test"
ttl_secs = 0

[openshell.gateway.auth]
allow_unauthenticated_users = true
EOF
openshell-gateway --config "$nc_test_dir/gateway.toml" \
  --name nc-prototype-test --port 17671 --drivers docker --disable-tls \
  --db-url "sqlite:$nc_test_dir/gateway.db"
```

## Start inference

Leave that terminal running.
In another terminal in this checkout, start Ollama on the Docker bridge address.
This address is reachable by both the gateway and the sandbox supervisor.
A host loopback address only reaches the gateway.
For managed inference, skip this external-server setup and follow [managed Ollama](../guides/managed-ollama.md).

Copy `spec.inferenceProviders[0].ollama.image` from [the managed Ollama example](../../examples/managed-ollama.yaml).
Replace `IMAGE_REFERENCE` in the following command with that complete immutable reference:

```sh
nc_ollama_image='IMAGE_REFERENCE'
nc_test_dir="$(pwd)/.local/runtime"
nc_test_bridge="$(docker network inspect nc-prototype-test --format '{{(index .IPAM.Config 0).Gateway}}')"
mkdir -p "$nc_test_dir/ollama"
docker run -d --name nc-prototype-test-ollama --network nc-prototype-test \
  -p "$nc_test_bridge:11436:11434" \
  -v "$nc_test_dir/ollama:/root/.ollama" \
  "$nc_ollama_image"
docker exec nc-prototype-test-ollama ollama pull qwen3.5:0.8b
docker exec nc-prototype-test-ollama ollama pull qwen3:0.6b
```

## Verify and continue

Confirm that both model pulls succeed.
Before deployment, wait for a successful response from the selected model:

```sh
docker exec nc-prototype-test-ollama ollama run qwen3.5:0.8b 'Reply with FOUR.'
```

A cold model can exceed OpenShell's endpoint-validation deadline.
Use `http://BRIDGE_ADDRESS:11436/v1` as the inference endpoint, replacing `BRIDGE_ADDRESS` with the printed network address.
Use `http://127.0.0.1:17671` as the gateway endpoint.
Continue with [Deploy an agent](deploy.md) or [Deploy a Fabric runtime](../guides/fabric.md).

If a service fails to start, inspect its terminal output or `docker logs nc-prototype-test-ollama`.
Resolve the reported port, network, or model error before applying a deployment.
Do not remove gateway state to bypass an error in an established deployment.

## Remove the test services

First [destroy deployments](../guides/lifecycle.md#destroy-a-deployment) that depend on this gateway.
The following command stops inference and removes only the named test container:

```sh
docker rm -f nc-prototype-test-ollama
```

Stop the foreground gateway with Ctrl+C.
Once no test sandboxes remain, remove the test network:

```sh
docker network rm nc-prototype-test
```

The model cache, gateway database, and keys remain in `.local/runtime`.
Keep them for deployments you intend to resume.
Remove that directory only after retiring its deployments and deciding you no longer need its data or credentials.
