// Principal layer — the trust anchor ABOVE individual agents (Build design: root → agent;
// device tier added when multi-machine matters). A principal = a human/org root keypair.
// Each agent's key is SIGNED by the principal into a cert, so a brand-new agent can prove
// "I'm one of <principal>'s" without ever having been seen before — and individual agents
// stay non-discoverable (only the principal is a stable thing).
//
// v1: the principal signs agent keys directly. The root key lives at ~/.parley/principal.json.

import { generateKeyPairSync, createPrivateKey, createPublicKey, sign, verify, createHash } from "node:crypto";
import { join } from "node:path";
import { existsSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { HOME } from "./home";

const principalPath = () => join(HOME, "principal.json");
const fp = (pubB64: string) => createHash("sha256").update(pubB64).digest("hex").slice(0, 16);

export interface PrincipalStore { id: string; name: string; ed_priv: string; ed_pub: string; created: string; }
export interface Cert {
  principal_id: string; principal_pub: string; principal_name: string;
  agent_pub: string; agent_name: string; issued: string; sig: string;
}

export function principalExists(): boolean { return existsSync(principalPath()); }
export function loadPrincipal(): PrincipalStore | null {
  try { return JSON.parse(readFileSync(principalPath(), "utf8")) as PrincipalStore; } catch { return null; }
}
export function createPrincipal(name: string, nowTs: string): PrincipalStore {
  if (principalExists()) throw new Error("a principal already exists on this machine");
  const sk = generateKeyPairSync("ed25519");
  const ed_pub = sk.publicKey.export({ type: "spki", format: "der" }).toString("base64");
  const ed_priv = sk.privateKey.export({ type: "pkcs8", format: "der" }).toString("base64");
  const store: PrincipalStore = { id: fp(ed_pub), name, ed_priv, ed_pub, created: nowTs };
  mkdirSync(HOME, { recursive: true }); // principal may be the very first thing created
  writeFileSync(principalPath(), JSON.stringify(store, null, 2), "utf8");
  return store;
}

// Canonical body the principal signs — binds the principal to THIS agent key + name.
function certBody(c: Omit<Cert, "sig">): string {
  return JSON.stringify([c.principal_id, c.principal_pub, c.principal_name, c.agent_pub, c.agent_name, c.issued]);
}

export function issueCert(agentPubB64: string, agentName: string, nowTs: string): Cert {
  const p = loadPrincipal();
  if (!p) throw new Error("no principal on this machine — run: ac principal init --as <name>");
  const base: Omit<Cert, "sig"> = {
    principal_id: p.id, principal_pub: p.ed_pub, principal_name: p.name,
    agent_pub: agentPubB64, agent_name: agentName, issued: nowTs,
  };
  const priv = createPrivateKey({ key: Buffer.from(p.ed_priv, "base64"), format: "der", type: "pkcs8" });
  const sig = sign(null, Buffer.from(certBody(base)), priv).toString("base64");
  return { ...base, sig };
}

/** Verify a cert: the principal id binds to its key, and the signature is valid. The caller
 *  must ALSO check cert.agent_pub === the op's pubkey to bind the cert to the actual sender. */
export function verifyCert(c: Cert | undefined | null): boolean {
  if (!c || typeof c.sig !== "string") return false;
  if (c.principal_id !== fp(c.principal_pub)) return false;
  try {
    const pub = createPublicKey({ key: Buffer.from(c.principal_pub, "base64"), format: "der", type: "spki" });
    return verify(null, Buffer.from(certBody({ ...c })), pub, Buffer.from(c.sig, "base64"));
  } catch { return false; }
}
