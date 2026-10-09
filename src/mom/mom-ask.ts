/** Mom's tools for a question (the `mom-ask` extension): commit_graph carries her answer, and answer_question answers without a graph change. */
import type * as Durable from "@earendil-works/pi-durable";
import { momExtension } from "./mom-tools.ts";

export default function momAsk(durable: typeof Durable): Durable.Extension { return momExtension(durable, true); }
