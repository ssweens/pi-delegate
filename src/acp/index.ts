import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";
import { acpCoordinator, shutdownAcpCoordinator } from "./instance.js";

const NAME_PATTERN = "^[a-z][a-z0-9-]{0,47}$";

interface ToolRegistration {
  name: string;
  label: string;
  description: string;
  parameters: TSchema;
  action: string;
}

export default function piStrings(pi: ExtensionAPI): void {
  if (process.env.PI_STRINGS_WORKER === "1" || process.env.PI_STRINGS_OPENED === "1") return;
  // The process's one Coordinator (instance.ts), shared with `delegate backend:"acp"`. A reload
  // only replaces tool bindings, so live workers and their turns survive it.
  pi.on("session_shutdown", async (event) => {
    if (event.reason === "reload") return;
    await shutdownAcpCoordinator();
  });
  const register = ({ name, label, description, parameters, action }: ToolRegistration) => {
    pi.registerTool({
      name,
      label,
      description,
      parameters,
      execute: async (_toolCallId, params) => {
        const response = await (await acpCoordinator()).execute({ action, ...(params as Record<string, unknown>) } as Record<string, unknown> & { action: string });
        return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], details: response };
      },
    });
  };

  register({
    name: "op_spawn",
    label: "Create or open session",
    description: `Create a worker, or open an exact provider-native sessionId without taking ownership. Agent defaults to pi; name matches ${NAME_PATTERN}. Opening preserves native settings and workspace: no profile, role, tools, or model overrides. Amp native T-IDs use provider metadata to resolve executor; pass cwd or executionEnvironment local/orb only as an explicit verification hint when needed. Capability gaps fail explicitly. Stored-session resume is not live-terminal attachment; disconnect behavior is reported by the provider. Creation uses the existing worker policy and optional advertised executionEnvironment.`,
    parameters: Type.Object({
      name: Type.String(),
      profile: Type.Optional(Type.String()),
      agent: Type.Optional(Type.String()),
      role: Type.Optional(Type.Union([Type.Literal("read-only"), Type.Literal("writer")])),
      tools: Type.Optional(Type.Array(Type.String())),
      cwd: Type.Optional(Type.String()),
      sessionId: Type.Optional(Type.String()),
      executionEnvironment: Type.Optional(Type.String()),
      model: Type.Optional(Type.String()),
    }, { additionalProperties: false }),
    action: "spawn",
  });
  register({
    name: "op_status",
    label: "Session status",
    description: "Report session origin, verified native identity/capabilities when opened, and advertised model IDs. Created Amp sessions expose their provider-native identity after the adapter receives it. Native activity may be unknown; local request state is not shared-thread completion.",
    parameters: Type.Object({
      name: Type.String(),
    }, { additionalProperties: false }),
    action: "status",
  });
  register({
    name: "op_send",
    label: "Send turn",
    description: `Start a turn. Created workers receive role/acceptance decoration and allow explicit model selection/reassignment. Opened sessions receive the exact text, retain native settings, and never automatically retry; for Amp this is the ordinary user-attributed contribution path. requestTimeoutMs ends local observation for opened work without cancelling it; the session stays busy until its turn settles. Returns a requestId for op_wait/op_result. Do not send to a session concurrently used by another native client unless its capabilities support it.`,
    parameters: Type.Object({
      name: Type.String(),
      prompt: Type.String(),
      model: Type.Optional(Type.String()),
      requestTimeoutMs: Type.Optional(Type.Number()),
      predecessorRequestId: Type.Optional(Type.String()),
    }, { additionalProperties: false }),
    action: "send",
  });
  register({
    name: "op_wait",
    label: "Wait for turns",
    description: "Wait on a fixed snapshot; select exactly one of requestId, names, or all=true. mode \"any\" resolves on the first terminal request and returns only the terminal requests; mode \"all\" (default) waits for all selected requests. waitTimeoutMs bounds the call (default 300000); a timeout returns timedOut:true and never cancels work.",
    parameters: Type.Object({
      requestId: Type.Optional(Type.String()),
      names: Type.Optional(Type.Array(Type.String())),
      all: Type.Optional(Type.Boolean()),
      mode: Type.Optional(Type.Union([Type.Literal("any"), Type.Literal("all")])),
      waitTimeoutMs: Type.Optional(Type.Number()),
    }, { additionalProperties: false }),
    action: "wait",
  });
  register({
    name: "op_result",
    label: "Get request result",
    description: "Get the authoritative record for a request. Output is capped at the profile's maxOutputBytes with a truncated flag when the bound was hit.",
    parameters: Type.Object({
      requestId: Type.String(),
    }, { additionalProperties: false }),
    action: "result",
  });
  register({
    name: "op_list",
    label: "List workers and requests",
    description: "List live workers and their requests. The optional names projection narrows the result to specific live workers; unknown names are an error.",
    parameters: Type.Object({
      names: Type.Optional(Type.Array(Type.String())),
    }, { additionalProperties: false }),
    action: "list",
  });
  register({
    name: "op_cancel",
    label: "Cancel turn",
    description: "Cooperatively cancel a worker's active turn, passing reason to the worker. If the cancellation grace expires, the runtime is closed and the request is terminalized as cancelled.",
    parameters: Type.Object({
      name: Type.String(),
      reason: Type.Optional(Type.String()),
    }, { additionalProperties: false }),
    action: "cancel",
  });
  register({
    name: "op_close",
    label: "Close worker",
    description: "Created workers: force closes active work; discardPersistentState prevents resume. Opened sessions: disconnect local participation only, without cancel/archive/delete RPCs; discard is forbidden. Check native.disconnectEffect: Pi disconnect terminates this adapter's local executor, so active work may stop and its outcome remains unknown. Failed cleanup retains the binding.",
    parameters: Type.Object({
      name: Type.String(),
      force: Type.Optional(Type.Boolean()),
      discardPersistentState: Type.Optional(Type.Boolean()),
    }, { additionalProperties: false }),
    action: "close",
  });
}
