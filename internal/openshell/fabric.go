// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

package openshell

import (
	"context"
	"encoding/json/v2"
	"errors"
	"time"

	v1 "github.com/NVIDIA/OpenShell/sdk/go/openshell/v1"
)

func isFabric(runtime []string) bool {
	return len(runtime) > 0 && (runtime[0] == "fabric-deepagents" || runtime[0] == "fabric-hermes")
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
	if len(runtime) > 0 && runtime[0] == "fabric-hermes" {
		env["NEMOCLAW_FABRIC_HARNESS"] = "hermes"
	}
	return env
}

func fabricCheck(ctx context.Context, c Client, workspace, sandbox, agent string, runtime ...string) error {
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	command := []string{"/opt/fabric/bin/python", "/opt/nemoclaw/fabric.py", "check", agent}
	if len(runtime) > 0 && runtime[0] == "fabric-hermes" {
		command = append(command, "hermes")
	}
	r, err := c.Exec().Run(ctx, workspace, sandbox, command, v1.ExecOptions{})
	if err != nil || r.ExitCode != 0 {
		return errors.New("Fabric runtime or configuration cannot be independently established")
	}
	return nil
}

// FabricInvoke sends one request without retry: a lost response may have had effects.
func FabricInvoke(ctx context.Context, c Client, workspace, sandbox, prompt string) ([]byte, error) {
	if len(prompt) == 0 || len(prompt) > 64<<10 {
		return nil, errors.New("prompt must contain 1 to 65536 bytes")
	}
	ctx, cancel := context.WithTimeout(ctx, 6*time.Minute)
	defer cancel()
	r, err := c.Exec().Run(ctx, workspace, sandbox, []string{"/opt/fabric/bin/python", "/opt/nemoclaw/fabric.py", "invoke", prompt}, v1.ExecOptions{})
	if err != nil {
		return nil, errors.New("Fabric response was not received; request is not retried because it may have had effects")
	}
	if len(r.Stdout) > 4<<20 {
		return nil, errors.New("Fabric response exceeds the result limit")
	}
	var result struct {
		Status       string `json:"status"`
		RuntimeID    string `json:"runtime_id"`
		InvocationID string `json:"invocation_id"`
	}
	if json.Unmarshal(r.Stdout, &result) != nil || result.RuntimeID == "" || result.InvocationID == "" {
		return nil, errors.New("Fabric returned an invalid invocation result")
	}
	if r.ExitCode != 0 || result.Status != "succeeded" {
		return r.Stdout, errors.New("Fabric invocation failed; inspect the returned result; request is not retried")
	}
	return r.Stdout, nil
}
