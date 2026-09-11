// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

package managed

import (
	"archive/tar"
	"encoding/json/v2"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/moby/moby/api/types/container"
	"github.com/moby/moby/client"
)

func TestGatewayStorageSurvivesProcessReplacementAndRejectsFailedObservation(t *testing.T) {
	for _, failure := range []string{"none", "authentication", "transport", "partial", "missing bound dependency", "key drift", "mount drift", "generation drift"} {
		t.Run(failure, func(t *testing.T) {
			f := newRuntimeFixture(t)
			s := f.Spec
			s.Kind, s.Name, s.Service = GatewayKind, "nc-68d203b0c7e6083f-gateway", nil
			f.Volume.Name, f.Volume.Mountpoint, f.Volume.Labels = s.Volume(), "/var/lib/docker/volumes/"+s.Volume()+"/_data", s.labels()
			f.Network.Labels = s.labels()
			helper := container.InspectResponse{ID: "initializer", Config: &container.Config{Image: s.Image(), Labels: s.labels()}, State: &container.State{Status: "exited"}, Mounts: []container.MountPoint{{Name: s.Volume(), Destination: f.Volume.Mountpoint}}}
			fault, writes := false, 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method != "GET" {
					writes++
					w.WriteHeader(500)
					return
				}
				p := r.URL.Path
				if strings.HasSuffix(p, "/info") {
					fmt.Fprint(w, `{"ID":"engine"}`)
					return
				}
				if fault && strings.Contains(p, "/volumes/") {
					switch failure {
					case "authentication":
						w.WriteHeader(403)
						return
					case "transport":
						w.WriteHeader(503)
						return
					case "partial":
						fmt.Fprint(w, `{}`)
						return
					case "missing bound dependency":
						w.WriteHeader(404)
						return
					case "generation drift":
						f.Volume.Labels[GenerationLabel] = "changed"
					}
				}
				switch {
				case strings.Contains(p, "/volumes/"):
					json.MarshalWrite(w, f.Volume)
				case strings.Contains(p, "/networks/"):
					json.MarshalWrite(w, f.Network)
				case strings.HasSuffix(p, "/archive"):
					w.Header().Set("X-Docker-Container-Path-Stat", "e30=")
					name := r.URL.Query().Get("path")
					data := s.GatewayConfig(f.Volume.Mountpoint)
					if strings.HasSuffix(name, "public.pem") {
						data = []byte("public signing identity")
						if fault && failure == "key drift" {
							data = []byte("other key")
						}
					}
					if strings.HasSuffix(name, "key-encryption-key.bin") {
						data = []byte(strings.Repeat("k", 32))
					}
					a := tar.NewWriter(w)
					a.WriteHeader(&tar.Header{Name: "file", Mode: 0600, Size: int64(len(data))})
					a.Write(data)
					a.Close()
				case strings.Contains(p, s.Name+"-initialize"):
					if fault && failure == "mount drift" {
						helper.Mounts[0].Name = "foreign"
					}
					json.MarshalWrite(w, helper)
				default:
					t.Errorf("read depends on replaceable gateway process: %s", p)
					w.WriteHeader(500)
				}
			}))
			defer server.Close()
			api, err := client.New(client.WithHost(server.URL), client.WithAPIVersion("1.53"))
			if err != nil {
				t.Fatal(err)
			}
			defer api.Close()
			d := &Docker{API: api}
			id, err := d.GatewayStorage(t.Context(), s, "", false)
			if err != nil || id == "" {
				t.Fatal(id, err)
			}
			fault = true
			got, err := d.GatewayStorage(t.Context(), s, id, false)
			if failure == "none" {
				if err != nil || got != id {
					t.Fatal("gateway process replacement lost persistent identity", err)
				}
			} else if err == nil || got != "" {
				t.Fatal("failed observation became absence or accepted drift", got, err)
			}
			if writes != 0 {
				t.Fatal("storage refresh mutated resources")
			}
		})
	}
}

func TestGatewayTokenStateIsVisibleAtTheSameHostPath(t *testing.T) {
	s := newRuntimeFixture(t).Spec
	s.Kind, s.Name, s.Service, s.Layout = GatewayKind, "nc-68d203b0c7e6083f-gateway", nil, 1
	path := "/var/lib/docker/volumes/" + s.Volume() + "/_data"
	c, h := s.Container(path)
	if len(c.Env) != 1 || c.Env[0] != "XDG_STATE_HOME="+path+"/state" || h.Mounts[0].Target != path || h.Mounts[0].Source != s.Volume() {
		t.Fatal("sandbox tokens would be written outside the host-visible persistent volume")
	}
}
