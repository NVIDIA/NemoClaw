//go:build live

// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

package engine

import (
	"bytes"
	"context"
	"encoding/json/v2"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
	"uuid"

	"github.com/NVIDIA/NemoClaw/internal/config"
	oshell "github.com/NVIDIA/NemoClaw/internal/openshell"
	v1 "github.com/NVIDIA/OpenShell/sdk/go/openshell/v1"
)

// Provisioning is exercised through NemoClaw. Runtime requests use native interfaces.
func TestLiveFabric(t *testing.T) {
	file := os.Getenv("NEMOCLAW_LIVE_FABRIC_CONFIG")
	if file == "" {
		t.Skip("set NEMOCLAW_LIVE_FABRIC_CONFIG to an absolute deployment YAML path")
	}
	if !filepath.IsAbs(file) {
		t.Fatal("live config must be absolute")
	}
	b, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	d, err := config.Parse(bytes.NewReader(b))
	if err != nil {
		t.Fatal(err)
	}
	if d.Spec.Gateway.Management != "external" || d.Spec.InferenceProviders[0].Ollama != nil || d.Spec.InferenceProviders[0].Service != nil || d.Spec.Sandboxes[0].Agents[0].Type != "fabric" {
		t.Fatal("Fabric live test requires external gateway/inference and a Fabric harness")
	}
	d.Metadata.UID = uuid.NewV4().String()
	state, err := filepath.Abs("../../.local/fabric-live-" + d.Metadata.UID)
	if err != nil {
		t.Fatal(err)
	}
	bundle, err := filepath.Abs("../../dist/" + runtime.GOOS + "_" + runtime.GOARCH)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(state, 0700); err != nil {
		t.Fatal(err)
	}
	t.Log("evidence and deployment state:", state)
	b, err = d.YAML()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(state, "deployment.yaml"), b, 0600); err != nil {
		t.Fatal(err)
	}
	out := &bytes.Buffer{}
	e := &Engine{StateDir: state, BundleDir: bundle, Output: out}
	save := func(name string, data []byte) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(state, name), data, 0600); err != nil {
			t.Fatal(err)
		}
	}
	run := func(operation string, input []byte, evidence string) {
		t.Helper()
		out.Reset()
		err := e.Run(t.Context(), operation, bytes.NewReader(input))
		save(evidence, out.Bytes())
		if err != nil {
			t.Fatal(err)
		}
	}
	run("apply", b, "apply.json")
	c, err := oshell.Connect(d.Spec.Gateway)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	exec := func(command []string) []byte {
		t.Helper()
		ctx, cancel := context.WithTimeout(t.Context(), 6*time.Minute)
		defer cancel()
		r, err := c.Exec().Run(ctx, d.Workspace(), d.Spec.Sandboxes[0].Name, command, v1.ExecOptions{})
		if err != nil || r.ExitCode != 0 {
			t.Fatal("native runtime command failed", err, r.ExitCode, string(r.Stderr), string(r.Stdout))
		}
		return r.Stdout
	}
	// The private probe has no invocation API. It only identifies the hosted runtime.
	probe := func() string {
		t.Helper()
		result := exec([]string{"/opt/fabric/bin/python", "-c", `import socket,json; s=socket.socket(socket.AF_UNIX); s.connect('/sandbox/fabric.sock'); s.sendall(b'{"operation":"check"}\n'); print(s.makefile().readline())`})
		var response struct {
			RuntimeID string `json:"runtime_id"`
			Ready     bool   `json:"ready"`
		}
		if err := json.Unmarshal(result, &response); err != nil || !response.Ready || response.RuntimeID == "" {
			t.Fatal("missing hosted runtime identity", err)
		}
		return response.RuntimeID
	}
	agent := d.Spec.Sandboxes[0].Agents[0]
	if agent.Harness == "openclaw" {
		save("native-config-set.txt", exec([]string{"/usr/local/bin/openclaw", "config", "set", "--strict-json", "session.dmScope", `"per-channel-peer"`}))
		save("native-channel-disable.txt", exec([]string{"/usr/local/bin/openclaw", "config", "set", "--strict-json", "channels.telegram.enabled", "false"}))
	}
	hostID := probe()
	ids, err := e.stateIDs()
	if err != nil {
		t.Fatal(err)
	}
	run("apply", b, "unchanged-apply.json")
	var result Result
	if err := json.Unmarshal(out.Bytes(), &result); err != nil || len(result.Changes) != 0 {
		t.Fatal("unchanged apply changed resources", err)
	}
	run("export", nil, "export.yaml")
	exported := bytes.Clone(out.Bytes())
	parsed, err := config.Parse(bytes.NewReader(exported))
	if err != nil || parsed.Digest() != d.Digest() {
		t.Fatal("export lost Fabric configuration", err)
	}
	run("apply", exported, "export-reapply.json")
	after, err := e.stateIDs()
	if err != nil {
		t.Fatal(err)
	}
	for address, id := range ids {
		if after[address] != id {
			t.Fatal("resource identity changed", address)
		}
	}
	if probe() != hostID {
		t.Fatal("reconciliation restarted Fabric")
	}
	var response []byte
	if agent.Harness == "openclaw" {
		nativeSetting := exec([]string{"/usr/local/bin/openclaw", "config", "get", "session.dmScope"})
		save("native-config-after.txt", nativeSetting)
		if !strings.Contains(string(nativeSetting), "per-channel-peer") {
			t.Fatal("reconciliation lost native settings")
		}
		params, err := json.Marshal(map[string]any{"agentId": agent.Name, "sessionKey": "agent:" + agent.Name + ":native-live", "message": "Reply with exactly the word FOUR.", "idempotencyKey": uuid.NewV4().String(), "deliver": false})
		if err != nil {
			t.Fatal(err)
		}
		response = exec([]string{"/usr/local/bin/openclaw", "gateway", "call", "agent", "--params", string(params), "--expect-final", "--json", "--timeout", "280000"})
		save("native-agent-result.json", response)
	} else {
		// An independent one-shot SDK smoke test, not an attachment to the hosted runtime.
		response = exec([]string{"/opt/fabric/bin/python", "-c", `import sys,asyncio,json; sys.path.insert(0,'/opt/nemoclaw'); from fabric import configuration; from nemo_fabric import Fabric,FabricConfig; c=configuration(sys.argv[1],sys.argv[2]); c['runtime']['artifacts']='/sandbox/sdk-smoke'; print(json.dumps(asyncio.run(Fabric().run(FabricConfig.model_validate(c),input='Reply with exactly the word FOUR.',base_dir='/sandbox')).to_mapping()))`, agent.Name, agent.Harness})
		save("sdk-smoke-result.json", response)
	}
	if !strings.Contains(strings.ToUpper(string(response)), "FOUR") {
		t.Fatal("no expected actual agent response")
	}
	if probe() != hostID {
		t.Fatal("native/SDK access replaced hosted runtime")
	}
	run("destroy", nil, "destroy.json")
}
