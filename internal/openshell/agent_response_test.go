// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

package openshell

import "testing"

func TestAgentProbeRequiresActualSuccessfulPayload(t *testing.T) {
	if text, err := responseText([]byte(`{"status":"ok","result":{"payloads":[{"text":"FOUR"}]}}`)); err != nil || text != "FOUR" {
		t.Fatal(text, err)
	}
	for _, body := range []string{`{}`, `{"status":"error"}`, `{"status":"ok","result":{"payloads":[]}}`, `{"status":"ok","result":{"payloads":[{"text":""}]}}`, `{"status":"ok","result":{"payloads":[{"text":"request failed","isError":true}]}}`} {
		if _, err := responseText([]byte(body)); err == nil {
			t.Fatalf("accepted failed agent response: %s", body)
		}
	}
}
