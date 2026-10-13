/**
 * Append-only JSONL files shared by several writers (Pi's session, Path's `.mom` sidecar and `.trail`): one IO,
 * one complete-lines reader and one lock policy. Every append takes the file's lock, finishes a torn last line first
 * (so a crashed writer's partial record stays one skippable line) and fsyncs. On read only complete lines count,
 * found in bytes before decoding, since a torn tail may end mid UTF-8 sequence; a line that is not JSON is reported,
 * never fatal. What a valid record is stays with each store.
 */
import { open, readFile, stat } from "node:fs/promises";
import lockfile from "proper-lockfile";
import { errorMessage } from "./text.ts";

/** The lock every append to a shared JSONL file takes. */
export const APPEND_LOCK = { realpath: false, stale: 15_000, retries: { retries: 40, minTimeout: 25, maxTimeout: 250 } } as const;

/** The lock for a short critical section (a claim, a settings read-modify-write): stale after 2 s (proper-lockfile's
 *  minimum), and about 5.6 s of retries outlast a dead holder's lock. */
export const SHORT_LOCK = { realpath: false, stale: 2_000, retries: { retries: 60, minTimeout: 5, maxTimeout: 100 } } as const;

/** A file beside a session transcript: `<session>.mom`, `<session>.trail`. Pi's session lister scans `*.jsonl`, so
 *  the extension must not be `.jsonl`. */
export const siblingFile = (sessionFile: string, extension: string): string => `${sessionFile.replace(/\.jsonl$/, "")}.${extension}`;

export interface JsonlIO {
	/** Stable file identity (device:inode), or undefined when the file does not exist. */
	identity(file: string): Promise<string | undefined>;
	read(file: string): Promise<Buffer>;
	/** Append one record durably, serialized with every other writer of the file. */
	append(file: string, data: string, beforeWrite?: () => Promise<void>): Promise<void>;
}

export const nodeJsonlIO: JsonlIO = {
	identity: (file) => stat(file).then(info => `${info.dev}:${info.ino}`, (error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") return undefined;
		throw error;
	}),
	read: (file) => readFile(file),
	append: async (file, data, beforeWrite) => {
		const release = await lockfile.lock(file, APPEND_LOCK);
		try {
			await beforeWrite?.();
			const handle = await open(file, "a+");
			try {
				const { size } = await handle.stat();
				let prefix = "";
				if (size > 0) { const last = Buffer.alloc(1); await handle.read(last, 0, 1, size - 1); if (last[0] !== 0x0a) prefix = "\n"; }
				await handle.appendFile(prefix + data);
				await handle.sync();
			} finally { await handle.close(); }
		} finally { await release(); }
	},
};

/** The file's bytes, or empty when it does not exist. */
export async function readIfExists(io: JsonlIO, file: string): Promise<Buffer> {
	try { return await io.read(file); }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return Buffer.alloc(0); throw error; }
}

/** The complete lines of `bytes` (a torn tail is left out), decoded, with their 1-based line numbers; blank lines skipped. */
export function completeLines(bytes: Buffer | string): { number: number; line: string }[] {
	const buffer = typeof bytes === "string" ? Buffer.from(bytes, "utf8") : bytes;
	const text = buffer.subarray(0, buffer.lastIndexOf(0x0a) + 1).toString("utf8");
	return text.split("\n").flatMap((line, index) => line ? [{ number: index + 1, line }] : []);
}

/** Each complete line parsed as JSON; one that is not JSON goes to `unreadable` as `line N: <reason>`. */
export function parseJsonLines(bytes: Buffer | string): { values: { number: number; value: unknown }[]; unreadable: string[] } {
	const values: { number: number; value: unknown }[] = [], unreadable: string[] = [];
	for (const { number, line } of completeLines(bytes)) {
		try { values.push({ number, value: JSON.parse(line) }); }
		catch (error) { unreadable.push(`line ${number}: ${errorMessage(error)}`); }
	}
	return { values, unreadable };
}
