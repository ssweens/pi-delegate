/**
 * Path's trail watcher: a model that follows the lead's session file and keeps its own running memory of the
 * session. Each batch of new entries reaches it as delivered (one line per entry, with its id) when an assistant
 * turn ends, or when the user writes (within a window); it answers with one record_waypoints call. A refresh is a
 * plain message asking it to revise the trail. It has this one tool and nothing else. See docs/trail.md.
 */
import type * as Durable from "@earendil-works/pi-durable";
import { validateToolArguments } from "@earendil-works/pi-ai/utils/validation";
import { decodeJsonList } from "../mom/contract.ts";
import { errorMessage, isRecord } from "../util/text.ts";
import { recordWaypoints } from "./record.ts";
import { recordWaypointsTool, WATCHER_EXTENSION, watchedSession } from "./prompt.ts";


/** Lists a model sent as JSON strings (mimo does), as lists. */
const decoded = (args: unknown) => {
	if (!isRecord(args)) return {};
	const out: Record<string, unknown> = { ...args };
	for (const field of ["waypoints", "titles", "revise"]) out[field] = decodeJsonList(out[field], { allowNull: false });
	return out;
};

export default function watcher(durable: typeof Durable): Durable.Extension {
	const definition = recordWaypointsTool();
	const record = durable.defineTool({ ...definition, replay: "safe", executionMode: "sequential",
		// The host validates arguments before the tool runs: decode JSON-string lists first, and let a call that still
		// does not fit through, so the tool names every defect instead of the host refusing it silently.
		prepareArguments: (args: unknown) => { try { return validateToolArguments(definition as any, { type: "toolCall", id: "check", name: definition.name, arguments: decoded(args) as any }) as any; } catch { return decoded(args) as any; } },
		async execute(args: unknown, api: Durable.ToolExecutionApi, ctx: any) {
			try {
				const session = watchedSession((await api.agent(ctx)).instructions);
				if (!session) throw new Error("The watcher's instructions name no session.");
				// The call names its records, so a replayed call writes nothing twice.
				const result = await recordWaypoints(decoded(args), { session, job: `${api.conversationId}-${api.callId}`.replace(/[^\w-]/g, "") });
				// Saved: the turn ends here, with no further call. A defect goes back to the model to fix.
				return { content: [{ type: "text" as const, text: result.text }], ...(result.isError ? { isError: true } : { control: { terminate: true as const } }) };
			} catch (error) {
				return { content: [{ type: "text" as const, text: `Path could not save: ${errorMessage(error)}` }], isError: true, control: { terminate: true as const } };
			}
		},
	});
	return durable.defineExtension({ name: WATCHER_EXTENSION, tools: [record] });
}
