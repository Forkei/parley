// A pure-serverless A2A node: the signed CRDT op-log (p2p.ts) over Hyperswarm —
// peers find each other through the PUBLIC DHT (no server of ours anywhere) and
// hole-punch direct connections. Group privacy: the swarm topic is the hash of a
// shared group key, so only people who know the key can even discover the swarm.
//
//   node --import tsx swarm-node.ts --name alice --topic <groupkey> --out feed.json
//        [--post "title|body"] [--duration 45000]
//
// Sync protocol (deliberately dumb for the spike): newline-delimited JSON; on connect
// send the full op-log; on receiving anything new, merge (signature-verified) and
// re-broadcast to all connections. Union-by-id makes the flood converge, not storm.

import { writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import type { Duplex } from "node:stream";
import Hyperswarm from "hyperswarm";
import { Peer, type Op } from "./p2p";

function arg(name: string, def?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  if (def !== undefined) return def;
  console.error(`missing --${name}`);
  process.exit(1);
}

const name = arg("name");
const topicKey = arg("topic");
const outFile = arg("out");
const postArg = process.argv.includes("--post") ? arg("post") : null;
const duration = Number(arg("duration", "45000"));
// Optional DHT bootstrap override ("host:port[,host:port]"). Default = the public DHT
// (the real serverless deployment mode). A local testnet bootstrap is used by
// swarm-test.ts because same-host hole-punching against your own NAT (hairpin) is the
// one topology the public DHT handles worst — real cross-machine use doesn't have this.
const bootstrapArg = process.argv.includes("--bootstrap") ? arg("bootstrap") : null;
const bootstrap = bootstrapArg
  ? bootstrapArg.split(",").map((s) => { const [host, port] = s.split(":"); return { host, port: Number(port) }; })
  : undefined;

const peer = new Peer(name);
const log = (...a: unknown[]) => console.log(`[${name}]`, ...a);

function writeFeed() {
  writeFileSync(outFile, JSON.stringify({ name, id: peer.id, ops: peer.opCount(), feed: peer.feed() }, null, 2), "utf8");
}

if (postArg) {
  const [title, body = ""] = postArg.split("|");
  peer.post({ channel: "swarm", title, body, kind: "status" }, new Date().toISOString());
  log(`posted: "${title}"`);
}
writeFeed();

const swarm = new Hyperswarm(bootstrap ? { bootstrap } : {});
const topic = createHash("sha256").update(`agent-comms:${topicKey}`).digest(); // 32 bytes
const conns = new Set<Duplex>();

function send(conn: Duplex, ops: Op[]) {
  try { conn.write(JSON.stringify({ type: "ops", ops }) + "\n"); } catch { /* conn gone */ }
}
function broadcast() {
  for (const c of conns) send(c, peer.export());
}

swarm.on("connection", (conn) => {
  conns.add(conn);
  log(`connection established (${conns.size} peer(s))`);
  send(conn, peer.export()); // initial full exchange
  let buf = "";
  conn.on("data", (chunk: Buffer) => {
    buf += chunk.toString("utf8");
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line) as { type: string; ops: Op[] };
        if (msg.type !== "ops") continue;
        const r = peer.merge(msg.ops, new Date().toISOString());
        if (r.accepted > 0) {
          log(`merged ${r.accepted} new op(s)${r.rejected ? `, rejected ${r.rejected}` : ""}`);
          writeFeed();
          broadcast(); // converges: peers that have everything accept 0 and stop
        }
      } catch { /* malformed line — ignore */ }
    }
  });
  conn.on("close", () => { conns.delete(conn); log(`connection closed (${conns.size} left)`); });
  conn.on("error", () => { conns.delete(conn); });
});

async function main() {
  const discovery = swarm.join(topic, { server: true, client: true });
  await discovery.flushed(); // fully announced to the DHT before we report ready
  await swarm.flush(); // initial lookups + connection attempts done
  log(`announced + lookup flushed (peer id ${peer.id})`);

  const tick = setInterval(() => {
    writeFeed();
    log(`status: ${conns.size} connection(s), ${peer.opCount()} ops`);
  }, 5000);
  setTimeout(async () => {
    clearInterval(tick);
    writeFeed();
    log(`done — ${peer.opCount()} ops in log`);
    await swarm.destroy();
    process.exit(0);
  }, duration);
}

main().catch((e) => { console.error(e); process.exit(1); });
