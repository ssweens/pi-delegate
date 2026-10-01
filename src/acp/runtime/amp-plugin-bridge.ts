import { StringsError } from "../domain/errors.js";

const AMP_THREAD_ID = /^T-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_TIMEOUT_MS = 30_000;

export type AmpBridgeAction = "observe" | "append" | "steer" | "cancel";
export type AmpBridgeDelivery = "accepted" | "unknown";

export interface AmpBridgeMessage {
  role: "user" | "assistant" | "info";
  id: string | number;
  content: unknown;
}

export interface AmpBridgeResponse {
  requestId: string;
  threadId: string;
  action: AmpBridgeAction;
  delivery: AmpBridgeDelivery;
  state?: "idle" | "running" | "awaiting-approval" | "error";
  messages?: AmpBridgeMessage[];
  remoteStop?: "requested";
  providerMessageId?: string | number;
}

export interface AmpPluginBridgeOptions {
  endpoint: string;
  token: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface AmpBridgeRequest {
  requestId: string;
  threadId: string;
  action: AmpBridgeAction;
  text?: string;
  limit?: number;
  reason?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isAction(value: unknown): value is AmpBridgeAction {
  return value === "observe" || value === "append" || value === "steer" || value === "cancel";
}

function isThreadId(value: unknown): value is string {
  return typeof value === "string" && AMP_THREAD_ID.test(value);
}

function isMessage(value: unknown): value is AmpBridgeMessage {
  if (!isRecord(value) || (value.role !== "user" && value.role !== "assistant" && value.role !== "info")) return false;
  return (typeof value.id === "string" || typeof value.id === "number") && "content" in value;
}

function parseTimeout(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return DEFAULT_TIMEOUT_MS;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new StringsError("AMP_BRIDGE_CONFIG_INVALID", "PI_STRINGS_AMP_BRIDGE_TIMEOUT_MS must be a positive number.");
  return parsed;
}

function validateResponse(value: unknown, expected: AmpBridgeRequest): AmpBridgeResponse {
  if (!isRecord(value) || value.requestId !== expected.requestId || value.threadId !== expected.threadId || !isAction(value.action) || value.action !== expected.action || (value.delivery !== "accepted" && value.delivery !== "unknown")) {
    throw new StringsError("AMP_BRIDGE_RESPONSE_INVALID", "Amp plugin bridge returned an invalid response.");
  }
  if (value.state !== undefined && value.state !== "idle" && value.state !== "running" && value.state !== "awaiting-approval" && value.state !== "error") {
    throw new StringsError("AMP_BRIDGE_RESPONSE_INVALID", "Amp plugin bridge returned an invalid thread state.");
  }
  if (value.messages !== undefined && (!Array.isArray(value.messages) || !value.messages.every(isMessage))) {
    throw new StringsError("AMP_BRIDGE_RESPONSE_INVALID", "Amp plugin bridge returned invalid thread messages.");
  }
  if (value.remoteStop !== undefined && value.remoteStop !== "requested") {
    throw new StringsError("AMP_BRIDGE_RESPONSE_INVALID", "Amp plugin bridge returned an invalid stop result.");
  }
  return {
    requestId: value.requestId,
    threadId: value.threadId,
    action: value.action,
    delivery: value.delivery,
    ...(value.state !== undefined ? { state: value.state } : {}),
    ...(value.messages !== undefined ? { messages: value.messages } : {}),
    ...(value.remoteStop !== undefined ? { remoteStop: value.remoteStop } : {}),
    ...((typeof value.providerMessageId === "string" || typeof value.providerMessageId === "number") ? { providerMessageId: value.providerMessageId } : {}),
  };
}

export class AmpPluginBridge {
  private readonly endpoint: string;
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: AmpPluginBridgeOptions) {
    let endpoint: URL;
    try { endpoint = new URL(options.endpoint); }
    catch { throw new StringsError("AMP_BRIDGE_CONFIG_INVALID", "PI_STRINGS_AMP_BRIDGE_URL must be an absolute URL."); }
    if (endpoint.protocol !== "https:" && endpoint.hostname !== "localhost" && endpoint.hostname !== "127.0.0.1") {
      throw new StringsError("AMP_BRIDGE_CONFIG_INVALID", "Amp plugin bridge URLs must use HTTPS, localhost, or loopback.");
    }
    if (!options.token.trim()) throw new StringsError("AMP_BRIDGE_CONFIG_INVALID", "PI_STRINGS_AMP_BRIDGE_TOKEN is required.");
    this.endpoint = endpoint.toString();
    this.token = options.token;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) throw new StringsError("AMP_BRIDGE_CONFIG_INVALID", "Amp plugin bridge timeout must be positive.");
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async request(input: AmpBridgeRequest): Promise<AmpBridgeResponse> {
    if (!input.requestId.trim() || !isThreadId(input.threadId) || !isAction(input.action)) throw new StringsError("AMP_BRIDGE_REQUEST_INVALID", "Amp plugin bridge request identity is invalid.");
    if ((input.action === "append" || input.action === "steer") && (!input.text || !input.text.trim())) throw new StringsError("AMP_BRIDGE_REQUEST_INVALID", "Amp append and steer require non-empty text.");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      let response: Response;
      try {
        response = await this.fetchImpl(this.endpoint, {
          method: "POST",
          signal: controller.signal,
          headers: { "content-type": "application/json", authorization: `Bearer ${this.token}` },
          body: JSON.stringify(input),
        });
      } catch (error) {
        throw new StringsError("AMP_BRIDGE_DELIVERY_UNKNOWN", `Amp plugin bridge response was not received: ${error instanceof Error ? error.message : String(error)}`, false);
      }
      let body: unknown;
      try { body = await response.json(); }
      catch { throw new StringsError("AMP_BRIDGE_RESPONSE_INVALID", `Amp plugin bridge returned non-JSON HTTP ${response.status}.`); }
      if (!response.ok) {
        const message = isRecord(body) && typeof body.error === "string" ? body.error : `Amp plugin bridge rejected the request with HTTP ${response.status}.`;
        throw new StringsError(response.status === 401 || response.status === 403 ? "AMP_BRIDGE_UNAUTHORIZED" : "AMP_BRIDGE_REJECTED", message);
      }
      return validateResponse(body, input);
    } finally {
      clearTimeout(timer);
    }
  }
}

export function ampPluginBridgeFromEnvironment(env: NodeJS.ProcessEnv = process.env): AmpPluginBridge | undefined {
  const endpoint = env.PI_STRINGS_AMP_BRIDGE_URL?.trim();
  const token = env.PI_STRINGS_AMP_BRIDGE_TOKEN?.trim();
  if (!endpoint && !token) return undefined;
  if (!endpoint || !token) throw new StringsError("AMP_BRIDGE_CONFIG_INVALID", "PI_STRINGS_AMP_BRIDGE_URL and PI_STRINGS_AMP_BRIDGE_TOKEN must be configured together.");
  return new AmpPluginBridge({ endpoint, token, timeoutMs: parseTimeout(env.PI_STRINGS_AMP_BRIDGE_TIMEOUT_MS) });
}
