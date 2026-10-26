import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync, openSync, fsyncSync, closeSync, unlinkSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import lockfile from "proper-lockfile";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import { Scheduler, SnapshotSchema, type Snapshot } from "./scheduler.ts";

const CapsuleSchema = Type.Object({
  version: Type.Literal(1),
  sessionId: Type.String({ minLength: 1 }),
  nativeFile: Type.String({ minLength: 1 }),
  cwd: Type.String({ minLength: 1 }),
  updatedAt: Type.Number(),
  state: Type.Union([Type.Literal("prechat"), Type.Literal("native"), Type.Literal("transferring"), Type.Literal("transferred")]),
  snapshot: Type.Optional(SnapshotSchema),
  receipts: Type.Array(Type.String()),
  transferTarget: Type.Optional(Type.String()),
});
type Capsule = Static<typeof CapsuleSchema>;
const options = { realpath: false, stale: 10000, update: 3000, retries: 0 };
export interface Conversation { sessionId: string; nativeFile?: string; cwd: string; sessionDir: string }
export interface Orphan { id: string; label: string }

function read(path: string): Capsule {
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!Check(CapsuleSchema, value) || !isAbsolute(value.nativeFile) || !isAbsolute(value.cwd) || (value.transferTarget && dirname(value.transferTarget) !== dirname(path))) throw new Error(`Invalid Spur conversation capsule: ${path}`);
  if (value.state === "prechat" || value.state === "transferring") {
    if (!value.snapshot) throw new Error("Pre-chat capsule has no snapshot");
    new Scheduler().restore(value.snapshot);
  }
  return value;
}
function atomic(path: string, payload: Capsule) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(payload), { mode: 0o600, flag: "wx" });
    const file = openSync(temporary, "r");
    try { fsyncSync(file); } finally { closeSync(file); }
    renameSync(temporary, path);
    const directory = openSync(resolve(path, ".."), "r");
    try { fsyncSync(directory); } finally { closeSync(directory); }
  } finally { if (existsSync(temporary)) unlinkSync(temporary); }
}

export class ConversationStorage {
  readonly path?: string;
  private release?: () => void;
  private payload?: Capsule;
  private compromised?: Error;
  private directory: string;
  warning?: string;
  readonly conversation: Conversation;
  constructor(conversation: Conversation) {
    this.conversation = conversation;
    this.directory = join(conversation.sessionDir, "pi-spur");
    if (!conversation.nativeFile) return;
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    this.path = join(this.directory, `${Buffer.from(conversation.sessionId).toString("hex")}.json`);
    this.release = lockfile.lockSync(this.path, { ...options, onCompromised: (error) => { this.compromised = error; } });
    try {
      if (existsSync(this.path)) {
        this.payload = read(this.path);
        if (this.payload.sessionId !== conversation.sessionId || resolve(this.payload.nativeFile) !== resolve(conversation.nativeFile) || resolve(this.payload.cwd) !== resolve(conversation.cwd)) throw new Error("Spur capsule identity does not match this conversation");
      }
    } catch (error) { this.close(); throw error; }
  }
  private assertOwner() {
    if (this.compromised) throw this.compromised;
    if (this.path && !this.release) throw new Error("Spur conversation lease is closed");
  }
  private base(): Capsule {
    return this.payload ?? { version: 1, sessionId: this.conversation.sessionId, nativeFile: this.conversation.nativeFile!, cwd: this.conversation.cwd, updatedAt: Date.now(), state: "prechat", receipts: [] };
  }
  loadPrechat(): Snapshot | undefined {
    this.assertOwner();
    if (!this.payload || this.payload.state !== "prechat" || existsSync(this.payload.nativeFile)) return;
    return structuredClone(this.payload.snapshot);
  }
  save(snapshot: Snapshot, native: boolean): void {
    this.assertOwner();
    if (!this.path) return;
    native ||= this.payload?.state === "native";
    if (native && this.payload?.state === "native") return;
    const payload: Capsule = { ...this.base(), state: native ? "native" : "prechat", updatedAt: Date.now() };
    delete payload.transferTarget;
    if (native) delete payload.snapshot;
    else payload.snapshot = structuredClone(snapshot);
    atomic(this.path, payload);
    this.payload = payload;
  }
  markNative(): void {
    if (!this.path || !this.payload || this.payload.state === "native") return;
    this.save({ version: 1, paused: false, jobs: [] }, true);
  }
  orphans(): Orphan[] {
    this.assertOwner();
    if (!this.path) return [];
    const found: Orphan[] = [];
    for (const filename of readdirSync(this.directory)) {
      if (!filename.endsWith(".json")) continue;
      const path = join(this.directory, filename);
      if (path === this.path || lockfile.checkSync(path, options)) continue;
      const payload = read(path);
      if (payload.state !== "prechat" && payload.state !== "transferring") continue;
      if (!payload.snapshot?.jobs.length) continue;
      if (existsSync(payload.nativeFile) || resolve(payload.cwd) !== resolve(this.conversation.cwd)) continue;
      if (payload.state === "transferring" && payload.transferTarget) {
        if (payload.transferTarget !== this.path && lockfile.checkSync(payload.transferTarget, options)) continue;
        if (existsSync(payload.transferTarget) && read(payload.transferTarget).receipts.includes(payload.sessionId)) continue;
      }
      found.push({ id: filename, label: `${payload.snapshot!.jobs[0].name ?? payload.snapshot!.jobs[0].id} · ${payload.snapshot!.jobs.length} jobs · ${new Date(payload.updatedAt).toLocaleString()} · conversation ${payload.sessionId.slice(0, 8)}` });
    }
    return found;
  }
  recover(id: string, current: Snapshot): Snapshot {
    this.assertOwner();
    if (!this.path) throw new Error("Recovery needs a persistent conversation, not --no-session");
    if (existsSync(this.conversation.nativeFile!) || current.jobs.length) throw new Error("Recover into a new, empty pre-chat conversation. Existing conversation state is never replaced.");
    if (!this.orphans().some((item) => item.id === id)) throw new Error("This source is live, already transferred, or no longer recoverable");
    const sourcePath = join(this.directory, id);
    const release = lockfile.lockSync(sourcePath, options);
    try {
      const source = read(sourcePath);
      if (source.state !== "prechat" && source.state !== "transferring") throw new Error("Source already transferred");
      if (source.transferTarget && source.transferTarget !== this.path) {
        if (lockfile.checkSync(source.transferTarget, options)) throw new Error("Previous recovery target is live");
        if (existsSync(source.transferTarget) && read(source.transferTarget).receipts.includes(source.sessionId)) throw new Error("Source was already imported by its previous target");
      }
      const restored = new Scheduler();
      restored.restore(source.snapshot);
      source.state = "transferring";
      source.transferTarget = this.path;
      source.updatedAt = Date.now();
      atomic(sourcePath, source);
      const target: Capsule = { ...this.base(), state: "prechat", snapshot: restored.state, updatedAt: Date.now(), receipts: [...new Set([...this.base().receipts, source.sessionId])] };
      atomic(this.path, target);
      this.payload = target;
      // The receipt and imported state commit together. A crash here cannot reimport the source.
      source.state = "transferred";
      try { atomic(sourcePath, source); }
      catch (error) { this.warning = `Jobs are saved here, but source finalization failed: ${String(error)}. Its committed receipt prevents another import.`; }
      return structuredClone(restored.state);
    } finally { release(); }
  }
  close() { const release = this.release; this.release = undefined; release?.(); }
}
