#!/usr/bin/env tsx
// agent-comms daemon — one per account. Owns the Peer (keys + op-log), runs the local
// transport (localhost TCP + the peer registry; same-machine discovery, no DHT yet —
// Hyperswarm is the cross-machine transport, next), and serves an IPC socket the `parley` CLI
// drives. SINGLE WRITER of the op-log → no clock divergence, no append races.
//
//   node --import tsx daemon.ts --account <a>
//
// Transport: each daemon listens on a 127.0.0.1 port and registers {id, port, topics} in
// the peer registry. Every tick it connects to other daemons sharing a topic and gossips
// the signed op-log; CRDT union-by-id makes the flood converge. DMs ride the same gossip as
// ciphertext — only the recipient decrypts. (Identical protocol to swarm-node, local wires.)

import { createServer, connect, type Socket } from "node:net";
import { type Duplex } from "node:stream";
import { createHash } from "node:crypto";
import Hyperswarm from "hyperswarm";
import { writeFileSync, existsSync, unlinkSync } from "node:fs";
import {
  peerFor, loadIdentity, loadOps, saveOps, listGroups, addGroup, getCursor, setCursor,
  topicHash, socketPath, pidPath, writePeerEntry, removePeerEntry, listPeerEntries,
  getSharedContacts, addSharedContact, type PeerEntry,
} from "./home";
import type { Op, DerivedMessage } from "./p2p";
import { verifyCert, type Cert } from "./principal";

const account = (() => { const i = process.argv.indexOf("--account"); return i >= 0 ? process.argv[i + 1] : "default"; })();
const id = loadIdentity(account);
if (!id) { console.error(`[daemon] no such account "${account}"`); process.exit(1); }

const peer = peerFor(account);
const now = () => new Date().toISOString();
const log = (...a: unknown[]) => console.log(`[${account}]`, ...a);

// Load persisted log (merge tolerates the receipts auto-emitted for our DMs).
peer.merge(loadOps(account), now());
// Announce presence so peers learn our encryption key (→ DM-able) AND our principal cert
// (→ provenance) even before we post content. Re-announce if we gained a cert since.
{
  const profiles = peer.export().filter((o) => o.author === peer.id && (o.payload as Record<string, unknown>).kind === "profile");
  const hasCertProfile = profiles.some((o) => (o.payload as Record<string, unknown>).cert);
  if (profiles.length === 0 || (id.cert && !hasCertProfile)) {
    peer.announce(now(), id.cert ? { cert: id.cert } : undefined);
  }
}
persist();

function persist() { saveOps(account, peer.export()); }
function myTopics(): string[] { return listGroups(account).map((g) => topicHash(g.key)); }
function myGroupNames(): Set<string> { return new Set(listGroups(account).map((g) => g.name)); }

// ─── Transport: localhost TCP + gossip ──────────────────────────────────────────

const sockets = new Set<Duplex>(); // gossip streams — local TCP AND swarm, treated identically
const dialed = new Set<number>(); // ports we've initiated to (avoid duplicate dials)
const waiters: Array<{ conn: Socket; afterLamport: number }> = []; // one-shot (parley wait)
const listeners: Array<{ conn: Socket; afterLamport: number }> = []; // streaming (parley listen)

function sendOps(sock: Duplex, ops: Op[]) {
  try { sock.write(JSON.stringify({ type: "ops", ops }) + "\n"); } catch { /* gone */ }
}
function broadcast() { for (const s of sockets) sendOps(s, peer.export()); }

function wireGossip(sock: Duplex) {
  sockets.add(sock);
  sendOps(sock, peer.export()); // initial full exchange
  let buf = "";
  sock.on("data", (chunk: Buffer) => {
    buf += chunk.toString("utf8");
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line) as { type: string; ops: Op[] };
        if (msg.type !== "ops") continue;
        const r = peer.merge(msg.ops, now());
        if (r.accepted > 0 || r.deliveredReceipts > 0) {
          persist();
          if (r.accepted > 0) log(`merged ${r.accepted} op(s)${r.rejected ? `, rejected ${r.rejected}` : ""}`);
          notifyWaiters();
          pushToListeners();
          broadcast(); // peers with everything accept 0 → flood settles
        }
      } catch { /* malformed */ }
    }
  });
  const drop = () => { sockets.delete(sock); };
  sock.on("close", drop); sock.on("error", drop);
}

const server = createServer((sock) => wireGossip(sock));

// Cross-machine transport (opt-in: --swarm or PARLEY_SWARM=1). Hyperswarm finds peers on
// the public DHT by topic = hash(group key) and hole-punches direct connections. The gossip
// handler is transport-agnostic, so swarm conns feed the SAME wireGossip. Local TCP stays on
// for same-machine. CRDT union-by-id makes any overlap between transports harmless.
const swarmEnabled = process.argv.includes("--swarm") || process.env.PARLEY_SWARM === "1";
let swarm: Hyperswarm | null = null;
const swarmTopics = new Set<string>();
const topicBuf = (key: string) => createHash("sha256").update(`agent-comms:${key}`).digest();
function swarmJoinGroups() {
  if (!swarm) return;
  for (const g of listGroups(account)) {
    const hx = topicHash(g.key);
    if (swarmTopics.has(hx)) continue;
    swarmTopics.add(hx);
    try { swarm.join(topicBuf(g.key), { server: true, client: true }); log(`swarm join #${g.name}`); } catch { /* */ }
  }
}

function register(port: number) {
  const e: PeerEntry = { account, id: peer.id, name: id!.name, host: "127.0.0.1", port, topics: myTopics(), pid: process.pid, ts: now() };
  writePeerEntry(e);
}

function discoverTick(port: number) {
  register(port); // refresh our entry (topics may have changed via `join`)
  const mine = new Set(myTopics());
  for (const e of listPeerEntries(account)) {
    if (dialed.has(e.port)) continue;
    if (e.port <= port) continue; // lower port dials higher → avoid double connections
    if (!e.topics.some((t) => mine.has(t))) continue; // only peers sharing a topic
    dialed.add(e.port);
    const sock = connect(e.port, e.host, () => log(`connected → ${e.name} (:${e.port})`));
    wireGossip(sock);
    sock.on("close", () => dialed.delete(e.port));
    sock.on("error", () => dialed.delete(e.port));
  }
}

// ─── Inbox / wait helpers ───────────────────────────────────────────────────────

function relevant(m: DerivedMessage): boolean {
  if (m.from === peer.id) return false; // not my own
  if (m.dm) return m.dm.to === peer.id; // DMs addressed to me
  return myGroupNames().has(m.channel); // group posts in groups I'm in
}
function notifyWaiters() {
  if (!waiters.length) return;
  const feed = peer.feed();
  for (let i = waiters.length - 1; i >= 0; i--) {
    const w = waiters[i];
    const hit = feed.find((m) => m.lamport > w.afterLamport && relevant(m));
    if (hit) {
      try { w.conn.write(JSON.stringify({ ok: true, message: hit }) + "\n"); w.conn.end(); } catch { /* gone */ }
      waiters.splice(i, 1);
    }
  }
}
// Streaming subscribers (parley listen): push EVERY new relevant message, keep the conn open.
function pushToListeners() {
  if (!listeners.length) return;
  const feed = peer.feed();
  for (const l of listeners) {
    const fresh = feed.filter((m) => m.lamport > l.afterLamport && relevant(m));
    if (!fresh.length) continue;
    l.afterLamport = fresh[fresh.length - 1].lamport;
    for (const m of fresh) { try { l.conn.write(JSON.stringify({ message: m }) + "\n"); } catch { /* gone */ } }
  }
}
const maxLamport = () => peer.feed().reduce((m, x) => Math.max(m, x.lamport), 0);

// ─── IPC server (the `parley` CLI talks to this) ────────────────────────────────────

type Req = { cmd: string; [k: string]: unknown };
function handle(req: Req, reply: (r: unknown) => void, conn: Socket) {
  switch (req.cmd) {
    case "status":
      return reply({ ok: true, account, id: peer.id, name: id!.name, groups: listGroups(account).map((g) => g.name), peers: sockets.size, ops: peer.opCount() });
    case "join": {
      const { name, key } = req as unknown as { name: string; key: string };
      if (!name || !key) return reply({ error: "join needs name + key" });
      addGroup(account, { name, key });
      swarmJoinGroups(); // join the DHT topic too (if swarm transport is on)
      return reply({ ok: true, group: name }); // next discover tick announces the new topic
    }
    case "groups":
      return reply({ ok: true, groups: listGroups(account) });
    case "contacts": {
      // Derive contacts from peers' profile ops; verify each principal cert and bind it to
      // the actual sender key (cert.agent_pub === op.pubkey) → real provenance.
      const seen = new Map<string, { id: string; name: string; principal: string | null; principal_id: string | null; verified: boolean }>();
      for (const op of peer.export()) {
        const p = op.payload as Record<string, unknown>;
        if (op.type !== "post" || p.kind !== "profile" || op.author === peer.id) continue;
        const cert = p.cert as Cert | undefined;
        const ok = !!cert && verifyCert(cert) && cert.agent_pub === op.pubkey;
        seen.set(op.author, {
          id: op.author,
          name: (p.title as string) || cert?.agent_name || "?",
          principal: ok ? cert!.principal_name : null,
          principal_id: ok ? cert!.principal_id : null,
          verified: ok,
        });
      }
      return reply({ ok: true, contacts: [...seen.values()] });
    }
    case "certof": {
      // The full provenance behind a contact's badge, for `parley verify`. Accepts a short id.
      const { id: pid } = req as unknown as { id: string };
      let found: { id: string; name: string; pubkey: string; cert: Cert | null } | null = null;
      for (const op of peer.export()) {
        const p = op.payload as Record<string, unknown>;
        if (op.type === "post" && p.kind === "profile" && (op.author === pid || op.author.startsWith(pid))) {
          found = { id: op.author, name: (p.title as string) || "?", pubkey: op.pubkey, cert: (p.cert as Cert) ?? null };
        }
      }
      return reply(found ? { ok: true, ...found } : { error: `no profile seen for "${pid}"` });
    }
    case "post": {
      const { group, text } = req as unknown as { group: string; text: string };
      if (!group || !text) return reply({ error: "post needs group + text" });
      if (!myGroupNames().has(group)) return reply({ error: `not in group "${group}" — run: parley join ${group} --key <k>` });
      const op = peer.post({ channel: group, title: text, body: "" }, now());
      persist(); broadcast();
      return reply({ ok: true, id: op.id });
    }
    case "dm": {
      const { to, text } = req as unknown as { to: string; text: string };
      if (!to || !text) return reply({ error: "dm needs to + text" });
      try {
        // Fall back to the machine-shared contact pool for the recipient's key if we haven't
        // synced an op from them yet (so a shared contact is DM-able without re-introduction).
        let encPub = peer.encKeyOf(to) ?? undefined;
        if (!encPub) encPub = getSharedContacts()[to]?.encPub;
        const op = peer.sendDM(to, { channel: "dm", title: text, body: "" }, now(), encPub);
        persist(); broadcast();
        return reply({ ok: true, id: op.id });
      } catch (e) { return reply({ error: e instanceof Error ? e.message : String(e) }); }
    }
    case "share": {
      const { id: pid } = req as unknown as { id: string };
      let prof: { op: Op; p: Record<string, unknown> } | null = null;
      for (const op of peer.export()) {
        const p = op.payload as Record<string, unknown>;
        if (op.type === "post" && p.kind === "profile" && (op.author === pid || op.author.startsWith(pid))) prof = { op, p };
      }
      if (!prof) return reply({ error: `no profile seen for "${pid}"` });
      const cert = prof.p.cert as Cert | undefined;
      const ok = !!cert && verifyCert(cert) && cert.agent_pub === prof.op.pubkey;
      addSharedContact({ id: prof.op.author, name: (prof.p.title as string) || "?", encPub: prof.op.encPub, principal: ok ? cert!.principal_name : null, principal_id: ok ? cert!.principal_id : null, verified: ok, sharedBy: account });
      return reply({ ok: true, id: prof.op.author });
    }
    case "invite": {
      // Targeted, leak-safe: the group key is sealed to the recipient's key — a leaked token
      // is useless to anyone else (only they can decrypt it).
      const { to, group } = req as unknown as { to: string; group: string };
      if (!to || !group) return reply({ error: "invite needs to + group" });
      const g = listGroups(account).find((x) => x.name === group);
      if (!g) return reply({ error: `not in group "${group}"` });
      let encPub = peer.encKeyOf(to) ?? undefined;
      if (!encPub) encPub = getSharedContacts()[to]?.encPub;
      if (!encPub) return reply({ error: `no key known for "${to}" — share a group or add their card first` });
      const box = peer.sealForKey(encPub, JSON.stringify({ name: g.name, key: g.key }));
      const token = "acinv1." + Buffer.from(JSON.stringify({ to, ...box })).toString("base64url");
      return reply({ ok: true, token });
    }
    case "join-invite": {
      const { token } = req as unknown as { token: string };
      if (!token || !token.startsWith("acinv1.")) return reply({ error: "not an invite token" });
      let parsed: { ephPub: string; nonce: string; ct: string };
      try { parsed = JSON.parse(Buffer.from(token.slice(7), "base64url").toString("utf8")); } catch { return reply({ error: "malformed invite" }); }
      const clear = peer.openSealedBox({ ephPub: parsed.ephPub, nonce: parsed.nonce, ct: parsed.ct });
      if (!clear) return reply({ error: "this invite isn't addressed to you (can't decrypt)" });
      const grp = JSON.parse(clear) as { name: string; key: string };
      addGroup(account, { name: grp.name, key: grp.key });
      swarmJoinGroups();
      return reply({ ok: true, group: grp.name });
    }
    case "feed": {
      const { group, since } = req as unknown as { group?: string; since?: number };
      let msgs = peer.feed();
      if (group) msgs = msgs.filter((m) => m.channel === group);
      if (typeof since === "number") msgs = msgs.filter((m) => m.lamport > since);
      return reply({ ok: true, messages: msgs });
    }
    case "inbox": {
      const cursor = getCursor(account);
      const fresh = peer.feed().filter((m) => m.lamport > cursor && relevant(m));
      setCursor(account, maxLamport());
      return reply({ ok: true, messages: fresh });
    }
    case "msgstatus": {
      const { id: mid } = req as unknown as { id: string };
      const m = peer.feed().find((x) => x.id === mid || x.id.startsWith(mid));
      return reply(m ? { ok: true, message: m } : { error: "no such message" });
    }
    case "wait":
      waiters.push({ conn, afterLamport: maxLamport() });
      notifyWaiters(); // in case something already qualifies
      return; // held open until a message arrives
    case "listen":
      listeners.push({ conn, afterLamport: maxLamport() });
      return; // held open; streams every new relevant message
    case "stop":
      reply({ ok: true, stopping: true });
      return shutdown(0);
    default:
      return reply({ error: `unknown cmd "${req.cmd}"` });
  }
}

const ipc = createServer((conn) => {
  let buf = "";
  conn.on("data", (chunk: Buffer) => {
    buf += chunk.toString("utf8");
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      try {
        const req = JSON.parse(line) as Req;
        handle(req, (r) => { try { conn.write(JSON.stringify(r) + "\n"); } catch { /* gone */ } }, conn);
      } catch { try { conn.write(JSON.stringify({ error: "bad request" }) + "\n"); } catch { /* */ } }
    }
  });
  conn.on("close", () => {
    const wi = waiters.findIndex((w) => w.conn === conn); if (wi >= 0) waiters.splice(wi, 1);
    const li = listeners.findIndex((l) => l.conn === conn); if (li >= 0) listeners.splice(li, 1);
  });
  conn.on("error", () => { /* ignore */ });
});

// ─── Lifecycle ──────────────────────────────────────────────────────────────────

let tick: ReturnType<typeof setInterval>;
function shutdown(code: number) {
  try { removePeerEntry(account); } catch { /* */ }
  try { unlinkSync(pidPath(account)); } catch { /* */ }
  try { if (process.platform !== "win32") unlinkSync(socketPath(account)); } catch { /* */ }
  clearInterval(tick);
  try { server.close(); } catch { /* */ }
  try { ipc.close(); } catch { /* */ }
  try { if (swarm) void swarm.destroy(); } catch { /* */ }
  process.exit(code);
}

function start() {
  // Clean a stale unix socket before binding.
  if (process.platform !== "win32" && existsSync(socketPath(account))) { try { unlinkSync(socketPath(account)); } catch { /* */ } }
  server.listen(0, "127.0.0.1", () => {
    const port = (server.address() as { port: number }).port;
    writeFileSync(pidPath(account), String(process.pid), "utf8");
    register(port);
    ipc.listen(socketPath(account), () => log(`daemon up · id ${peer.id} · ipc ${socketPath(account)} · tcp :${port}`));
    if (swarmEnabled) {
      try {
        swarm = new Hyperswarm();
        swarm.on("connection", (conn) => { log("swarm peer connected"); wireGossip(conn); });
        swarmJoinGroups();
        log("swarm transport enabled (public DHT)");
      } catch (e) { log("swarm init failed:", e instanceof Error ? e.message : String(e)); }
    }
    tick = setInterval(() => discoverTick(port), 2000);
    discoverTick(port);
  });
}

for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => shutdown(0));
start();
