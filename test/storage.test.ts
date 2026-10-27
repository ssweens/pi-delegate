import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { ownedElsewhere, ownedElsewhereError, processOwner, readRecord, releaseOwner, RunStore, storageDir, storagePath, writeRecord } from "../src/storage.ts";
import { ownerAlive, pidAlive, processIdentity } from "../src/util/process.ts";
import { tempDir } from "./capture.ts";

function fixture(t: any) {
	return tempDir("delegate-storage-", t);
}

test("records distinguish missing, corrupt, and atomically replaced values", (t) => {
	const dir = fixture(t);
	const path = join(dir, "record.json");
	assert.equal(readRecord(path), undefined);
	writeRecord(path, { segment: 1 });
	writeRecord(path, { segment: 2, stopped: true });
	assert.deepEqual(readRecord(path), { segment: 2, stopped: true });
	assert.equal(statSync(path).mode & 0o777, 0o600);
	assert.deepEqual(readdirSync(dir), ["record.json"]);
	assert.throws(() => writeRecord(path, { bad: 1n }));
	assert.deepEqual(readRecord(path), { segment: 2, stopped: true });
	assert.deepEqual(readdirSync(dir), ["record.json"]);
	writeFileSync(path, "{");
	assert.throws(() => readRecord(path), SyntaxError);
});

test("subsession storage is self-ignored and resolves cwd aliases", (t) => {
	const dir = fixture(t);
	const alias = `${dir}-alias`;
	symlinkSync(dir, alias);
	t.after(() => rmSync(alias));
	const path = storagePath(dir);
	assert.equal(storagePath(alias), path);
	assert.equal(existsSync(path), false, "resolving storage does not create it");
	assert.equal(storageDir(dir), path);
	assert.equal(storageDir(alias), path);
	assert.equal(readFileSync(join(path, ".gitignore"), "utf8"), "*\n");
	writeFileSync(join(path, ".gitignore"), "*\n# retained\n");
	storageDir(dir);
	assert.equal(readFileSync(join(path, ".gitignore"), "utf8"), "*\n# retained\n");
});

test("runs are owned per process: a live owner elsewhere is read-only, a dead owner is adoptable", () => {
	const me = processOwner();
	assert.equal(processOwner(), me, "identity is stable within a process");
	assert.equal(ownedElsewhere({}), false, "unowned records are adoptable");
	assert.equal(ownedElsewhere(me), false, "our own records are ours");
	assert.equal(ownedElsewhere({ ...me, ownerToken: "other", ownerPid: process.ppid }), true, "a live process on this host owns it");
	const exited = spawnSync(process.execPath, ["-e", ""]).pid!;
	assert.equal(ownedElsewhere({ ...me, ownerToken: "other", ownerPid: exited }), false, "a dead owner is adoptable");
	assert.equal(ownedElsewhere({ ...me, ownerToken: "other" }), false, "same pid, other token: an earlier process that reused our pid");
	assert.equal(ownedElsewhere({ ...me, ownerToken: "other", ownerHost: "elsewhere.invalid" }), true, "another host's owner is never taken");
});

test("one process identity: run records and the Coordinator name the same owner, with one liveness rule", () => {
	const me = processIdentity();
	assert.equal(processIdentity(), me, "the identity is stable within a process");
	assert.deepEqual(processOwner(), { ownerPid: me.pid, ownerHost: me.host, ownerToken: me.token }, "a run record's owner is the process identity");
	assert.equal(pidAlive(process.pid), true);
	const exited = spawnSync(process.execPath, ["-e", ""]).pid!;
	assert.equal(pidAlive(exited), false);
	assert.equal(ownerAlive(me), true, "this process");
	assert.equal(ownerAlive({ ...me, token: "other", pid: process.ppid }), true, "a live process on this host");
	assert.equal(ownerAlive({ ...me, token: "other", pid: exited }), false, "a dead process");
	assert.equal(ownerAlive({ ...me, token: "other" }), false, "our pid with another token: an earlier process that reused it");
	assert.equal(ownerAlive({ ...me, token: "other", host: "elsewhere.invalid" }), true, "another host cannot be probed");
	// A record an older version wrote carries a full UUID token: it is never ours, and its owner is probed the same way.
	assert.equal(ownedElsewhere({ ownerPid: process.ppid, ownerHost: me.host, ownerToken: "3f2504e0-4f89-11d3-9a0c-0305e82c3301" }), true);
	assert.equal(ownedElsewhere({ ownerPid: exited, ownerHost: me.host, ownerToken: "3f2504e0-4f89-11d3-9a0c-0305e82c3301" }), false);
	const run = { id: "r", ...processOwner() };
	releaseOwner(run);
	assert.deepEqual(run, { id: "r" }, "a released run names no owner");
	assert.equal(ownedElsewhereError({ id: "r", ownerPid: 7, ownerHost: "h" }).code, "RUN_OWNED_ELSEWHERE");
});

interface TestRun { id: string; ownerKey: string; status: string; note?: string; ownerPid?: number; ownerHost?: string; ownerToken?: string; foreign?: boolean; live?: true; recovered?: number }
type TestRecord = Omit<TestRun, "foreign" | "live" | "recovered">;
const store = (foreignSave: "throw" | "skip", tag?: Record<string, string>) => new RunStore<TestRun, TestRecord>({
	...(tag ? { tag } : {}),
	valid: (record) => typeof record.status === "string",
	revive: (record) => ({ ...record, live: true }),
	recover: (run, savedAt) => { if (run.status === "running") { run.status = "interrupted"; run.recovered = savedAt; } },
	persisted: ({ foreign: _foreign, live: _live, recovered: _recovered, ...record }) => record,
	foreignSave,
});

test("a run store saves whole records and restores them: validated, adopted or foreign, recovered", (t) => {
	const dir = fixture(t);
	const runs = store("throw", { backend: "test" });
	const path = RunStore.recordPath(dir, "role/1");
	assert.equal(path, join(dir, "role%2F1.json"), "the ID is encoded into one file name");
	runs.save({ id: "role/1", ownerKey: "parent", status: "running", ...processOwner(), live: true }, path);
	const saved = readRecord<Record<string, unknown>>(path)!;
	assert.equal(saved.version, 1);
	assert.equal(saved.backend, "test");
	assert.equal(typeof saved.savedAt, "number");
	assert.equal("live" in saved, false, "in-process fields are not saved");

	const ours = runs.load(path, "parent");
	assert.equal(ours.foreign, undefined, "our own run is adopted");
	assert.equal(ours.live, true);
	assert.equal(ours.status, "interrupted", "what was running when it was saved is recovered");
	assert.equal(ours.recovered, saved.savedAt);
	assert.equal("version" in ours || "savedAt" in ours || "backend" in ours, false, "record framing is not part of the run");

	const other = RunStore.recordPath(dir, "role-2");
	writeRecord(other, { id: "role-2", ownerKey: "parent", status: "running", ownerPid: process.ppid, ownerHost: processOwner().ownerHost, ownerToken: "other", version: 1, backend: "test", savedAt: 1 });
	const theirs = runs.load(other, "parent");
	assert.equal(theirs.foreign, true, "a live owner elsewhere keeps it");
	assert.equal(theirs.status, "running", "a foreign run is never recovered here");
	assert.equal(theirs.ownerToken, "other");
	assert.throws(() => runs.save(theirs, other), { code: "RUN_OWNED_ELSEWHERE" });
	store("skip").save(theirs, other);
	assert.equal(readRecord<TestRecord>(other)!.status, "running", "a skipping store leaves a foreign record alone");
	assert.deepEqual(RunStore.recordFiles(dir), [other, path].sort());
	assert.deepEqual(RunStore.recordFiles(join(dir, "missing")), []);

	for (const bad of [{ version: 2 }, { ownerKey: "another parent" }, { id: 7 }, { backend: "acp" }, { status: 1 }]) {
		writeRecord(other, { id: "role-2", ownerKey: "parent", status: "idle", version: 1, backend: "test", savedAt: 1, ...bad });
		assert.throws(() => runs.load(other, "parent"), { message: `Cannot restore delegate metadata: ${other}` }, JSON.stringify(bad));
	}
	assert.throws(() => runs.load(join(dir, "gone.json"), "parent"), /Cannot restore delegate metadata/);
});
