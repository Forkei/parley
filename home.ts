// Local home for liaison: per-account keystores + the directory→account registry.
// Layout (mirrors how Claude Code is per-directory — see MANUAL):
//   ~/.liaison/
//     accounts/<account>/identity.json   ← persisted keypair + display name (stable identity)
//     accounts/<account>/log.jsonl       ← the CRDT op-log (added in the talk step)
//     dirs.json                          ← { "<abs dir>": "<account>" } binding
//     settings.json                      ← global defaults (per-account overrides live by the account)
//
// Keys are stored like ~/.ssh (plaintext for now; optional passphrase later — see MANUAL).

import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { Peer, type PersistedKeys, type Op } from "./p2p";
import type { Cert } from "./principal"; // type-only → no runtime circular import

export const HOME = process.env.LIAISON_HOME?.trim() || join(homedir(), ".liaison");
const ACCOUNTS_DIR = () => join(HOME, "accounts");
const accountDir = (a: string) => join(ACCOUNTS_DIR(), a);
const identityPath = (a: string) => join(accountDir(a), "identity.json");
const DIRS_PATH = () => join(HOME, "dirs.json");

export interface Identity extends PersistedKeys {
  account: string;
  id: string; // fingerprint
  name: string; // public display name
  created: string;
  cert?: Cert; // principal's delegation cert (provenance), if a principal exists
}

const ensureDir = (p: string) => { if (!existsSync(p)) mkdirSync(p, { recursive: true }); };
const readJSON = <T>(p: string, fallback: T): T => {
  try { return JSON.parse(readFileSync(p, "utf8")) as T; } catch { return fallback; }
};

// ─── Accounts ─────────────────────────────────────────────────────────────────

export function listAccounts(): Identity[] {
  const dir = ACCOUNTS_DIR();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((a) => existsSync(identityPath(a)))
    .map((a) => readJSON<Identity>(identityPath(a), null as unknown as Identity))
    .filter(Boolean);
}

export function accountExists(account: string): boolean {
  return existsSync(identityPath(account));
}

export function loadIdentity(account: string): Identity | null {
  return accountExists(account) ? readJSON<Identity>(identityPath(account), null as unknown as Identity) : null;
}

/** Create a new account with a fresh, persisted keypair. Throws if it already exists. */
export function createAccount(account: string, name: string, nowTs: string): Identity {
  if (accountExists(account)) throw new Error(`account "${account}" already exists`);
  ensureDir(accountDir(account));
  const peer = new Peer(name); // fresh keys
  const identity: Identity = { account, id: peer.id, name, created: nowTs, ...peer.exportKeys() };
  writeFileSync(identityPath(account), JSON.stringify(identity, null, 2), "utf8");
  return identity;
}

/** Reconstruct a live Peer (with private keys) from a stored account. */
export function peerFor(account: string): Peer {
  const id = loadIdentity(account);
  if (!id) throw new Error(`no such account "${account}" — run: ac --account ${account} init`);
  return new Peer(id.name, id);
}

/** Attach a principal-issued delegation cert to a stored agent identity. */
export function setIdentityCert(account: string, cert: Cert): void {
  const id = loadIdentity(account);
  if (!id) throw new Error(`no account "${account}"`);
  id.cert = cert;
  writeFileSync(identityPath(account), JSON.stringify(id, null, 2), "utf8");
}

// Local petnames: MY private label for a peer fingerprint (no global namespace to squat).
const petnamesFile = (a: string) => join(accountDir(a), "petnames.json");
export function getPetnames(account: string): Record<string, string> { return readJSON<Record<string, string>>(petnamesFile(account), {}); }
export function setPetname(account: string, peerId: string, petname: string): void {
  const m = getPetnames(account); m[peerId] = petname;
  writeFileSync(petnamesFile(account), JSON.stringify(m, null, 2), "utf8");
}

// TOFU pins: the first-seen fingerprint for a principal NAME. Catches a name being reused by
// a DIFFERENT key (impersonation) — trust-on-first-use, like SSH known_hosts.
const pinsFile = (a: string) => join(accountDir(a), "pins.json");
export function getPins(account: string): Record<string, string> { return readJSON<Record<string, string>>(pinsFile(account), {}); }
export function setPin(account: string, principalName: string, principalId: string): void {
  const m = getPins(account); m[principalName] = principalId;
  writeFileSync(pinsFile(account), JSON.stringify(m, null, 2), "utf8");
}

// Machine-shared contacts: a MACHINE-level address book any account can contribute to, so a
// sibling agent can reach someone a peer already vetted — without redoing the introduction.
// Stores the encryption key so siblings can seal a DM even before syncing an op from them.
export interface SharedContact { id: string; name: string; encPub: string; principal: string | null; principal_id: string | null; verified: boolean; sharedBy: string; }
const sharedFile = () => join(HOME, "contacts.json");
export function getSharedContacts(): Record<string, SharedContact> { return readJSON<Record<string, SharedContact>>(sharedFile(), {}); }
export function addSharedContact(c: SharedContact): void {
  ensureDir(HOME);
  const m = getSharedContacts(); m[c.id] = c;
  writeFileSync(sharedFile(), JSON.stringify(m, null, 2), "utf8");
}

// ─── Directory → account registry ───────────────────────────────────────────────

type DirMap = Record<string, string>;

export function bindDir(dir: string, account: string): void {
  ensureDir(HOME);
  const map = readJSON<DirMap>(DIRS_PATH(), {});
  map[resolve(dir)] = account;
  writeFileSync(DIRS_PATH(), JSON.stringify(map, null, 2), "utf8");
}

/** Resolve the account for a directory by walking UP to the nearest bound ancestor
 *  (like git discovering .git). Returns null if nothing is bound. */
export function resolveAccount(cwd: string): string | null {
  const map = readJSON<DirMap>(DIRS_PATH(), {});
  let dir = resolve(cwd);
  while (true) {
    if (map[dir] && accountExists(map[dir])) return map[dir];
    const parent = resolve(dir, "..");
    if (parent === dir) return null;
    dir = parent;
  }
}

// ─── Op-log persistence (the daemon is the single writer) ───────────────────────

const logPath = (a: string) => join(accountDir(a), "log.jsonl");
const cursorFile = (a: string) => join(accountDir(a), "cursor.json");
const groupsFile = (a: string) => join(accountDir(a), "groups.json");

export function loadOps(account: string): Op[] {
  const p = logPath(account);
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Op);
}
/** Full snapshot write — single-writer (the daemon), simple + safe at spike scale. */
export function saveOps(account: string, ops: Op[]): void {
  ensureDir(accountDir(account));
  writeFileSync(logPath(account), ops.map((o) => JSON.stringify(o)).join("\n") + (ops.length ? "\n" : ""), "utf8");
}

export function getCursor(account: string): number {
  return readJSON<{ lamport: number }>(cursorFile(account), { lamport: 0 }).lamport;
}
export function setCursor(account: string, lamport: number): void {
  writeFileSync(cursorFile(account), JSON.stringify({ lamport }), "utf8");
}

// ─── Groups (a group = a name + shared key; the key's hash is the rendezvous topic) ──

export interface Group { name: string; key: string; }
export function listGroups(account: string): Group[] { return readJSON<Group[]>(groupsFile(account), []); }
export function addGroup(account: string, g: Group): void {
  const gs = listGroups(account).filter((x) => x.name !== g.name);
  gs.push(g);
  writeFileSync(groupsFile(account), JSON.stringify(gs, null, 2), "utf8");
}
export function topicHash(key: string): string {
  return createHash("sha256").update(`liaison:${key}`).digest("hex");
}

// ─── Runtime: IPC sockets, pidfiles, and the local peer registry ─────────────────

const RUN = () => { const d = join(HOME, "run"); ensureDir(d); return d; };
const PEERS = () => { const d = join(RUN(), "peers"); ensureDir(d); return d; };

export function socketPath(account: string): string {
  return process.platform === "win32" ? `\\\\.\\pipe\\liaison-${account}` : join(RUN(), `${account}.sock`);
}
export const pidPath = (account: string) => join(RUN(), `${account}.pid`);
export const daemonLogPath = (account: string) => join(RUN(), `${account}.daemon.log`);

export interface PeerEntry { account: string; id: string; name: string; host: string; port: number; topics: string[]; pid: number; ts: string; }
const peerEntryPath = (account: string) => join(PEERS(), `${account}.json`);
export function writePeerEntry(e: PeerEntry): void { writeFileSync(peerEntryPath(e.account), JSON.stringify(e), "utf8"); }
export function removePeerEntry(account: string): void { try { rmSync(peerEntryPath(account)); } catch { /* gone */ } }
/** All live peer entries except our own account (same-machine discovery registry). */
export function listPeerEntries(selfAccount: string): PeerEntry[] {
  const dir = PEERS();
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".json"))
    .map((f) => readJSON<PeerEntry>(join(dir, f), null as unknown as PeerEntry))
    .filter((e) => e && e.account !== selfAccount);
}
