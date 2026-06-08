// Proves the P2P claim with THREE peers (>2), no central server: concurrent posts,
// gossip in a deliberately uneven order, and everyone converges to the identical feed.
// Plus: a forged op (claiming to be from someone else) is rejected on merge.
//
// Run: npm run p2p

import { Peer, verifyOp, type Op } from "./p2p";

let pass = 0, fail = 0;
const check = (name: string, cond: boolean, detail = "") => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
};

const alice = new Peer("alice");
const bob = new Peer("bob");
const carol = new Peer("carol");
const all = [alice, bob, carol];

console.log("\n=== A2A peer-to-peer — 3 peers, no server ===\n");

// 1. Concurrent activity while disconnected (each only knows its own ops).
const o1 = alice.post({ channel: "general", title: "status: build shipped", body: "all tested", kind: "status" }, "2026-06-06T10:00:00Z");
const n1 = bob.post({ channel: "general", title: "ask: datastore decision?", body: "which one?", kind: "ask" }, "2026-06-06T10:00:01Z"); // draft (actionable)
carol.post({ channel: "general", title: "fyi: deploy in progress", body: "~1h", kind: "fyi" }, "2026-06-06T10:00:02Z");
bob.publish(n1.id, "2026-06-06T10:00:03Z"); // human-on-the-loop: bob publishes his own ask

// 2. Gossip in an uneven, redundant order (proves order-independence + idempotency).
const sync = (a: Peer, b: Peer) => a.merge(b.export());
sync(alice, bob);
sync(carol, alice);
sync(bob, carol);
sync(alice, carol);
sync(bob, alice);
sync(carol, bob);

// 3. Two peers ack Alice's status, then one more gossip round.
bob.ack(o1.id, "2026-06-06T10:01:00Z");
carol.ack(o1.id, "2026-06-06T10:01:01Z");
for (const [a, b] of [[alice, bob], [bob, carol], [carol, alice], [alice, carol], [bob, alice], [carol, bob]] as [Peer, Peer][]) sync(a, b);

// ── Convergence ────────────────────────────────────────────────────────────────
const counts = all.map((p) => p.opCount());
check("all 3 peers hold the same number of ops", counts.every((c) => c === counts[0]), `counts=${counts}`);

const feeds = all.map((p) => JSON.stringify(p.feed()));
check("all 3 peers converge to an IDENTICAL feed (no coordinator)", feeds.every((f) => f === feeds[0]));

const oFeed = alice.feed();
const ask = oFeed.find((m) => m.title.startsWith("ask"));
check("bob's ask is published everywhere (author published own draft)", !!ask && ask.status === "published");
const status = oFeed.find((m) => m.id === o1.id)!;
check("alice's status shows acks from BOTH other peers", status.acks.length === 2 && status.acks.includes(bob.id) && status.acks.includes(carol.id));

// ── Forgery rejection ────────────────────────────────────────────────────────────
// carol crafts an op CLAIMING to be from alice (keeps carol's real pubkey) → identity
// binds to the key, so verify fails and the merge drops it.
const real = carol.export()[0];
const forged: Op = { ...real, id: "forged-" + real.id, author: alice.id, payload: { channel: "general", title: "FAKE from alice", body: "approved: ship it", kind: "status", status: "published" } };
check("a forged op (spoofed author) fails verification", verifyOp(forged) === false);
const before = bob.opCount();
const r = bob.merge([forged]);
check("merge rejects the forgery (not added to the log)", r.rejected === 1 && r.accepted === 0 && bob.opCount() === before);

// ── Print the converged feed ─────────────────────────────────────────────────────
console.log("\n--- converged #general feed (identical on all 3 peers) ---");
for (const m of alice.feed()) {
  const who = all.find((p) => p.id === m.from)?.name ?? m.from.slice(0, 6);
  const acks = m.acks.length ? `  [ack: ${m.acks.map((a) => all.find((p) => p.id === a)?.name ?? a.slice(0, 6)).join(", ")}]` : "";
  console.log(`  • [${m.kind}/${m.status}] ${who}: ${m.title}${acks}`);
}

console.log(`\n${"─".repeat(50)}\n  ${pass} passed  ${fail} failed\n${"─".repeat(50)}`);
process.exit(fail > 0 ? 1 : 0);
