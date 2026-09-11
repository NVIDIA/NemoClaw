// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

package engine

import (
	"encoding/json/v2"
	"testing"

	oshell "github.com/NVIDIA/NemoClaw/internal/openshell"
)

func TestDestroyPlanRejectsActionsOutsideBoundTeardown(t *testing.T) {
	for _, scenario := range []string{"safe", "create", "update", "forget", "replace", "delete storage", "missing storage", "missing process", "foreign", "new id", "unknown", "duplicate"} {
		t.Run(scenario, func(t *testing.T) {
			service := "nemoclaw_inference_service.runtime"
			changes := []map[string]any{
				{"address": service, "change": map[string]any{"actions": []string{"delete"}, "before": map[string]any{"id": "process", "spec": "owned"}}},
				{"address": storageAddress, "change": map[string]any{"actions": []string{"no-op"}, "before": map[string]any{"id": "data", "spec": "volume"}}},
			}
			first := changes[0]["change"].(map[string]any)
			switch scenario {
			case "create", "update", "forget":
				first["actions"] = []string{scenario}
			case "replace":
				first["actions"] = []string{"delete", "create"}
			case "delete storage":
				changes[1]["change"].(map[string]any)["actions"] = []string{"delete"}
			case "missing storage":
				changes = changes[:1]
			case "missing process":
				changes = changes[1:]
			case "foreign":
				first["before"].(map[string]any)["spec"] = "foreign"
			case "new id":
				first["before"].(map[string]any)["id"] = "other"
			case "unknown":
				changes[0]["address"] = "other.runtime"
			case "duplicate":
				changes = append(changes, changes[0])
			}
			b, err := json.Marshal(map[string]any{"resource_changes": changes})
			if err != nil {
				t.Fatal(err)
			}
			var plan Plan
			if err = json.Unmarshal(b, &plan); err != nil {
				t.Fatal(err)
			}
			bindings := map[string]stateBinding{service: {ID: "process", Spec: "owned"}, storageAddress: {ID: "data", Spec: "volume"}}
			allowed := map[string]oshell.Row{service: {"spec": "owned"}, storageAddress: {"spec": "volume"}}
			got, err := checkDestroyPlan(plan, bindings, allowed, map[string]bool{storageAddress: true})
			if (err == nil) != (scenario == "safe") || (err != nil && got != nil) {
				t.Fatal("unsafe plan accepted", got, err)
			}
		})
	}
}
