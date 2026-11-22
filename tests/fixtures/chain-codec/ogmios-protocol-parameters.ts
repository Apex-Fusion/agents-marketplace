/**
 * The Ogmios answer to `queryLedgerState/protocolParameters` that the Ogmios providers and the Lucid context read when they start.
 * The values are those of a Cardano network. Each call returns a new object, so that a test can change a field.
 */
export function makeOgmiosProtocolParams() {
  return {
    minFeeCoefficient: 44,
    minFeeConstant: { ada: { lovelace: 155381 } },
    maxTransactionSize: { bytes: 16384 },
    maxValueSize: { bytes: 5000 },
    stakeCredentialDeposit: { ada: { lovelace: 2000000 } },
    stakePoolDeposit: { ada: { lovelace: 500000000 } },
    monetaryExpansion: "0.003",
    treasuryExpansion: "0.2",
    minStakePoolCost: { ada: { lovelace: 340000000 } },
    prices: { memory: "0.0577", steps: "0.0000721" },
    maxExecutionUnitsPerTransaction: { memory: 14000000, cpu: 10000000000 },
    coinsPerUtxoByte: { ada: { lovelace: 4310 } },
    collateralPercentage: 150,
    maxCollateralInputs: 3,
    plutusCostModels: {
      "plutus:v1": {},
      "plutus:v2": {},
      "plutus:v3": {},
    },
    minFeeReferenceScripts: { base: 15 },
    governanceActionDeposit: { ada: { lovelace: 100000000000 } },
    delegateRepresentativeDeposit: { ada: { lovelace: 500000000 } },
  };
}
