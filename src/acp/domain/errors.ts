import { errorMessage } from "../../util/text.ts";
import type { StringsResponse } from "./types.js";

export class StringsError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "StringsError";
  }
}

export function failure(action: string, error: unknown): StringsResponse {
  if (error instanceof StringsError) {
    return { ok: false, action, error: { code: error.code, message: error.message, retryable: error.retryable } };
  }
  return { ok: false, action, error: { code: "INTERNAL_ERROR", message: errorMessage(error), retryable: false } };
}
