//// The new advert contract: Part 2 §6.2 of `docs/IDENTITY_REGISTRY.md`.
////
//// No parameters. Purpose: spend. Every other purpose fails.
////
//// The rules are in `identity_marketplace/advert/rules`. This file only
//// connects them to the validator.

use cardano/address.{Address, Script, VerificationKey}
use cardano/assets
use cardano/certificate
use cardano/governance
use cardano/script_context.{
  Minting, Proposing, Publishing, ScriptContext, ScriptInfo, Voting, Withdrawing,
}
use cardano/transaction.{
  InlineDatum, NoDatum, Output, OutputReference, Transaction,
}
use identity_marketplace/advert/rules
use identity_marketplace/types.{
  Active, AdvertDatum, AdvertRedeemer, RetireAdvert, UpdateAdvert,
}

validator advert {
  spend(
    datum: Option<AdvertDatum>,
    redeemer: AdvertRedeemer,
    own_ref: OutputReference,
    self: Transaction,
  ) {
    expect Some(advert_datum) = datum
    rules.spend(advert_datum, redeemer, own_ref, self)
  }

  else(_ctx: ScriptContext) {
    fail
  }
}

// ## Tests
//
// The rules have their tests in `identity_marketplace/advert/rules`. These
// tests call the validator: its wiring and the other purposes (§12.1 "Other
// purposes").

const script_hash: ByteArray =
  #"deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"

const supplier: ByteArray =
  #"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

fn sample_advert() -> AdvertDatum {
  AdvertDatum {
    supplier_pkh: supplier,
    capability_id: "llm.text.generate.v1",
    model: "qwen2.5:0.5b",
    max_output_tokens: 512,
    max_processing_ms: 60_000,
    price_lovelace: 1_000_000,
    supplier_bond_lovelace: 1_000_000,
    buyer_bond_lovelace: 1_000_000,
    endpoint_url: "https://supplier.example.com/v1",
    detail_uri: "ipfs://Qm...",
    detail_hash: #"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    advertised_at: 1_000_000,
    status: Active,
    agent_id: #"a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9",
  }
}

fn own() -> OutputReference {
  OutputReference {
    transaction_id: #"0000000000000000000000000000000000000000000000000000000000000000",
    output_index: 0,
  }
}

fn advert_output() -> Output {
  Output {
    address: Address {
      payment_credential: Script(script_hash),
      stake_credential: None,
    },
    value: assets.from_lovelace(2_000_000),
    datum: InlineDatum(sample_advert()),
    reference_script: None,
  }
}

fn update_tx() -> Transaction {
  Transaction {
    ..transaction.placeholder,
    inputs: [
      transaction.Input { output_reference: own(), output: advert_output() },
    ],
    outputs: [advert_output()],
    extra_signatories: [supplier],
  }
}

fn context(info: ScriptInfo) -> ScriptContext {
  ScriptContext { transaction: update_tx(), redeemer: UpdateAdvert, info }
}

test advert_spend_runs_the_rules() {
  let retire_tx =
    Transaction {
      ..update_tx(),
      outputs: [
        Output {
          address: Address {
            payment_credential: VerificationKey(supplier),
            stake_credential: None,
          },
          value: assets.from_lovelace(2_000_000),
          datum: NoDatum,
          reference_script: None,
        },
      ],
    }
  and {
    advert.spend(Some(sample_advert()), UpdateAdvert, own(), update_tx()),
    advert.spend(Some(sample_advert()), RetireAdvert, own(), retire_tx),
    !advert.spend(
      Some(sample_advert()),
      UpdateAdvert,
      own(),
      Transaction { ..update_tx(), extra_signatories: [] },
    ),
  }
}

test advert_spend_without_datum_fails() fail {
  advert.spend(None, UpdateAdvert, own(), update_tx())
}

test advert_fails_as_withdraw() fail {
  advert.else(context(Withdrawing(Script(script_hash))))
}

test advert_fails_as_publish() fail {
  advert.else(
    context(
      Publishing {
        at: 0,
        certificate: certificate.UpdateDelegateRepresentative {
          delegate_representative: Script(script_hash),
        },
      },
    ),
  )
}

test advert_fails_as_vote() fail {
  advert.else(
    context(Voting(governance.DelegateRepresentative(Script(script_hash)))),
  )
}

test advert_fails_as_propose() fail {
  advert.else(
    context(
      Proposing {
        at: 0,
        proposal_procedure: governance.ProposalProcedure {
          deposit: 100_000_000_000,
          return_address: Script(script_hash),
          governance_action: governance.NicePoll,
        },
      },
    ),
  )
}

test advert_fails_as_mint() fail {
  advert.else(context(Minting(script_hash)))
}
