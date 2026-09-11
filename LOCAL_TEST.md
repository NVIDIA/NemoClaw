# Run the Linux Docker experiment

Use Go 1.27.1, Docker, and the OpenShell 0.0.116 `openshell-gateway` executable.
The gateway is a test prerequisite, separate from the NemoClaw bundle. Choose
an external inference server or the managed variant below. The configuration
is for one local developer: its user
API binds to loopback without TLS. Sandbox callbacks authenticate with JWTs.

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

Leave that terminal running. In another terminal in this checkout, start Ollama
on the Docker bridge address. This address is reachable by both the gateway
and the sandbox supervisor. A host loopback address only reaches the gateway.
For managed inference, skip this external-server setup and follow the next section.

```sh
nc_test_dir="$(pwd)/.local/runtime"
nc_test_bridge="$(docker network inspect nc-prototype-test --format '{{(index .IPAM.Config 0).Gateway}}')"
mkdir -p "$nc_test_dir/ollama"
docker run -d --name nc-prototype-test-ollama --network nc-prototype-test \
  -p "$nc_test_bridge:11436:11434" \
  -v "$nc_test_dir/ollama:/root/.ollama" \
  ollama/ollama@sha256:684d8674b4315fa18f4f0e973a118ec2652ed96f67563277839985175858e0ba
docker exec nc-prototype-test-ollama ollama pull qwen3.5:0.8b
docker exec nc-prototype-test-ollama ollama pull qwen3:0.6b
docker build -t nc-prototype-openclaw:2026.9.4 image
docker image inspect nc-prototype-openclaw:2026.9.4 --format '{{index .RepoDigests 0}}'
go run ./tools/bundle
cp examples/local.yaml .local/deployment.yaml
```

Edit `.local/deployment.yaml`: set the inference endpoint to
`http://BRIDGE_ADDRESS:11436/v1` and use the image digest printed above. Choose
a new deployment UUID before using the ordinary CLI. The live test generates
its own fresh UUIDs.

```sh
NEMOCLAW_LIVE_CONFIG="$(pwd)/.local/deployment.yaml" \
NEMOCLAW_LIVE_ALTERNATE_MODEL=qwen3:0.6b \
  go test -tags=live ./internal/engine -run TestLive -count=1 -v
```

The test creates two deployments, checks real inference, and deletes those
deployments after success. It prints the location of retained evidence. On
failure, it leaves the affected state and resources available for inspection.

For interactive experimentation, use the bundle's `bin/nemoclaw` with
`config apply --state-dir .local/deployment --file .local/deployment.yaml`.
Use the same state directory for export and subsequent applies.

After a successful test, remove the Ollama test container with
`docker rm -f nc-prototype-test-ollama`. Stop the foreground gateway with Ctrl-C.
Remove the test network with `docker network rm nc-prototype-test` once no test
sandboxes remain. The model cache and gateway state remain in `.local/runtime`.

## Managed inference variant

Use the gateway setup above and an unused port on its Docker bridge. Build the
OpenClaw image and bundle, then copy the managed example:

```sh
docker build -t nc-prototype-openclaw:2026.9.4 image
docker image inspect nc-prototype-openclaw:2026.9.4 --format '{{index .RepoDigests 0}}'
docker network inspect nc-prototype-test --format '{{(index .IPAM.Config 0).Gateway}}'
go run ./tools/bundle
cp examples/managed-ollama.yaml .local/managed-deployment.yaml
```

Edit the copied YAML: set `ollama.network` to `nc-prototype-test`, use the printed
bridge address in the endpoint, and use the built OpenClaw image digest. Keep
the selected local engine socket explicit. Choose a fresh deployment UUID for
interactive use; the live test generates its own UUIDs.

```sh
NEMOCLAW_LIVE_CONFIG="$(pwd)/.local/managed-deployment.yaml" \
NEMOCLAW_LIVE_ALTERNATE_MODEL=qwen3.5:0.8b \
  go test -tags=live ./internal/engine -run TestLive -count=1 -v
```

This variant creates six resources and downloads the models into an owned named
volume. It checks an unchanged apply, stops Ollama, and expects planning to fail
because the model inventory is unknown. The test verifies unchanged state and
explicitly starts the same container to continue. It then checks a no-op apply,
model change with retained weights, export, and recreation with three agent replies.
The recreated deployment uses another free port on the same host.

On success the harness removes only its two deployments, Ollama containers, and
model volumes. Stop the foreground gateway and remove its test network afterward.
On failure it preserves resources and state for inspection. Reader tests cover
interrupted pull streams and cancellation; a real download interrupted through
OpenTofu remains a separate qualification scenario. This setup does not qualify
Podman, Docker Desktop, or native macOS/Windows operation.
