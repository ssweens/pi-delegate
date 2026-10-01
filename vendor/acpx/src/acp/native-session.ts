import { z } from "zod";

// Versioned adapter capability. ACP load/resume alone does not establish native-ID semantics.
export const NATIVE_SESSION_CAPABILITY = "pi-strings/native-session";
export const NATIVE_SESSION_DESCRIBE = "pi-strings/session/describe";

export const NativeSessionBindingSchema = z.object({
  id: z.string().min(1),
  scope: z.string().min(1),
  cwd: z.string().min(1),
  // Provider-specific opening hint. Persisted ACPX keys stay snake_case.
  execution_environment: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
}).strict();
export type NativeSessionBinding = z.infer<typeof NativeSessionBindingSchema>;

export const NativeSessionDescriptionSchema = z.object({
  id: z.string().min(1),
  scope: z.string().min(1),
  cwd: z.string().min(1),
  executionEnvironment: z.string().min(1),
  model: z.string().min(1).optional(),
  attachment: z.enum(["stored-session", "shared-session"]),
  disconnectEffect: z.enum(["stops-local-executor", "remote-work-continues", "unknown"]),
  concurrentNativeClients: z.enum(["unsupported", "supported", "unknown"]),
  activity: z.enum(["idle", "running", "unknown"]),
}).strict();
export type NativeSessionDescription = z.infer<typeof NativeSessionDescriptionSchema>;

export function requireNativeSessionBinding(raw: unknown, expected: NativeSessionBinding): void {
  const actual = NativeSessionBindingSchema.parse(raw);
  if (actual.id !== expected.id || actual.scope !== expected.scope || actual.cwd !== expected.cwd ||
      (expected.execution_environment !== undefined && actual.execution_environment !== expected.execution_environment) ||
      (expected.model !== undefined && actual.model !== expected.model)) {
    throw new Error("Native session identity, workspace, or executor changed during opening.");
  }
}
