// Minimal typings — hyperswarm ships no TS types.
declare module "hyperswarm" {
  import type { Duplex } from "node:stream";
  export default class Hyperswarm {
    constructor(opts?: Record<string, unknown>);
    join(topic: Buffer, opts?: { server?: boolean; client?: boolean }): { flushed(): Promise<void> };
    flush(): Promise<void>;
    on(event: "connection", cb: (conn: Duplex, info: unknown) => void): this;
    connections: Set<Duplex>;
    destroy(): Promise<void>;
  }
}

declare module "hyperdht/testnet" {
  interface Testnet {
    bootstrap: Array<{ host: string; port: number }>;
    destroy(): Promise<void>;
  }
  export default function createTestnet(size?: number): Promise<Testnet>;
}
