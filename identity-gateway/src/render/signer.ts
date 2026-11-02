// The gateway key that signs A2A agent cards (Part 2 Section 8.2: the Ed25519 key signs agent cards).
// The key loader of the M4 services provides it; the renderings only need this interface.

export interface Ed25519Signer {
  /**
   * The `kid` of this key in the gateway's JWK set (GET /.well-known/jwks.json). The JWS protected
   * header names it, and its `jku` points to that set. When it is a DID URL of the gateway's
   * did:vector DID, the AI Catalog names that DID as its host.
   */
  readonly kid: string;
  /** The raw Ed25519 signature (64 bytes) over `data`. */
  sign(data: Uint8Array): Promise<Uint8Array>;
}
