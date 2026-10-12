// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { EventEmitter } from "node:events";

export function credentialWindowHttpFixture(result: number | string) {
  return {
    request: (_options: unknown, callback: (response: unknown) => void) => {
      const outbound = new EventEmitter();
      return Object.assign(outbound, {
        setTimeout: () => {},
        end: () =>
          queueMicrotask(() => {
            if (typeof result === "string") {
              outbound.emit("error", { code: result, message: "private-error-secret" });
            } else {
              const response = Object.assign(new EventEmitter(), {
                statusCode: result,
                resume: () => {},
              });
              callback(response);
              response.emit("end");
            }
          }),
      });
    },
  };
}
