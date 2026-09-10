import { describe, expect, it } from "vitest";

import { buildDockerDriverGatewayConfigToml } from "../../src/lib/onboard/docker-driver-gateway-config.js";
import { PORTABLE_HOST_GATEWAY_IP } from "../../src/lib/onboard/experimental/portable-profile.js";
import { CURRENT_RUNTIME_PROVIDER_BUNDLES } from "../../src/lib/onboard/runtime-provider/current.js";
import { prepareNativePodmanGatewayHostRuntime } from "../../src/lib/onboard/runtime-provider/podman-runtime-surfaces.js";
import { requireRuntimeProviderBundle } from "../../src/lib/onboard/runtime-provider/registry.js";


describe("OpenShell 0.0.101 executable contracts", () => {
  it.each([{ scenario: "Docker" }, { scenario: "Podman" }])(
    "selects only Docker or Podman without configuring new v0.0.101 surfaces [$scenario] (#8599)",
    ({ scenario }) => {
      const untrustedNewSurfaceInputs = {
        OPENSHELL_CREDENTIAL_DRIVERS: "vault",
        OPENSHELL_CREDENTIAL_STORAGE: "/untrusted/store",
        OPENSHELL_DEFAULT_CREDENTIAL_DRIVER: "vault",
        OPENSHELL_EGRESS_ADAPTER: "unreviewed",
        OPENSHELL_VM_RUNTIME: "unreviewed",
      };
      const dockerEnv = {
        ...untrustedNewSurfaceInputs,
        OPENSHELL_DRIVERS: "vm",
        OPENSHELL_GRPC_ENDPOINT: "https://127.0.0.1:8080",
        OPENSHELL_DOCKER_NETWORK_NAME: "openshell-docker",
        OPENSHELL_DOCKER_SUPERVISOR_IMAGE: "supervisor:test",
      };
      const dockerProvider = requireRuntimeProviderBundle(
        "docker",
        CURRENT_RUNTIME_PROVIDER_BUNDLES,
      );
      expect(dockerProvider.gateway.supported).toBe(true);
      const dockerGateway = dockerProvider.gateway as Extract<
        typeof dockerProvider.gateway,
        { readonly supported: true }
      >;
      const dockerToml = buildDockerDriverGatewayConfigToml(
        dockerEnv,
        undefined,
        undefined,
        "nemoclaw",
        dockerGateway.prepareHostRuntime({
          environment: process.env,
          platform: process.platform,
        }),
      );
      const podmanEnv = {
        ...untrustedNewSurfaceInputs,
        OPENSHELL_DRIVERS: "podman",
        OPENSHELL_GRPC_ENDPOINT: `https://${PORTABLE_HOST_GATEWAY_IP}:8080`,
        OPENSHELL_DOCKER_NETWORK_NAME: "openshell-podman",
        OPENSHELL_DOCKER_SUPERVISOR_IMAGE: "supervisor:test",
        OPENSHELL_PODMAN_SOCKET: "/run/user/1001/podman/podman.sock",
      };
      const podmanToml = buildDockerDriverGatewayConfigToml(
        podmanEnv,
        undefined,
        undefined,
        "nemoclaw",
        prepareNativePodmanGatewayHostRuntime({
          environment: process.env,
          platform: "linux",
          socketPath: podmanEnv.OPENSHELL_PODMAN_SOCKET,
        }),
      );

      expect(dockerToml).toContain('compute_drivers = ["docker"]');
      expect(dockerToml).toContain("[openshell.drivers.docker]");
      expect(podmanToml).toContain('compute_drivers = ["podman"]');
      expect(podmanToml).toContain("[openshell.drivers.podman]");
      expect(podmanToml).toContain('socket_path = "/run/user/1001/podman/podman.sock"');
      const toml = ({ Docker: dockerToml, Podman: podmanToml } as const)[scenario]!;
      expect(toml).not.toMatch(/credential_(?:drivers|storage)|default_credential_driver/iu);
      expect(toml).not.toContain("[openshell.drivers.vm]");
      expect(toml).not.toMatch(/egress_adapter|sdk\/go/iu);
    },
  );
});
