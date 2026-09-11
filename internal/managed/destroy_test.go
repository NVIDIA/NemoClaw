// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

package managed

import (
	"testing"
)

func TestDestroyProcessRetainsStorageAndDoesNotRestart(t *testing.T) {
	for _, stopped := range []bool{false, true} {
		t.Run(map[bool]string{false: "running", true: "watchdog stopped"}[stopped], func(t *testing.T) {
			f := newRuntimeFixture(t)
			f.Container.State.Running = !stopped
			o, err := f.Docker.Observe(t.Context(), f.Spec, "")
			if err != nil {
				t.Fatal(err)
			}
			volume := *f.Volume
			if err = f.Docker.RemoveContainer(t.Context(), f.Spec, o.ID); err != nil {
				t.Fatal(err)
			}
			if f.Container != nil || f.Volume.Name != volume.Name || f.Volume.CreatedAt != volume.CreatedAt || f.Removes != 1 || f.Starts != 0 {
				t.Fatal("teardown replaced data or restarted a runtime")
			}
			writes := f.Writes
			if err = f.Docker.RemoveContainer(t.Context(), f.Spec, o.ID); err != nil || f.Writes != writes {
				t.Fatal("confirmed absence repeated mutation", err)
			}
			if _, err = f.Docker.Observe(t.Context(), f.Spec, o.ID); err == nil {
				t.Fatal("ordinary refresh accepted missing process as recreation permission")
			}
		})
	}
}

func TestDestroyProcessRejectsFailuresAndChangedBindings(t *testing.T) {
	for _, scenario := range []string{"authentication", "transport", "partial", "foreign", "generation", "new container", "new storage", "wrong engine", "missing storage", "missing container failed storage"} {
		t.Run(scenario, func(t *testing.T) {
			f := newRuntimeFixture(t)
			o, err := f.Docker.Observe(t.Context(), f.Spec, "")
			if err != nil {
				t.Fatal(err)
			}
			switch scenario {
			case "authentication":
				f.Unavailable, f.Code = "containers", 403
			case "transport":
				f.Unavailable, f.Code = "networks", 503
			case "partial":
				f.Container.State = nil
			case "foreign":
				f.Container.Config.Labels[OwnerLabel] = "other"
			case "generation":
				f.Volume.Labels[GenerationLabel] = "other"
			case "new container":
				f.Container.ID = "replacement"
			case "new storage":
				f.Volume.CreatedAt = "later"
			case "wrong engine":
				o.ID = "other/container-id/created-once/network-id"
			case "missing storage":
				f.Volume = nil
			case "missing container failed storage":
				f.Container = nil
				f.Unavailable, f.Code = "volumes", 403
			}
			if err = f.Docker.RemoveContainer(t.Context(), f.Spec, o.ID); err == nil || f.Writes != 0 {
				t.Fatal("failed observation or changed identity permitted deletion", err)
			}
		})
	}
}
