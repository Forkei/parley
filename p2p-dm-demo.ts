// E2EE DMs + delivery/read receipts over the P2P op-log — the answers to "does the
// packet pass through a 3rd machine?" (yes, but it can't read it) and "do we get
// Delivered tags?" (yes — signed receipt ops that gossip back).
//
// Scenario: Alice DMs Bob while Bob is OFFLINE. The op travels via Carol (relay),
// who stores-and-forwards an opaque blob he cannot decrypt. When Bob comes online and
// syncs, his machine decrypts + auto-emits a signed "delivered" receipt; when the human
// reads it, a "read" receipt. Both gossip back to Alice through Carol.
//
// Run: npm run p2p:dm

import { Peer } from "./p2p";

let pass = 0, fail = 0;
const check = (name: string, cond: boolean, detail = "") => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
};

const alice = new Peer("alice");
const bob = new Peer("bob");
const carol = new Peer("carol");
const names = new Map([[alice.id, "alice"], [bob.id, "bob"], [carol.id, "carol"]]);

console.log("\n=== E2EE DM through a relay + receipts (3 peers, no server) ===\n");

// 0. Everyone has posted SOMETHING before (ops carry encryption keys), and one full
//    gossip round has happened — so peers know each other's keys.
alice.post({ channel: "general", title: "hello from alice", body: "-", kind: "fyi" }, "T0");
bob.post({ channel: "general", title: "hello from bob", body: "-", kind: "fyi" }, "T0");
carol.post({ channel: "general", title: "hello from carol", body: "-", kind: "fyi" }, "T0");
for (const [a, b] of [[alice, bob], [bob, carol], [carol, alice], [alice, carol], [bob, alice], [carol, bob]] as [Peer, Peer][]) a.merge(b.export());
check("peers learned each other's encryption keys via gossip", !!alice.encKeyOf(bob.id) && !!carol.encKeyOf(alice.id));

// 1. Bob goes OFFLINE. Alice sends him an E2EE DM.
const dm = alice.sendDM(bob.id, { channel: "general", title: "DM: payout details", body: "IBAN FR76 ... — between us." }, "T1");

// 2. Alice syncs with Carol only (the relay). Carol stores the op but CANNOT read it.
carol.merge(alice.export(), "T2");
const carolView = carol.feed().find((m) => m.id === dm.id)!;
check("relay (carol) HOLDS the DM op (store-and-forward works)", !!carolView);
check("relay CANNOT read the content (E2EE)", carolView.title === "(encrypted dm)" && carolView.body === "" && carolView.dm?.canRead === false);
check("relay did NOT emit a delivered receipt (it isn't the recipient)", carolView.receipts.length === 0);

// 3. Bob comes online and syncs with Carol → receives, decrypts, auto-emits DELIVERED.
const r = bob.merge(carol.export(), "T3");
check("bob's machine auto-emitted a signed delivered receipt", r.deliveredReceipts === 1);
const bobView = bob.feed().find((m) => m.id === dm.id)!;
check("bob can READ the DM content", bobView.dm?.canRead === true && bobView.title === "DM: payout details" && /IBAN/.test(bobView.body));

// 4. The human reads it → read receipt.
bob.markRead(dm.id, "T4");

// 5. Receipts gossip back: bob → carol → alice (alice never talks to bob directly).
carol.merge(bob.export(), "T5");
alice.merge(carol.export(), "T6");
const oView = alice.feed().find((m) => m.id === dm.id)!;
check("alice sees DELIVERED ✓ (signed by bob, relayed via carol)", oView.receipts.some((x) => x.by === bob.id && x.kind === "delivered"));
check("alice sees READ ✓", oView.receipts.some((x) => x.by === bob.id && x.kind === "read"));

// 6. Forged receipt: carol can't fake "delivered by bob" — receipts are signed ops.
const fakeReceipt = { ...carol.export().find((o) => o.type === "ack")! };
fakeReceipt.author = bob.id; // claim bob emitted it (keeps carol's keys)
fakeReceipt.id = "forged-" + fakeReceipt.id;
const fr = alice.merge([fakeReceipt], "T7");
check("a forged receipt (spoofed author) is rejected", fr.rejected === 1 && fr.accepted === 0);

console.log("\n--- alice's view of the DM ---");
console.log(`  [dm → ${names.get(oView.dm!.to)}] ${oView.title}  receipts: ${oView.receipts.map((x) => `${x.kind}✓ by ${names.get(x.by)}`).join(", ")}`);
console.log("--- carol (relay) sees only ---");
console.log(`  [dm → ${names.get(carolView.dm!.to)}] ${carol.feed().find((m) => m.id === dm.id)!.title}`);

console.log(`\n${"─".repeat(50)}\n  ${pass} passed  ${fail} failed\n${"─".repeat(50)}`);
process.exit(fail > 0 ? 1 : 0);
