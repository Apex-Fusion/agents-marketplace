// The chain data the resolver needs, independent of where it comes from. Hashes and asset names are
// lowercase hex; quantities are bigint; times are POSIX seconds.

export interface Asset {
  policyId: string;
  assetName: string;
  quantity: bigint;
}

export interface ChainTip {
  blockHeight: number;
  blockHash: string;
  slot: number;
}

export interface UnspentOutput {
  txHash: string;
  outputIndex: number;
  address: string;
  assets: Asset[];
  /** The datum bytes (inline, or resolved from the datum hash); null if the source cannot provide them. */
  datumHex: string | null;
}

export interface TxInput {
  txHash: string;
  outputIndex: number;
  address: string;
  assets: Asset[];
}

export interface TxOutput {
  outputIndex: number;
  address: string;
  assets: Asset[];
}

export interface LedgerTx {
  txHash: string;
  blockHash: string;
  blockHeight: number;
  /** Position of the transaction in its block. */
  blockIndex: number;
  slot: number;
  blockTime: number;
  inputs: TxInput[];
  outputs: TxOutput[];
  /** Minted (positive) and burned (negative) quantities. */
  mint: Asset[];
}

/** A transaction located by height only (for example from a credential index). */
export interface TxPointer {
  txHash: string;
  blockHeight: number;
}

export interface TxWitnesses {
  txHash: string;
  /** Ed25519 public keys (32 bytes, hex) of the vkey witnesses. Bootstrap (Byron) witnesses are excluded. */
  vkeys: string[];
}

export interface ChainSource {
  /** The current tip of the selected chain. */
  tip(): Promise<ChainTip>;
  /** Unspent outputs holding at least one unit of the asset, at any address. */
  utxosWithAsset(policyId: string, assetName: string): Promise<UnspentOutput[]>;
  /** Every transaction that minted, burned, spent or produced the asset. */
  assetTxHashes(policyId: string, assetName: string): Promise<string[]>;
  /** Full transactions; the result has one entry per requested hash, in any order. */
  transactions(txHashes: string[]): Promise<LedgerTx[]>;
  /** Transactions that spend from or pay to an address whose payment credential is this key hash. */
  paymentCredentialTxs(keyHash: string): Promise<TxPointer[]>;
  /** The vkey witnesses of every transaction in the block at this height, in block order. */
  blockWitnesses(blockHeight: number): Promise<TxWitnesses[]>;
}
