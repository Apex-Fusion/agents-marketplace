// The ledger data the resolver needs, independent of where it comes from. Hashes, asset names and
// datums are lowercase hex; quantities are bigint. Every method reads the selected chain as the
// source sees it now; a failed or inconsistent read throws (the resolver answers INTERNAL_ERROR).

export interface Asset {
  readonly policyId: string;
  readonly assetName: string;
  readonly quantity: bigint;
}

export interface ChainTip {
  readonly blockHeight: number;
  readonly blockHash: string;
  readonly slot: number;
}

/** Shelley genesis values that identify the network (Part 1 Section 4). */
export interface GenesisParameters {
  readonly networkMagic: number;
  /** POSIX seconds. */
  readonly systemStart: number;
  /** Seconds. */
  readonly slotLength: number;
  readonly securityParam: number;
}

export interface TxInput {
  /** The spent output reference. */
  readonly txHash: string;
  readonly outputIndex: number;
  readonly address: string;
  readonly assets: readonly Asset[];
}

export interface TxOutput {
  readonly outputIndex: number;
  /** Bech32 address. Two outputs are at the same address only when these strings are equal. */
  readonly address: string;
  readonly lovelace: bigint;
  readonly assets: readonly Asset[];
  /** CBOR of the inline datum; null when the output has no inline datum. */
  readonly inlineDatum: string | null;
  /** Hash of the datum (inline or by hash); null when the output has no datum. */
  readonly datumHash: string | null;
  readonly hasReferenceScript: boolean;
}

export interface LedgerTx {
  readonly txHash: string;
  readonly blockHash: string;
  readonly blockHeight: number;
  /** Position of the transaction in its block. */
  readonly txIndex: number;
  readonly slot: number;
  readonly inputs: readonly TxInput[];
  readonly outputs: readonly TxOutput[];
  /** Minted (positive) and burned (negative) quantities. */
  readonly mint: readonly Asset[];
}

export interface TxWitnesses {
  readonly txHash: string;
  /** Ed25519 public keys (32 bytes, hex) of the vkey witnesses. Bootstrap witnesses are excluded. */
  readonly vkeys: readonly string[];
}

export interface BlockWitnesses {
  readonly blockHash: string;
  /** Every transaction of the block, in block order. */
  readonly transactions: readonly TxWitnesses[];
}

/** One asset of a policy, as the source's asset index lists it. */
export interface PolicyAsset {
  readonly assetName: string;
  /** Number of transactions that minted the asset. */
  readonly mintCount: number;
  /** The newest transaction that minted the asset (the only one when mintCount is 1). */
  readonly lastMintTx: string;
  /** Block time of the first mint, POSIX seconds; null when the source does not show it. */
  readonly createdAt: number | null;
}

/** A token: an asset name under a policy ID. */
export interface AssetId {
  readonly policyId: string;
  readonly assetName: string;
}

/** The key of an asset in `assetHolders` results: `<policy ID>.<asset name>`. */
export const assetKey = (asset: AssetId): string => `${asset.policyId}.${asset.assetName}`;

export interface ChainSource {
  /** The current tip of the selected chain. */
  tip(): Promise<ChainTip>;
  genesis(): Promise<GenesisParameters>;
  /** Every transaction that minted, burned or produced the asset, in any order. */
  assetTxHashes(policyId: string, assetName: string): Promise<string[]>;
  /** Full transactions; the result has one entry for each requested hash, in any order. */
  transactions(txHashes: readonly string[]): Promise<LedgerTx[]>;
  /** Datum CBOR for the hashes that the source knows (from witness sets or inline datums). */
  datums(datumHashes: readonly string[]): Promise<Map<string, string>>;
  /**
   * The vkey witnesses of every transaction in each block at these heights, in the same order. A
   * source reads all of them in one session where it can (Part 1 Section 9: the legacy key search
   * reads few sessions for a long history).
   */
  blockWitnesses(blockHeights: readonly number[]): Promise<BlockWitnesses[]>;
  /** Every asset that the policy ever minted. */
  policyAssets(policyId: string): Promise<PolicyAsset[]>;
  /**
   * The unspent outputs that hold each asset now, as `<transaction hash>#<output index>@<block
   * height>`, by `assetKey`; an asset that no output holds has no entry. One read serves many assets.
   */
  assetHolders(assets: readonly AssetId[]): Promise<Map<string, string[]>>;
}
