/*
 * Project-scoped Amp plugin for pi-strings work controls.
 *
 * Install this file in the target Amp project as .amp/plugins/pi-strings-bridge.ts.
 * Run it only in an authorized scratch project/Orb first. Expose the configured
 * port with `amp orb portal <port>` and give pi-strings the resulting HTTPS URL.
 * The URL and PI_STRINGS_AMP_BRIDGE_TOKEN are credentials.
 */
import type { PluginAPI, ThreadMessage } from "@ampcode/plugin";

const THREAD_ID = /^T-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACTIONS = new Set(["observe", "append", "steer", "cancel"]);

type Action = "observe" | "append" | "steer" | "cancel";
type RequestBody = { requestId?: unknown; threadId?: unknown; action?: unknown; text?: unknown; limit?: unknown; reason?: unknown };

type ResponseBody = {
  requestId: string;
  threadId: string;
  action: Action;
  delivery: "accepted" | "unknown";
  state?: string;
  messages?: ThreadMessage[];
  remoteStop?: "requested";
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function configuredThreads(): Set<string> {
  return new Set((process.env.PI_STRINGS_AMP_BRIDGE_THREADS ?? "").split(",").map(value => value.trim()).filter(value => THREAD_ID.test(value)));
}

function requireRequest(value: unknown): Required<Pick<RequestBody, "requestId" | "threadId" | "action">> & RequestBody {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("request body must be an object");
  const body = value as RequestBody;
  if (typeof body.requestId !== "string" || !body.requestId.trim()) throw new Error("requestId is required");
  if (typeof body.threadId !== "string" || !THREAD_ID.test(body.threadId)) throw new Error("threadId must be an Amp T-ID");
  if (typeof body.action !== "string" || !ACTIONS.has(body.action)) throw new Error("action is not allowed");
  if ((body.action === "append" || body.action === "steer") && (typeof body.text !== "string" || !body.text.trim())) throw new Error("text is required for append and steer");
  if (body.action === "observe" && body.limit !== undefined && (!Number.isInteger(body.limit) || body.limit < 1)) throw new Error("limit must be a positive integer");
  return body as Required<Pick<RequestBody, "requestId" | "threadId" | "action">> & RequestBody;
}

function publicMessages(messages: ThreadMessage[]): ThreadMessage[] {
  return messages.map(message => ({ role: message.role, id: message.id, content: message.content }));
}

async function handle(amp: PluginAPI, request: Request): Promise<Response> {
  const expectedToken = process.env.PI_STRINGS_AMP_BRIDGE_TOKEN?.trim();
  if (!expectedToken) return json({ error: "bridge token is not configured" }, 503);
  const authorization = request.headers.get("authorization");
  if (authorization !== `Bearer ${expectedToken}`) return json({ error: "unauthorized" }, 401);
  let body: unknown;
  try { body = await request.json(); }
  catch { return json({ error: "request body must be JSON" }, 400); }
  let control: ReturnType<typeof requireRequest>;
  try { control = requireRequest(body); }
  catch (error) { return json({ error: error instanceof Error ? error.message : String(error) }, 400); }
  if (!configuredThreads().has(control.threadId)) return json({ error: "thread is not allowlisted" }, 403);
  const thread = amp.threads.get(control.threadId);
  try {
    if (control.action === "observe") {
      const state = await thread.state.get();
      const messages = await thread.messages({ from: "end", ...(control.limit === undefined ? {} : { limit: control.limit as number }) });
      const response: ResponseBody = { requestId: control.requestId, threadId: control.threadId, action: control.action, delivery: "accepted", state, messages: publicMessages(messages) };
      return json(response);
    }
    if (control.action === "append" || control.action === "steer") {
      await thread.appendUserMessage({ type: "user-message", content: control.text as string }, control.action === "steer" ? { steer: true } : undefined);
      return json({ requestId: control.requestId, threadId: control.threadId, action: control.action, delivery: "accepted" } satisfies ResponseBody);
    }
    await thread.cancel();
    return json({ requestId: control.requestId, threadId: control.threadId, action: control.action, delivery: "accepted", remoteStop: "requested" } satisfies ResponseBody);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : String(error) }, 502);
  }
}

export default function piStringsAmpBridge(amp: PluginAPI): void {
  const token = process.env.PI_STRINGS_AMP_BRIDGE_TOKEN?.trim();
  const port = Number(process.env.PI_STRINGS_AMP_BRIDGE_PORT ?? "8787");
  const hostname = process.env.PI_STRINGS_AMP_BRIDGE_HOST?.trim() || "127.0.0.1";
  if (!token) throw new Error("PI_STRINGS_AMP_BRIDGE_TOKEN is required");
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("PI_STRINGS_AMP_BRIDGE_PORT must be a valid TCP port");
  if (configuredThreads().size === 0) throw new Error("PI_STRINGS_AMP_BRIDGE_THREADS must contain at least one exact Amp T-ID");
  const server = Bun.serve({ hostname, port, fetch: request => request.method === "POST" && new URL(request.url).pathname === "/control" ? handle(amp, request) : json({ error: "not found" }, 404) });
  amp.onDispose(() => server.stop());
}
