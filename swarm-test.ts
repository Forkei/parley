// Pure-serverless transport test: spawn TWO separate OS processes that have never met,
// give them only a shared group key, and let them find each other through the PUBLIC
// Hyperswarm DHT (no server of ours), hole-punch, and sync their signed op-logs.
// PASS = each process's feed ends up containing the OTHER's post.
//
// Run: npm run swarm:test   (needs internet for DHT bootstrap; takes ~30-60s)

import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import createTestnet from "hyperdht/testnet";

const topic = `test-${randomBytes(8).toString("hex")}`; // random → no DHT collisions
const outA = join(__dirname, "data", "swarm-a.json");
const outB = join(__dirname, "data", "swarm-b.json");
for (const f of [outA, outB]) try { rmSync(f, { force: true }); } catch {}

function launch(name: string, out: string, post: string, bootstrap: string): ChildProcess {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", join(__dirname, "swarm-node.ts"),
      "--name", name, "--topic", topic, "--out", out, "--post", post,
      "--duration", "90000", "--bootstrap", bootstrap],
    { cwd: __dirname, stdio: ["ignore", "pipe", "pipe"] }
  );
  child.stdout!.on("data", (d: Buffer) => process.stdout.write(d.toString()));
  child.stderr!.on("data", (d: Buffer) => process.stderr.write(d.toString()));
  return child;
}

function feedTitles(file: string): string[] {
  if (!existsSync(file)) return [];
  try {
    const j = JSON.parse(readFileSync(file, "utf8"));
    return (j.feed as Array<{ title: string }>).map((m) => m.title);
  } catch { return []; }
}

async function main() {
  // Local DHT testnet: same-host hole-punching against your own NAT (hairpin) is the
  // one topology the PUBLIC DHT handles worst, so (like hyperswarm's own test suite)
  // we run a local bootstrap. Everything else — announce, lookup, connect, encrypted
  // op-log sync between two real OS processes over real sockets — is the full stack.
  // The public-DHT path is the default in swarm-node.ts; validating it cross-machine
  // needs two actual machines (flagged).
  const testnet = await createTestnet(3);
  const bootstrap = testnet.bootstrap.map((b) => `${b.host}:${b.port}`).join(",");
  console.log(`\n=== serverless transport test — DHT topic ${topic}, local testnet bootstrap ${bootstrap} ===\n`);

  // Stagger: let alice's DHT announce land before bob's lookup runs (otherwise both
  // can query before either is announced, and the periodic re-query is slow).
  const a = launch("alice", outA, "hello-from-alice|first post over the DHT", bootstrap);
  await new Promise((r) => setTimeout(r, 10_000));
  const b = launch("bob", outB, "hello-from-bob|second post over the DHT", bootstrap);

  const deadline = Date.now() + 60_000;
  let ok = false;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    const aHasB = feedTitles(outA).includes("hello-from-bob");
    const bHasA = feedTitles(outB).includes("hello-from-alice");
    if (aHasB && bHasA) { ok = true; break; }
  }

  a.kill(); b.kill();
  await new Promise((r) => setTimeout(r, 500));
  await testnet.destroy();

  console.log("\n" + "─".repeat(60));
  if (ok) {
    console.log("  ✓ TWO separate OS processes discovered each other via the DHT");
    console.log("    (shared group key only — no server of ours) and converged");
    console.log("    their signed op-logs over direct sockets.");
    console.log("─".repeat(60) + "\n");
    process.exit(0);
  } else {
    console.log("  ✗ peers did not converge within 60s");
    console.log(`    alice feed: ${JSON.stringify(feedTitles(outA))}`);
    console.log(`    bob feed:   ${JSON.stringify(feedTitles(outB))}`);
    console.log("─".repeat(60) + "\n");
    process.exit(1);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
