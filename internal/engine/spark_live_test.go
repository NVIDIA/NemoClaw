//go:build live

// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

package engine

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json/v2"
	"maps"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/NVIDIA/NemoClaw/internal/config"
	"github.com/NVIDIA/NemoClaw/internal/managed"
	"github.com/NVIDIA/NemoClaw/internal/spark"
	"github.com/moby/moby/client"
)

// This opt-in test retains its deployment and model data, including on failure.
// It deliberately trips only the declared service's supervisor, never host RAM.
func TestLiveSparkLifecycle(t *testing.T) {
	input, state := os.Getenv("NEMOCLAW_LIVE_SPARK_CONFIG"), os.Getenv("NEMOCLAW_LIVE_SPARK_STATE")
	if input == "" || state == "" {
		t.Skip("set explicit Spark configuration and state paths")
	}
	f, err := os.Open(input)
	if err != nil {
		t.Fatal(err)
	}
	d, err := config.Parse(f)
	f.Close()
	if err != nil || d.Spec.Gateway.Management != "managed" || d.Spec.InferenceProviders[0].Service == nil {
		t.Fatal("managed Spark configuration required", err)
	}
	bundle, err := filepath.Abs("../../dist/linux_arm64")
	if err != nil {
		t.Fatal(err)
	}
	var output bytes.Buffer
	e := &Engine{StateDir: state, BundleDir: bundle, Output: &output}
	evidence := map[string]any{"started": time.Now().UTC(), "deployment": d.Metadata.UID, "passed": false}
	evidencePath := filepath.Join(state, "spark-validation.json")
	t.Log("retained evidence:", evidencePath)
	defer func() {
		evidence["finished"] = time.Now().UTC()
		if err := saveJSON(evidencePath, evidence); err != nil {
			t.Error(err)
		}
	}()
	run := func(operation string, document config.Document) Result {
		t.Helper()
		output.Reset()
		b, err := document.YAML()
		if err != nil {
			t.Fatal(err)
		}
		if err = e.Run(t.Context(), operation, bytes.NewReader(b)); err != nil {
			t.Fatal(err)
		}
		var result Result
		if err = json.Unmarshal(output.Bytes(), &result); err != nil {
			t.Fatal(err)
		}
		return result
	}
	evidence["initialApply"] = run("apply", d)
	before := captureSpark(t, e, d)
	evidence["before"] = before
	unchanged := run("apply", d)
	if len(unchanged.Changes) != 0 || unchanged.AgentResponse == "" {
		t.Fatal("unchanged apply changed resources or lacked an agent reply", unchanged)
	}
	evidence["unchangedApply"] = unchanged
	if after := captureSpark(t, e, d); !reflect.DeepEqual(before, after) {
		t.Fatal("unchanged apply changed identities or artifact receipts")
	}
	output.Reset()
	if err = e.Run(t.Context(), "export", nil); err != nil {
		t.Fatal(err)
	}
	exported, err := config.Parse(bytes.NewReader(output.Bytes()))
	if err != nil || exported.Digest() != d.Digest() {
		t.Fatal("export changed pinned desired configuration", err)
	}
	if err = os.WriteFile(filepath.Join(state, "spark-export.yaml"), output.Bytes(), 0600); err != nil {
		t.Fatal(err)
	}
	reapplied := run("apply", exported)
	if len(reapplied.Changes) != 0 || !reflect.DeepEqual(before, captureSpark(t, e, d)) {
		t.Fatal("export/reapply changed resources or artifact receipts")
	}
	evidence["exportReapply"] = reapplied
	// A larger declared reserve is rejected arithmetically, without allocating RAM.
	bad, err := config.Parse(bytes.NewReader(outputYAML(t, d)))
	if err != nil {
		t.Fatal(err)
	}
	bad.Spec.InferenceProviders[0].Service.Memory.HostReserveGiB = 64
	output.Reset()
	err = e.Run(t.Context(), "plan", bytes.NewReader(outputYAML(t, bad)))
	if err == nil || !strings.Contains(err.Error(), "host memory reserve") || !reflect.DeepEqual(before, captureSpark(t, e, d)) {
		t.Fatal("capacity rejection changed resources", err)
	}
	evidence["capacityRejection"] = err.Error()
	r, err := loadRecord(state)
	if err != nil {
		t.Fatal(err)
	}
	spec := runtimeSpecs(d, r.Generations)[1]
	docker, err := managed.New(d.Spec.Gateway.Engine)
	if err != nil {
		t.Fatal(err)
	}
	defer docker.Close()
	bound := before.IDs[runtimeAddress(spec)]
	o, err := docker.Observe(t.Context(), spec, bound)
	if err != nil || o == nil || !o.Running {
		t.Fatal("owned running service is unobservable", err)
	}
	if _, err = docker.API.ContainerKill(t.Context(), o.ContainerID, client.ContainerKillOptions{Signal: "USR1"}); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(60 * time.Second)
	for {
		o, err = docker.Observe(t.Context(), spec, bound)
		if err != nil {
			t.Fatal(err)
		}
		if !o.Running {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("watchdog did not stop inference")
		}
		time.Sleep(time.Second)
	}
	status, err := docker.Status(t.Context(), o)
	if err != nil || status.Phase != "stopped" {
		t.Fatal("watchdog shutdown has no durable status", err)
	}
	evidence["watchdogStop"] = status
	for range 10 {
		time.Sleep(time.Second)
		o, err = docker.Observe(t.Context(), spec, bound)
		if err != nil || o.Running {
			t.Fatal("watchdog entered an automatic restart loop", err)
		}
	}
	plan := run("plan", d)
	if len(plan.Changes) != 1 || plan.Changes[0].Resource != runtimeAddress(spec) || !reflect.DeepEqual(plan.Changes[0].Actions, []string{"update"}) {
		t.Fatal("stopped runtime plan would replace resources", plan)
	}
	if o, err = docker.Observe(t.Context(), spec, bound); err != nil || o.Running {
		t.Fatal("plan restarted inference", err)
	}
	evidence["stoppedPlan"] = plan
	recovered := run("apply", d)
	if !reflect.DeepEqual(before, captureSpark(t, e, d)) || len(recovered.Changes) != 1 || recovered.AgentResponse == "" {
		t.Fatal("watchdog recovery lost identities, repeated artifact work, or failed inference", recovered)
	}
	evidence["recoveryApply"] = recovered
	evidence["after"] = captureSpark(t, e, d)
	evidence["passed"] = true
}

func outputYAML(t *testing.T, d config.Document) []byte {
	t.Helper()
	b, err := d.YAML()
	if err != nil {
		t.Fatal(err)
	}
	return b
}

type sparkCapture struct {
	IDs      map[string]string
	Receipts map[string]string
}

func captureSpark(t *testing.T, e *Engine, d config.Document) sparkCapture {
	t.Helper()
	ids, err := e.stateIDs()
	if err != nil {
		t.Fatal(err)
	}
	stage := &Engine{StateDir: filepath.Join(e.StateDir, "runtime")}
	runtimeIDs, err := stage.stateIDs()
	if err != nil || len(ids) != 4 || len(runtimeIDs) != 3 {
		t.Fatal("incomplete resource bindings", err)
	}
	maps.Copy(ids, runtimeIDs)
	r, err := loadRecord(e.StateDir)
	if err != nil {
		t.Fatal(err)
	}
	docker, err := managed.New(d.Spec.Gateway.Engine)
	if err != nil {
		t.Fatal(err)
	}
	defer docker.Close()
	spec := runtimeSpecs(d, r.Generations)[1]
	o, err := docker.Observe(t.Context(), spec, ids[runtimeAddress(spec)])
	if err != nil || o == nil {
		t.Fatal(err)
	}
	if err = docker.VerifyArtifacts(t.Context(), o); err != nil {
		t.Fatal(err)
	}
	receipts := map[string]string{}
	for _, p := range []string{"/data/models/" + spark.ModelManifest().Revision + "/.nemoclaw-complete.json", "/data/prepared/" + spark.PreparationKey() + "/complete.json"} {
		b, err := docker.ReadFile(t.Context(), o.ContainerID, p, 1<<20)
		if err != nil {
			t.Fatal(err)
		}
		h := sha256.Sum256(b)
		stat, err := docker.API.ContainerStatPath(t.Context(), o.ContainerID, client.ContainerStatPathOptions{Path: p})
		if err != nil {
			t.Fatal(err)
		}
		receipts[p] = hex.EncodeToString(h[:]) + "/" + stat.Stat.Mtime.Format(time.RFC3339Nano)
	}
	return sparkCapture{IDs: ids, Receipts: receipts}
}
