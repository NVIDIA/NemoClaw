// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

package openshell

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/NVIDIA/NemoClaw/internal/config"

	v1 "github.com/NVIDIA/OpenShell/sdk/go/openshell/v1"
)

func isFabric(runtime []string) bool {
	if len(runtime) == 0 {
		return false
	}
	harness, ok := strings.CutPrefix(runtime[0], "fabric-")
	return ok && config.IsFabricHarness(harness)
}

func fabricEnvironment(name string, runtime ...string) map[string]string {
	env := map[string]string{
		"ADAPTER_PYTHON": "/opt/fabric/bin/python",
		"HOME":           "/sandbox", "TMPDIR": "/sandbox/tmp", "XDG_CACHE_HOME": "/sandbox/.cache",
		"NEMOCLAW_AGENT_NAME": name, "OPENAI_API_KEY": "openshell-placeholder",
		"SSL_CERT_FILE":           "/etc/ssl/certs/ca-certificates.crt",
		"NODE_EXTRA_CA_CERTS":     "/etc/ssl/certs/ca-certificates.crt",
		"PYTHONDONTWRITEBYTECODE": "1", "PATH": "/opt/fabric/bin:/usr/local/bin:/usr/bin:/bin",
	}
	if isFabric(runtime) && runtime[0] != "fabric-deepagents" {
		env["NEMOCLAW_FABRIC_HARNESS"] = strings.TrimPrefix(runtime[0], "fabric-")
		if runtime[0] == "fabric-openclaw" {
			env["PYTHONPATH"] = "/opt/nemoclaw"
		}
	}
	if len(runtime) > 0 && runtime[0] == "fabric-mini-swe-agent" {
		env["MSWEA_COST_TRACKING"] = "ignore_errors"
	}
	return env
}

func fabricCheck(ctx context.Context, c Client, workspace, sandbox, agent string, runtime ...string) error {
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	command := []string{"/opt/fabric/bin/python", "/opt/nemoclaw/fabric.py", "check", agent}
	if isFabric(runtime) && runtime[0] != "fabric-deepagents" {
		command = append(command, strings.TrimPrefix(runtime[0], "fabric-"))
	}
	r, err := c.Exec().Run(ctx, workspace, sandbox, command, v1.ExecOptions{})
	if err != nil || r.ExitCode != 0 {
		return errors.New("Fabric runtime or configuration cannot be independently established")
	}
	return nil
}
