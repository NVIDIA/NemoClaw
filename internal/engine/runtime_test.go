// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

package engine

import (
	"encoding/json/v2"
	"os"
	"strings"
	"testing"

	"github.com/NVIDIA/NemoClaw/internal/config"
)

func TestInterruptedRuntimeChangeObservesEstablishedSpecification(t *testing.T) {
	f, err := os.Open("../../examples/spark.yaml")
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	d, err := config.Parse(f)
	if err != nil {
		t.Fatal(err)
	}
	old := runtimeSpecs(d, newGenerations())[1]
	encoded := old.JSON()
	// Intent is persisted before mutation. A failed write can leave the previous
	// image in state; refresh must verify that image rather than the new intent.
	old.Service.Image = "next@sha256:" + strings.Repeat("a", 64)
	got, err := boundRuntimeSpec(old, stateBinding{ID: "established", Spec: encoded})
	if err != nil || got.JSON() != encoded || got.JSON() == old.JSON() {
		t.Fatal("interrupted replacement lost the established specification", err)
	}
	old.Owner = "foreign"
	if _, err = boundRuntimeSpec(old, stateBinding{ID: "established", Spec: encoded}); err == nil {
		t.Fatal("foreign ownership accepted from state")
	}
}

func TestRuntimePlanChecksAllActionsBeforeAnyMutation(t *testing.T) {
	gateway, storage, service := "nemoclaw_managed_gateway.runtime", storageAddress, "nemoclaw_inference_service.runtime"
	for _, scenario := range []string{"no-op", "initial", "restart", "explicit image change", "same intent replacement", "storage replacement", "gateway replacement", "forget", "missing", "duplicate", "undeclared", "empty action"} {
		t.Run(scenario, func(t *testing.T) {
			actions := map[string][]string{gateway: {"no-op"}, storage: {"no-op"}, service: {"no-op"}}
			replace := scenario == "explicit image change"
			ok := scenario == "no-op" || scenario == "initial" || scenario == "restart" || replace
			switch scenario {
			case "initial":
				for k := range actions {
					actions[k] = []string{"create"}
				}
			case "restart":
				actions[service] = []string{"update"}
			case "explicit image change", "same intent replacement":
				actions[service] = []string{"delete", "create"}
			case "storage replacement":
				actions[storage] = []string{"delete", "create"}
			case "gateway replacement":
				actions[gateway] = []string{"delete", "create"}
			case "forget":
				actions[service] = []string{"forget"}
			case "missing":
				delete(actions, storage)
			case "undeclared":
				actions["foreign.runtime"] = []string{"create"}
			case "empty action":
				actions[service] = nil
			}
			changes := []map[string]any{}
			for address, action := range actions {
				changes = append(changes, map[string]any{"address": address, "change": map[string]any{"actions": action}})
			}
			if scenario == "duplicate" {
				changes = append(changes, changes[0])
			}
			b, _ := json.Marshal(map[string]any{"resource_changes": changes})
			var plan Plan
			if err := json.Unmarshal(b, &plan); err != nil {
				t.Fatal(err)
			}
			got, err := checkRuntimePlan(plan, map[string]bool{gateway: true, storage: true, service: true}, replace)
			if (err == nil) != ok || (!ok && got != nil) {
				t.Fatal("unsafe or incomplete plan accepted", got, err)
			}
		})
	}
}
