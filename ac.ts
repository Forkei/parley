#!/usr/bin/env tsx
// `parley` — the agent-comms CLI. Step 1: identity persistence + accounts + directory binding.
// (Daemon + talking land in the next step.) Designed for an AGENT to drive from a shell:
// short commands, --json on reads, account resolves from the working directory.
//
//   parley init --as <name> [--account <a>]   create a persisted identity, bind this dir to it
//   parley accounts                            list accounts on this machine
//   parley use <account>                       bind THIS directory to an account
//   parley whoami                              show the active account (resolved from cwd)
//   parley card                                print this agent's shareable contact card
//
// Account resolution: --account <a>  >  PARLEY_ACCOUNT env  >  directory binding  >  "default".

import { connect } from "node:net";
import { spawn } from "node:child_process";
import { openSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  listAccounts, createAccount, loadIdentity, bindDir, resolveAccount, accountExists,
  socketPath, pidPath, daemonLogPath, setIdentityCert, getPetnames, setPetname, getPins, setPin,
  getSharedContacts,
} from "./home";
import { principalExists, createPrincipal, loadPrincipal, issueCert, verifyCert } from "./principal";

const HERE = __dirname;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Send one request to the account's daemon over its IPC socket; resolve its reply.
// With { wait:true } the socket is held open (no timeout) until the daemon pushes a line.
function daemonCall(account: string, req: object, opts?: { wait?: boolean }): Promise<any> {
  return new Promise((resolve, reject) => {
    const sock = connect(socketPath(account));
    let buf = "";
    const timer = opts?.wait ? null : setTimeout(() => { sock.destroy(); reject(new Error("daemon not responding")); }, 8000);
    sock.on("connect", () => sock.write(JSON.stringify(req) + "\n"));
    sock.on("data", (c: Buffer) => {
      buf += c.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl >= 0) { if (timer) clearTimeout(timer); sock.end(); try { resolve(JSON.parse(buf.slice(0, nl))); } catch (e) { reject(e); } }
    });
    sock.on("error", (e: NodeJS.ErrnoException) => {
      if (timer) clearTimeout(timer);
      reject(new Error(e.code === "ENOENT" || e.code === "ECONNREFUSED"
        ? `no daemon for "${account}" — run: parley up` : String(e.message)));
    });
  });
}

// Parse position-independently: pull the global --account out anywhere it appears, then
// cmd = first remaining token, and the rest are the command's positionals/flags.
const raw = process.argv.slice(2);
let accountFlag: string | undefined;
const rest: string[] = [];
for (let i = 0; i < raw.length; i++) {
  if (raw[i] === "--account") { accountFlag = raw[i + 1]; i++; continue; }
  rest.push(raw[i]);
}
const cmd = rest[0];
const args = rest.slice(1);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : undefined;
};
const has = (name: string) => args.includes(`--${name}`);
const positional = args.filter((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1].startsWith("--")));
const json = has("json");
const now = () => new Date().toISOString();

function activeAccount(): string {
  return accountFlag || process.env.PARLEY_ACCOUNT?.trim() || resolveAccount(process.cwd()) || "default";
}
const out = (obj: unknown, human: () => void) => { if (json) console.log(JSON.stringify(obj, null, 2)); else human(); };
const die = (msg: string): never => { console.error(`parley: ${msg}`); process.exit(1); };

function cmdInit() {
  const account = accountFlag || "default";
  const name = flag("as") || account;
  if (accountExists(account)) die(`account "${account}" already exists — try: parley whoami`);
  const id = createAccount(account, name, now());
  bindDir(process.cwd(), account); // this directory now defaults to this account
  // If a principal exists on this machine, vouch for this agent (provenance).
  let cert: ReturnType<typeof issueCert> | undefined;
  if (principalExists()) { cert = issueCert(id.ed_pub, name, now()); setIdentityCert(account, cert); }
  out({ ok: true, account: id.account, id: id.id, name: id.name, principal: cert?.principal_name ?? null }, () => {
    console.log(`✓ identity created`);
    console.log(`  account : ${id.account}`);
    console.log(`  id      : ${id.id}   ("${id.name}")`);
    console.log(`  keys    : ~/.parley/accounts/${id.account}/identity.json  (ed25519 + x25519, local only)`);
    console.log(`  bound   : this directory → "${id.account}"`);
    if (cert) console.log(`  vouched : by principal "${cert.principal_name}" (${cert.principal_id})`);
    else console.log(`  note    : no principal — run 'parley principal init --as <you>' first for provenance`);
  });
}

function cmdPrincipal() {
  const sub = positional[0];
  if (sub === "init") {
    const name = flag("as") || positional[1];
    if (!name) return die("usage: parley principal init --as <name>");
    if (principalExists()) { const p = loadPrincipal()!; return die(`principal already exists: "${p.name}" (${p.id})`); }
    const p = createPrincipal(name, now());
    return out({ ok: true, id: p.id, name: p.name }, () => {
      console.log(`✓ principal "${p.name}" created · ${p.id}`);
      console.log(`  every agent you 'init' on this machine is vouched as "${p.name}".`);
      console.log(`  keep ~/.parley/principal.json safe — it's your root identity.`);
    });
  }
  const p = loadPrincipal();
  out(p ? { id: p.id, name: p.name } : null, () => console.log(p ? `principal: "${p.name}" (${p.id})` : "(no principal — run: parley principal init --as <name>)"));
}

function provLabel(c: any) { return c.verified ? `✓ ${c.principal}'s agent` : "· unverified"; }

async function cmdContacts() {
  const account = activeAccount();
  const r = await daemonCall(account, { cmd: "contacts" });
  if (r.error) return die(r.error);
  const pet = getPetnames(account);
  const live = r.contacts as any[];
  const liveIds = new Set(live.map((c) => c.id));
  const sharedExtra = Object.values(getSharedContacts()).filter((c) => !liveIds.has(c.id)); // machine pool, not already live
  out({ contacts: live.map((c: any) => ({ ...c, petname: pet[c.id] || null })), shared: sharedExtra }, () => {
    if (!live.length && !sharedExtra.length) return console.log("(no contacts yet — join a group with someone)");
    for (const c of live) console.log(`  ${c.id}  ${(pet[c.id] ? `"${pet[c.id]}"` : `"${c.name}"`).padEnd(22)} ${provLabel(c)}`);
    for (const c of sharedExtra as any[]) console.log(`  ${c.id}  ${(pet[c.id] ? `"${pet[c.id]}"` : `"${c.name}"`).padEnd(22)} ${provLabel(c)}  [shared]`);
  });
}

async function cmdContact() {
  const sub = positional[0];
  if (sub === "name") {
    const id = positional[1]; const petname = positional.slice(2).join(" ");
    if (!id || !petname) return die("usage: parley contact name <id> <petname>");
    setPetname(activeAccount(), id, petname);
    return out({ ok: true, id, petname }, () => console.log(`✓ ${id.slice(0, 8)} → "${petname}"`));
  }
  if (sub === "share") {
    const id = positional[1];
    if (!id) return die("usage: parley contact share <id>");
    const r = await daemonCall(activeAccount(), { cmd: "share", id });
    if (r.error) return die(r.error);
    return out(r, () => console.log(`✓ shared ${String(r.id).slice(0, 8)} to this machine's address book — sibling agents can now reach them`));
  }
  die("usage: parley contact name <id> <petname>  |  parley contact share <id>");
}

async function cmdInvite() {
  const to = flag("to"); const group = flag("group") || positional[0];
  if (!to || !group) return die("usage: parley invite --to <id> --group <group>");
  const r = await daemonCall(activeAccount(), { cmd: "invite", to, group });
  if (r.error) return die(r.error);
  out(r, () => { console.log(r.token); console.log(`  ↳ leak-safe: only that recipient can redeem it →  parley join --invite <token>`); });
}

function cmdAccounts() {
  const active = resolveAccount(process.cwd());
  const list = listAccounts().map((a) => ({ account: a.account, id: a.id, name: a.name, active: a.account === active }));
  out(list, () => {
    if (!list.length) return console.log("(no accounts yet — run: parley init --as <name>)");
    for (const a of list) console.log(`  ${a.active ? "▶" : " "} ${a.account.padEnd(16)} ${a.id}  "${a.name}"`);
  });
}

function cmdUse() {
  const account = positional[0] || accountFlag;
  if (!account) return die("usage: parley use <account>");
  if (!accountExists(account)) return die(`no such account "${account}" — run: parley --account ${account} init --as <name>`);
  bindDir(process.cwd(), account);
  out({ ok: true, account, dir: process.cwd() }, () => console.log(`✓ this directory → "${account}"`));
}

function cmdWhoami() {
  const account = activeAccount();
  const id = loadIdentity(account);
  if (!id) die(`no active account (resolved "${account}", which doesn't exist) — run: parley init --as <name>`);
  out({ account: id!.account, id: id!.id, name: id!.name, source: accountFlag ? "flag" : resolveAccount(process.cwd()) ? "directory" : "default" },
    () => console.log(`${id!.id}  "${id!.name}"  (account: ${id!.account})`));
}

function cmdCard() {
  const account = activeAccount();
  const id = loadIdentity(account);
  if (!id) die(`no active account — run: parley init --as <name>`);
  // One paste-able token: fingerprint + enc-key + name. (Safety-words + principal cert
  // come with the principal layer.) enc_pub lets a recipient seal a DM to this agent.
  const card = `parley://${id!.id}?n=${encodeURIComponent(id!.name)}&k=${id!.enc_pub}`;
  out({ card, id: id!.id, name: id!.name }, () => {
    console.log(card);
    console.log(`  ↳ share this so others can add + DM you  (id ${id!.id}, "${id!.name}")`);
  });
}

// ─── daemon + messaging ─────────────────────────────────────────────────────────

function spawnDaemon(account: string, swarm = false) {
  const fd = openSync(daemonLogPath(account), "a");
  const args = ["--import", "tsx", join(HERE, "daemon.ts"), "--account", account];
  if (swarm) args.push("--swarm"); // cross-machine transport (public DHT)
  const child = spawn(process.execPath, args, { detached: true, stdio: ["ignore", fd, fd], windowsHide: true });
  child.unref();
}

async function cmdUp() {
  const account = activeAccount();
  if (!loadIdentity(account)) return die(`no account "${account}" — run: parley init --as <name>`);
  if (existsSync(pidPath(account))) {
    try { await daemonCall(account, { cmd: "status" }); return out({ ok: true, already: true, account }, () => console.log(`daemon already running for "${account}"`)); }
    catch { /* stale pidfile — respawn */ }
  }
  spawnDaemon(account, has("swarm"));
  for (let i = 0; i < 40; i++) {
    try { const s = await daemonCall(account, { cmd: "status" }); return out(s, () => console.log(`✓ daemon started · "${account}" (${s.id}) · ${s.groups.length} group(s)${has("swarm") ? " · swarm" : ""}`)); }
    catch { await sleep(150); }
  }
  die(`daemon failed to start — see ${daemonLogPath(account)}`);
}

async function cmdDown() {
  const targets = has("all") ? listAccounts().map((a) => a.account) : [activeAccount()];
  for (const a of targets) {
    try { await daemonCall(a, { cmd: "stop" }); console.log(`✓ stopped "${a}"`); }
    catch {
      try { process.kill(Number(readFileSync(pidPath(a), "utf8"))); console.log(`✓ killed "${a}"`); }
      catch { console.log(`(no running daemon for "${a}")`); }
    }
  }
}

async function cmdJoin() {
  const invite = flag("invite");
  if (invite) {
    const r = await daemonCall(activeAccount(), { cmd: "join-invite", token: invite });
    if (r.error) return die(r.error);
    return out(r, () => console.log(`✓ joined "${r.group}" via invite`));
  }
  const name = positional[0]; const key = flag("key");
  if (!name || !key) return die("usage: parley join <group> --key <key>   |   parley join --invite <token>");
  const r = await daemonCall(activeAccount(), { cmd: "join", name, key });
  if (r.error) return die(r.error);
  out(r, () => console.log(`✓ joined "${name}"`));
}

async function cmdPost() {
  const group = positional[0]; const text = positional.slice(1).join(" ");
  if (!group || !text) return die('usage: parley post <group> "<text>"');
  const r = await daemonCall(activeAccount(), { cmd: "post", group, text });
  if (r.error) return die(r.error);
  out(r, () => console.log(`✓ → #${group}  (${String(r.id).slice(0, 8)})`));
}

async function cmdDm() {
  const to = positional[0]; const text = positional.slice(1).join(" ");
  if (!to || !text) return die('usage: parley dm <id> "<text>"');
  const r = await daemonCall(activeAccount(), { cmd: "dm", to, text });
  if (r.error) return die(r.error);
  out(r, () => console.log(`✓ dm → ${to.slice(0, 8)}  (${String(r.id).slice(0, 8)})`));
}

function renderMsgs(msgs: any[]) {
  if (!msgs.length) return console.log("(nothing new)");
  for (const m of msgs) {
    const where = m.dm ? "DM" : `#${m.channel}`;
    const rcpt = m.receipts?.length ? `  ⟦${m.receipts.map((r: any) => `${r.kind}:${r.by.slice(0, 6)}`).join(",")}⟧` : "";
    const acks = m.acks?.length ? `  ack×${m.acks.length}` : "";
    // Lead with the short message id so a received message is directly actionable (parley status <id>).
    console.log(`  ${String(m.id).slice(0, 8)}  ${where.padEnd(10)} ${String(m.from).slice(0, 8)} → ${m.title}${rcpt}${acks}`);
  }
}

async function cmdFeed() {
  const r = await daemonCall(activeAccount(), { cmd: "feed", group: flag("group"), since: flag("since") ? Number(flag("since")) : undefined });
  if (r.error) return die(r.error);
  out(r.messages, () => renderMsgs(r.messages));
}

async function cmdInbox() {
  const r = await daemonCall(activeAccount(), { cmd: "inbox" });
  if (r.error) return die(r.error);
  out(r.messages, () => { console.log(`inbox · ${r.messages.length} new`); renderMsgs(r.messages); });
}

async function cmdWait() {
  const r = await daemonCall(activeAccount(), { cmd: "wait" }, { wait: true });
  out(r.message, () => { console.log("● new:"); renderMsgs([r.message]); });
}

async function cmdStatus() {
  const account = activeAccount();
  const mid = positional[0];
  if (!mid) { const s = await daemonCall(account, { cmd: "status" }); return out(s, () => console.log(`"${account}" ${s.id} · ${s.peers} peer(s) · ${s.groups.length} group(s) · ${s.ops} ops`)); }
  const r = await daemonCall(account, { cmd: "msgstatus", id: mid });
  if (r.error) return die(r.error);
  const m = r.message;
  out(m, () => { const d = m.receipts?.find((x: any) => x.kind === "delivered"); console.log(`${mid.slice(0, 8)} → ${m.dm ? "dm" : "#" + m.channel}  ${d ? `delivered ✓ by ${d.by.slice(0, 6)}` : "sent (no receipt yet)"}`); });
}

async function cmdPs() {
  const all = has("all");
  const targets = all ? listAccounts().map((a) => a.account) : [activeAccount()];
  const rows: any[] = [];
  for (const a of targets) {
    try { const s = await daemonCall(a, { cmd: "status" }); rows.push({ account: a, running: true, ...s }); }
    catch { rows.push({ account: a, running: false }); }
  }
  out(all ? rows : rows[0], () => {
    for (const r of rows) {
      if (r.running) console.log(`  ● ${String(r.account).padEnd(16)} running · ${r.id} · ${r.peers} peer(s) · ${r.groups.length} grp · ${r.ops} ops`);
      else console.log(`  ○ ${String(r.account).padEnd(16)} not running   (run: parley up)`);
    }
  });
  if (!all && rows[0] && !rows[0].running) process.exitCode = 1; // scriptable: nonzero = down
}

async function cmdVerify() {
  const id = positional[0];
  if (!id) return die("usage: parley verify <id>");
  const account = activeAccount();
  const r = await daemonCall(account, { cmd: "certof", id });
  if (r.error) return die(r.error);
  const cert = r.cert;
  const ok = !!cert && verifyCert(cert) && cert.agent_pub === r.pubkey;
  let tofu = "—";
  if (ok) {
    const pinned = getPins(account)[cert.principal_name];
    if (!pinned) { setPin(account, cert.principal_name, cert.principal_id); tofu = "pinned (first seen) ✓"; }
    else if (pinned === cert.principal_id) tofu = "matches pin ✓";
    else tofu = `⚠ MISMATCH — pinned ${pinned}, got ${cert.principal_id} (possible impersonation)`;
  }
  out({ id: r.id, name: r.name, verified: ok, principal: ok ? { name: cert.principal_name, id: cert.principal_id } : null, tofu }, () => {
    console.log(`agent     : ${r.id}  "${r.name}"`);
    if (!cert) return console.log(`provenance: ✗ no cert — UNVERIFIED (treat the name as an unproven claim)`);
    console.log(`cert      : ${ok ? "valid ✓" : "INVALID ✗"}`);
    console.log(`binding   : cert ↔ sender key  ${cert.agent_pub === r.pubkey ? "ok" : "MISMATCH ✗"}`);
    console.log(`principal : "${cert.principal_name}"  (${cert.principal_id})`);
    console.log(`TOFU pin  : ${tofu}`);
  });
}

// Run a handler command per inbound message: message JSON → its stdin; its stdout (if any) →
// posted back as a reply (DM to the sender if it was a DM, else to the same group).
function runHandler(account: string, cmd: string, m: any): Promise<void> {
  return new Promise((resolve) => {
    const child = spawn(cmd, { shell: true, stdio: ["pipe", "pipe", "inherit"] });
    let outp = "";
    child.stdout.on("data", (d: Buffer) => (outp += d.toString()));
    child.on("close", async () => {
      const reply = outp.trim();
      if (reply) {
        try {
          if (m.dm) await daemonCall(account, { cmd: "dm", to: m.from, text: reply });
          else await daemonCall(account, { cmd: "post", group: m.channel, text: reply });
        } catch { /* best-effort */ }
      }
      resolve();
    });
    child.stdin.write(JSON.stringify(m)); child.stdin.end();
  });
}

function cmdListen() {
  const account = activeAccount();
  if (!loadIdentity(account)) return die(`no account "${account}" — run: parley init --as <name>`);
  const exec = flag("exec"); // optional auto-reply handler
  const sock = connect(socketPath(account));
  let buf = "";
  let queue: Promise<void> = Promise.resolve();
  sock.on("connect", () => {
    sock.write(JSON.stringify({ cmd: "listen" }) + "\n");
    if (!json) console.error(`◉ listening as "${account}"${exec ? ` · auto-reply: ${exec}` : ""}  (Ctrl-C to stop)`);
  });
  sock.on("data", (c: Buffer) => {
    buf += c.toString("utf8");
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      let m: any; try { m = JSON.parse(line).message; } catch { continue; }
      if (!m) continue;
      if (json) console.log(JSON.stringify(m)); else renderMsgs([m]);
      if (exec) queue = queue.then(() => runHandler(account, exec, m)); // serialize replies
    }
  });
  sock.on("error", (e: NodeJS.ErrnoException) => die(e.code === "ENOENT" || e.code === "ECONNREFUSED" ? `no daemon for "${account}" — run: parley up` : String(e.message)));
  // the open socket keeps the process alive until Ctrl-C
}

const commands: Record<string, () => void | Promise<void>> = {
  init: cmdInit, accounts: cmdAccounts, use: cmdUse, whoami: cmdWhoami, card: cmdCard,
  principal: cmdPrincipal, contacts: cmdContacts, contact: cmdContact, verify: cmdVerify,
  up: cmdUp, down: cmdDown, ps: cmdPs, join: cmdJoin, invite: cmdInvite, post: cmdPost, dm: cmdDm,
  feed: cmdFeed, inbox: cmdInbox, wait: cmdWait, listen: cmdListen, status: cmdStatus,
};

if (!cmd || cmd === "help" || cmd === "--help") {
  console.log([
    "parley — agent-comms",
    "  principal: principal init --as <name>   (root identity — vouches for your agents)",
    "  identity:  init --as <name> [--account <a>] · accounts · use <account> · whoami · card",
    "  daemon:    up [--swarm] · down [--all] · ps [--all]   (ps: is it running? exit 0/1)",
    "  groups:    join <group> --key <key> · join --invite <token> · invite --to <id> --group <g>",
    "  contacts:  contacts · contact name <id> <petname> · contact share <id> · verify <id>",
    "  talk:      post <group> \"<text>\" · dm <id> \"<text>\" · inbox · feed [--group g]",
    "  receive:   wait (one msg) · listen [--exec \"<cmd>\"] (stream; --exec auto-replies)",
    "  message:   status <msg-id>     (delivery receipts)",
    "  (add --json to any read for machine output; account resolves from your directory)",
  ].join("\n"));
  process.exit(0);
}
const handler = commands[cmd];
if (!handler) die(`unknown command "${cmd}" (try: parley help)`);
Promise.resolve(handler()).catch((e) => die(e instanceof Error ? e.message : String(e)));
