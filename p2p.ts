// P2P data layer — the foundation for two-machine AND multi-party (N>2) comms with NO
// central server.
//
// Why a CRDT op-log: every change (post / publish / ack / receipt) is an IMMUTABLE,
// SIGNED operation; state = a deterministic fold over the merged op set. Merge is
// union-by-id → commutative, idempotent, associative — any peers gossiping in ANY order
// converge identically with no coordinator. Naturally N-party. Transport-agnostic
// (Hyperswarm / relay / shared blob all work).
//
// Trust without a server:
//   • IDENTITY/AUTHENTICITY — ed25519: a peer's id IS its signing-key fingerprint; every
//     op is signed; relayed ops verify anywhere; spoofs drop on merge.
//   • DM PRIVACY (E2EE) — x25519 sealed-box: a DM's content is encrypted to the
//     recipient's key with an ephemeral ECDH key. Relaying peers store-and-forward an
//     opaque blob they CANNOT read; only routing metadata (to/from) is visible.
//   • RECEIPTS — when the recipient's machine receives+decrypts a DM, it auto-emits a
//     signed "delivered" receipt op (and "read" when the human sees it), which gossips
//     back to the sender. Signed ⇒ the sender can trust it.

import {
  generateKeyPairSync, createPublicKey, createPrivateKey, sign as edSign, verify as edVerify,
  createHash, diffieHellman, randomBytes, createCipheriv, createDecipheriv,
  type KeyObject,
} from "node:crypto";

export type OpType = "post" | "publish" | "ack";

/** Serializable identity keys (base64 DER) — the on-disk keystore shape so an agent
 *  keeps a STABLE identity across restarts instead of being a stranger every run. */
export interface PersistedKeys {
  ed_priv: string; // ed25519 signing key, PKCS8 DER b64
  ed_pub: string; // ed25519 public, SPKI DER b64
  enc_priv: string; // x25519 private, PKCS8 DER b64
  enc_pub: string; // x25519 public, SPKI DER b64
}

export interface Op {
  id: string; // sha256 of the canonical body — stable, dedupe key
  type: OpType;
  author: string; // peer fingerprint (must equal fingerprint(pubkey))
  lamport: number; // logical clock → deterministic cross-peer ordering
  ts: string;
  payload: Record<string, unknown>;
  pubkey: string; // base64 SPKI DER ed25519 (verify anywhere, no directory)
  encPub: string; // base64 SPKI DER x25519 (so anyone can encrypt DMs to this peer)
  sig: string; // base64 ed25519 signature over the canonical body
}

export interface Receipt { by: string; kind: "delivered" | "read" }

export interface DerivedMessage {
  id: string; channel: string; from: string; title: string; body: string;
  kind: string; status: "draft" | "published"; reply_to: string | null;
  lamport: number; ts: string; acks: string[];
  dm: { to: string; canRead: boolean } | null; // null = broadcast
  receipts: Receipt[];
}

function fingerprint(pubkeyB64: string): string {
  return createHash("sha256").update(pubkeyB64).digest("hex").slice(0, 16);
}
function canonicalBody(op: Omit<Op, "id" | "sig">): string {
  return JSON.stringify([op.type, op.author, op.lamport, op.ts, op.payload, op.pubkey, op.encPub]);
}

export function verifyOp(op: Op): boolean {
  if (!op || typeof op.sig !== "string" || typeof op.pubkey !== "string") return false;
  if (op.author !== fingerprint(op.pubkey)) return false; // identity binds to the key
  const body = canonicalBody(op);
  if (createHash("sha256").update(body).digest("hex") !== op.id) return false; // integrity
  try {
    const key = createPublicKey({ key: Buffer.from(op.pubkey, "base64"), format: "der", type: "spki" });
    return edVerify(null, Buffer.from(body), key, Buffer.from(op.sig, "base64")); // authenticity
  } catch {
    return false;
  }
}

// ─── E2EE primitives (x25519 ECDH + AES-256-GCM, sealed-box style) ───────────────
function sealTo(recipientEncPubB64: string, plaintext: string): { ephPub: string; nonce: string; ct: string } {
  const eph = generateKeyPairSync("x25519");
  const recipientKey = createPublicKey({ key: Buffer.from(recipientEncPubB64, "base64"), format: "der", type: "spki" });
  const shared = diffieHellman({ privateKey: eph.privateKey, publicKey: recipientKey });
  const key = createHash("sha256").update(shared).digest(); // 32 bytes
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final(), cipher.getAuthTag()]);
  return {
    ephPub: eph.publicKey.export({ type: "spki", format: "der" }).toString("base64"),
    nonce: nonce.toString("base64"),
    ct: ct.toString("base64"),
  };
}
function openSealed(encPriv: KeyObject, box: { ephPub: string; nonce: string; ct: string }): string | null {
  try {
    const ephKey = createPublicKey({ key: Buffer.from(box.ephPub, "base64"), format: "der", type: "spki" });
    const shared = diffieHellman({ privateKey: encPriv, publicKey: ephKey });
    const key = createHash("sha256").update(shared).digest();
    const raw = Buffer.from(box.ct, "base64");
    const tag = raw.subarray(raw.length - 16);
    const data = raw.subarray(0, raw.length - 16);
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(box.nonce, "base64"));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
  } catch {
    return null; // not for us / tampered
  }
}

const ACTIONABLE = new Set(["ask", "decision"]);

export class Peer {
  readonly id: string;
  private priv: KeyObject; // ed25519 signing
  private pubB64: string;
  private encPriv: KeyObject; // x25519 encryption
  private encPubB64: string;
  private lamport = 0;
  private ops = new Map<string, Op>();

  constructor(readonly name: string, keys?: PersistedKeys) {
    if (keys) {
      // Restore a persisted identity (stable across restarts).
      this.priv = createPrivateKey({ key: Buffer.from(keys.ed_priv, "base64"), format: "der", type: "pkcs8" });
      this.pubB64 = keys.ed_pub;
      this.encPriv = createPrivateKey({ key: Buffer.from(keys.enc_priv, "base64"), format: "der", type: "pkcs8" });
      this.encPubB64 = keys.enc_pub;
    } else {
      const sk = generateKeyPairSync("ed25519");
      this.priv = sk.privateKey;
      this.pubB64 = sk.publicKey.export({ type: "spki", format: "der" }).toString("base64");
      const ek = generateKeyPairSync("x25519");
      this.encPriv = ek.privateKey;
      this.encPubB64 = ek.publicKey.export({ type: "spki", format: "der" }).toString("base64");
    }
    this.id = fingerprint(this.pubB64);
  }

  /** Export the keypair for the on-disk keystore. */
  exportKeys(): PersistedKeys {
    return {
      ed_priv: this.priv.export({ type: "pkcs8", format: "der" }).toString("base64"),
      ed_pub: this.pubB64,
      enc_priv: this.encPriv.export({ type: "pkcs8", format: "der" }).toString("base64"),
      enc_pub: this.encPubB64,
    };
  }

  private emit(type: OpType, payload: Record<string, unknown>, ts: string): Op {
    const base = { type, author: this.id, lamport: ++this.lamport, ts, payload, pubkey: this.pubB64, encPub: this.encPubB64 };
    const body = canonicalBody(base);
    const id = createHash("sha256").update(body).digest("hex");
    const sig = edSign(null, Buffer.from(body), this.priv).toString("base64");
    const op: Op = { id, sig, ...base };
    this.ops.set(id, op);
    return op;
  }

  post(p: { channel: string; title: string; body: string; kind?: string; reply_to?: string | null }, ts: string): Op {
    const kind = p.kind ?? "status";
    const status = ACTIONABLE.has(kind) ? "draft" : "published"; // automate status, gate actions
    return this.emit("post", { ...p, kind, status }, ts);
  }
  publish(targetId: string, ts: string): Op { return this.emit("publish", { target: targetId }, ts); }
  ack(targetId: string, ts: string): Op { return this.emit("ack", { target: targetId }, ts); }

  /** Presence/profile op — every op already carries our pubkey + encPub, so emitting one
   *  presence op lets peers in a shared group learn our encryption key (→ become able to DM
   *  us) WITHOUT us posting content first. Filtered out of the message feed. */
  announce(ts: string, profile?: Record<string, unknown>): Op {
    return this.emit("post", { kind: "profile", channel: "_presence", title: this.name, body: "", ...profile }, ts);
  }

  /** Look up a peer's encryption key from any op we've seen from them. */
  encKeyOf(peerId: string): string | null {
    for (const op of this.ops.values()) if (op.author === peerId) return op.encPub;
    return null;
  }

  /** E2EE direct message: content sealed to the recipient; relays see only routing metadata.
   *  encPubOverride lets the caller supply the recipient's key (e.g. from a machine-shared
   *  contact) when we haven't synced an op from them yet. */
  sendDM(to: string, msg: { channel: string; title: string; body: string }, ts: string, encPubOverride?: string): Op {
    const encPub = encPubOverride ?? this.encKeyOf(to);
    if (!encPub) throw new Error(`[p2p] no encryption key known for ${to} — sync with them (or a relay) first`);
    const box = sealTo(encPub, JSON.stringify({ title: msg.title, body: msg.body }));
    return this.emit("post", { kind: "dm", channel: msg.channel, to, ...box, status: "published" }, ts);
  }

  /** Seal arbitrary text to a recipient's encryption key (for targeted invites). */
  sealForKey(recipientEncPubB64: string, plaintext: string): { ephPub: string; nonce: string; ct: string } {
    return sealTo(recipientEncPubB64, plaintext);
  }
  /** Open a sealed box addressed to us (returns null if it isn't / is tampered). */
  openSealedBox(box: { ephPub: string; nonce: string; ct: string }): string | null {
    return openSealed(this.encPriv, box);
  }

  /** Mark a DM read (human saw it) → signed read-receipt op. */
  markRead(messageId: string, ts: string): Op {
    return this.emit("ack", { target: messageId, receipt: "read" }, ts);
  }

  private tryOpenDM(op: Op): { title: string; body: string } | null {
    const p = op.payload as Record<string, string>;
    if (p.kind !== "dm" || p.to !== this.id) return null;
    const clear = openSealed(this.encPriv, { ephPub: p.ephPub, nonce: p.nonce, ct: p.ct });
    return clear ? (JSON.parse(clear) as { title: string; body: string }) : null;
  }

  export(): Op[] { return [...this.ops.values()]; }
  opCount(): number { return this.ops.size; }

  // CRDT merge: verify (drop forgeries), dedupe by id, advance the clock. When a DM
  // addressed to US arrives and decrypts, auto-emit a signed "delivered" receipt — it
  // gossips back to the sender on subsequent syncs.
  merge(incoming: Op[], nowTs?: string): { accepted: number; rejected: number; deliveredReceipts: number } {
    let accepted = 0, rejected = 0, deliveredReceipts = 0;
    for (const op of incoming) {
      if (this.ops.has(op.id)) continue;
      if (!verifyOp(op)) { rejected++; continue; }
      this.ops.set(op.id, op);
      this.lamport = Math.max(this.lamport, op.lamport);
      accepted++;
      const p = op.payload as Record<string, string>;
      if (p.kind === "dm" && p.to === this.id && this.tryOpenDM(op)) {
        const already = [...this.ops.values()].some(
          (o) => o.type === "ack" && o.author === this.id && (o.payload as Record<string, string>).target === op.id && (o.payload as Record<string, string>).receipt === "delivered"
        );
        if (!already) {
          this.emit("ack", { target: op.id, receipt: "delivered" }, nowTs ?? op.ts);
          deliveredReceipts++;
        }
      }
    }
    return { accepted, rejected, deliveredReceipts };
  }

  // Deterministic fold: identical op set ⇒ identical feed structure on every peer.
  // (DM content visibility differs per peer — only the recipient/sender can read it —
  // but ids/ordering/receipts are identical.)
  feed(): DerivedMessage[] {
    const ordered = [...this.ops.values()].sort((a, b) => a.lamport - b.lamport || a.id.localeCompare(b.id));
    const msgs = new Map<string, DerivedMessage>();
    for (const op of ordered) {
      if (op.type !== "post") continue;
      const p = op.payload as Record<string, string>;
      if (p.kind === "profile") continue; // presence carries keys, not a message
      if (p.kind === "dm") {
        const mine = p.to === this.id ? this.tryOpenDM(op) : null;
        const sentByMe = op.author === this.id;
        msgs.set(op.id, {
          id: op.id, channel: p.channel, from: op.author,
          title: mine ? mine.title : sentByMe ? "(dm you sent)" : "(encrypted dm)",
          body: mine ? mine.body : "",
          kind: "dm", status: "published", reply_to: null,
          lamport: op.lamport, ts: op.ts, acks: [],
          dm: { to: p.to, canRead: !!mine || sentByMe },
          receipts: [],
        });
      } else {
        msgs.set(op.id, {
          id: op.id, channel: p.channel, from: op.author, title: p.title, body: p.body,
          kind: p.kind, status: p.status as "draft" | "published", reply_to: (p.reply_to as string) ?? null,
          lamport: op.lamport, ts: op.ts, acks: [], dm: null, receipts: [],
        });
      }
    }
    for (const op of ordered) {
      const p = op.payload as Record<string, string>;
      if (!p.target || !msgs.has(p.target)) continue;
      const m = msgs.get(p.target)!;
      if (op.type === "publish" && m.from === op.author) m.status = "published";
      if (op.type === "ack") {
        if (p.receipt === "delivered" || p.receipt === "read") {
          if (!m.receipts.some((r) => r.by === op.author && r.kind === p.receipt)) {
            m.receipts.push({ by: op.author, kind: p.receipt as Receipt["kind"] });
          }
        } else if (!m.acks.includes(op.author)) {
          m.acks.push(op.author);
        }
      }
    }
    return [...msgs.values()].sort((a, b) => a.lamport - b.lamport || a.id.localeCompare(b.id));
  }
}
