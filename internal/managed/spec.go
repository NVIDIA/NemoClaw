// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

package managed

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json/v2"
	"errors"
	"fmt"
	"net/netip"
	"net/url"
	"regexp"

	"github.com/NVIDIA/NemoClaw/internal/config"
	"github.com/NVIDIA/NemoClaw/internal/spark"
	"github.com/moby/moby/api/types/container"
	"github.com/moby/moby/api/types/mount"
	"github.com/moby/moby/api/types/network"
)

const GatewayKind = "managed_gateway"
const ServiceKind = "inference_service"
const OwnerLabel = "nemoclaw.nvidia.com/uid"
const GenerationLabel = "nemoclaw.nvidia.com/generation"
const specLabel = "nemoclaw.nvidia.com/runtime-spec"
const SupervisorImage = "ghcr.io/nvidia/openshell/supervisor@sha256:c8c42aef16c200063e32cbf72e553e4ead027085427b555efafd95063ecead42"
const SupervisorSHA256 = "7052a87d2b46ef52ecc0f7c64b9bac008dd3010c467881b0648045334eb0ed1d"

type Spec struct {
	Kind       string         `json:"kind"`
	Name       string         `json:"name"`
	Owner      string         `json:"owner"`
	Generation string         `json:"generation"`
	Gateway    config.Gateway `json:"gateway"`
	Service    *spark.Service `json:"service,omitempty"`
}

func (s Spec) Validate() error {
	if !regexp.MustCompile(`^nc-[a-f0-9]{16}-(gateway|inference)$`).MatchString(s.Name) || !regexp.MustCompile(`^[a-f0-9-]{36}$`).MatchString(s.Owner) || !regexp.MustCompile(`^[a-f0-9]{32}$`).MatchString(s.Generation) {
		return errors.New("managed resource lacks ownership or generation")
	}
	if err := s.Gateway.ValidateManaged(); err != nil {
		return err
	}
	if s.Kind == GatewayKind && s.Service == nil {
		return nil
	}
	if s.Kind == ServiceKind && s.Service != nil {
		return s.Service.Validate()
	}
	return errors.New("invalid managed runtime kind")
}
func (s Spec) JSON() string { b, _ := json.Marshal(s); return string(b) }
func (s Spec) labels() map[string]string {
	h := sha256.Sum256([]byte(s.JSON()))
	return map[string]string{OwnerLabel: s.Owner, GenerationLabel: s.Generation, specLabel: hex.EncodeToString(h[:])}
}
func (s Spec) Volume() string  { return s.Name + "-data" }
func (s Spec) Network() string { return "nc-" + deploymentHash(s.Owner) + "-network" }
func deploymentHash(uid string) string {
	h := sha256.Sum256([]byte(uid))
	return hex.EncodeToString(h[:8])
}
func (s Spec) Image() string {
	if s.Service != nil {
		return s.Service.Image
	}
	return s.Gateway.Image
}

func (s Spec) Container(dataPath string) (*container.Config, *container.HostConfig) {
	c := &container.Config{Image: s.Image(), Labels: s.labels()}
	h := &container.HostConfig{CapDrop: []string{"ALL"}, SecurityOpt: []string{"no-new-privileges"}, RestartPolicy: container.RestartPolicy{Name: container.RestartPolicyDisabled}, LogConfig: container.LogConfig{Type: "json-file", Config: map[string]string{"max-size": "32m", "max-file": "3"}}}
	if s.Kind == GatewayKind {
		u, _ := url.Parse(s.Gateway.Endpoint)
		c.User = "0:0"
		c.Entrypoint = []string{"/usr/local/bin/openshell-gateway"}
		c.Cmd = []string{"--config", dataPath + "/gateway.toml", "--name", s.Name, "--bind-address", "127.0.0.1", "--port", u.Port(), "--drivers", "docker", "--disable-tls", "--db-url", "sqlite:" + dataPath + "/gateway.db"}
		h.NetworkMode = "host"
		h.Mounts = []mount.Mount{{Type: mount.TypeVolume, Source: s.Volume(), Target: dataPath}, {Type: mount.TypeBind, Source: "/var/run/docker.sock", Target: "/var/run/docker.sock"}}
	} else {
		c.Entrypoint = []string{"/usr/local/bin/nemoclaw-spark"}
		c.Cmd = []string{}
		b, _ := json.Marshal(s.Service)
		c.Env = []string{"NEMOCLAW_SPARK_SPEC=" + string(b)}
		h.NetworkMode = container.NetworkMode(s.Network())
		h.Mounts = []mount.Mount{{Type: mount.TypeVolume, Source: s.Volume(), Target: "/data"}}
		h.ShmSize = 8 * spark.GiB
		h.Resources = container.Resources{Memory: 104 * spark.GiB, MemorySwap: 104 * spark.GiB, DeviceRequests: []container.DeviceRequest{{Count: -1, Capabilities: [][]string{{"gpu"}}}}, Ulimits: []*container.Ulimit{{Name: "memlock", Soft: -1, Hard: -1}, {Name: "stack", Soft: 67108864, Hard: 67108864}}}
		port, _ := network.ParsePort(fmt.Sprintf("%d/tcp", s.Service.Serving.Port))
		h.PortBindings = network.PortMap{port: {{HostIP: netip.MustParseAddr(s.Gateway.Bridge()), HostPort: fmt.Sprint(s.Service.Serving.Port)}}}
	}
	return c, h
}

func (s Spec) GatewayConfig(dataPath string) []byte {
	return []byte(fmt.Sprintf("[openshell.drivers.docker]\nnetwork_name = %q\nssh_socket_path = %q\nsupervisor_bin = %q\n\n[openshell.gateway.gateway_jwt]\nsigning_key_path = %q\npublic_key_path = %q\nkid_path = %q\ngateway_id = %q\nttl_secs = 0\n\n[openshell.gateway.auth]\nallow_unauthenticated_users = true\n", s.Network(), dataPath+"/ssh", dataPath+"/openshell-sandbox", dataPath+"/tls/jwt/signing.pem", dataPath+"/tls/jwt/public.pem", dataPath+"/tls/jwt/kid", s.Name))
}
