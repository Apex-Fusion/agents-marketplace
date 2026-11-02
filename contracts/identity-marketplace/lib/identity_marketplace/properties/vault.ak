//// Property test of Part 2 §12.3 for the vault contract (§5.3): no vault
//// action lets the delegate spend a `Returned` output.
////
//// The vault belongs to the principal of the depth-1 chain or to agent 3,
//// the delegator of link 4 of the depth-4 chain whose root delegator is agent
//// 0 (`delegation/fixtures`). Agent 4 is the delegate: its delegation key
//// signs. The fuzzer adds random other signers that are not the owner (agent
//// 4's controller and transaction key, a stranger, agent 3's listed keys,
//// and the principal or agent 3's controller, whichever is not the owner),
//// random AP3X and an output that pays the delegate or a new escrow. All
//// records and delegations of the chain are reference inputs.

use aiken/collection/list
use aiken/fuzz
use cardano/address.{Address}
use cardano/assets
use cardano/transaction.{
  InlineDatum, Input, NoDatum, Output, OutputReference, Transaction,
}
use identity_marketplace/delegation/fixtures.{
  agent_delegator, agent_id, ap3x, chain_refs, controller_key, delegation_hash,
  delegation_key, escrow_hash, hash, hi, identity_hash, now, principal,
  principal_delegator, seed, stranger, transaction_key, vault_hash, wallet_input,
}
use identity_marketplace/types.{
  Close, Delegator, EscrowDatum, Open, Pay, PrincipalKey, Refund, Returned,
  VaultSpend,
}
use identity_marketplace/vault/handlers.{vault_spend}
use vector_identity.{days_7_ms}

/// A spend of a `Returned` vault output of `owner` that holds `funds`.
type ReturnedSpend {
  owner: Delegator,
  redeemer: VaultSpend,
  signers: List<ByteArray>,
  outputs: List<Output>,
  funds: Int,
}

fn vault_address() -> Address {
  address.from_script(vault_hash)
}

fn vault_ref() -> OutputReference {
  OutputReference {
    transaction_id: #"5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a",
    output_index: 0,
  }
}

/// The key that the delegate signs with: agent 4's delegation key.
fn delegate_key_hash() -> ByteArray {
  hash(delegation_key(4))
}

/// The key that makes `owner` sign: the principal key, or agent 3's
/// controller.
fn owner_key(owner: Delegator) -> ByteArray {
  when owner is {
    PrincipalKey { hash: key, .. } -> key
    _ -> hash(controller_key(3))
  }
}

/// Keys that are not the owner's.
fn other_keys(owner: Delegator) -> List<ByteArray> {
  let not_owner =
    when owner is {
      PrincipalKey { .. } -> hash(controller_key(3))
      _ -> principal
    }
  [
    hash(controller_key(4)),
    hash(transaction_key(4)),
    stranger,
    hash(delegation_key(3)),
    hash(transaction_key(3)),
    not_owner,
  ]
}

/// A new escrow as a vault payment writes it, with the vault refund.
fn escrow_output(owner: Delegator, amount: Int) -> Output {
  let returned: Data = Returned { owner }
  Output {
    address: address.from_script(escrow_hash),
    value: assets.from_lovelace(amount),
    datum: InlineDatum(
      EscrowDatum {
        buyer_pkh: delegate_key_hash(),
        supplier_pkh: #"5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b",
        advert_ref: OutputReference {
          transaction_id: #"adadadadadadadadadadadadadadadadadadadadadadadadadadadadadadadad",
          output_index: 0,
        },
        capability_id: "ocr.extract.v1",
        request_spec_hash: #"1111111111111111111111111111111111111111111111111111111111111111",
        prompt_hash: #"2222222222222222222222222222222222222222222222222222222222222222",
        payment_lovelace: amount - 2 * ap3x,
        buyer_bond_lovelace: ap3x,
        supplier_bond_lovelace: ap3x,
        deliver_by: hi + days_7_ms,
        posted_at: hi,
        submitted_at: None,
        result_receipt_hash: None,
        state: Open,
        agent_id: agent_id(9),
        refund: Some(Refund { address: vault_address(), datum: Some(returned) }),
      },
    ),
    reference_script: None,
  }
}

/// An output of `amount` to the delegate key.
fn delegate_payout(amount: Int) -> Output {
  Output {
    address: address.from_verification_key(delegate_key_hash()),
    value: assets.from_lovelace(amount),
    datum: NoDatum,
    reference_script: None,
  }
}

fn returned_spend() -> Fuzzer<ReturnedSpend> {
  let agent_owner <- fuzz.and_then(fuzz.bool())
  let owner =
    if agent_owner {
      agent_delegator(3)
    } else {
      principal_delegator()
    }
  let pay <- fuzz.and_then(fuzz.bool())
  let others <- fuzz.and_then(fuzz.sublist(other_keys(owner)))
  let funds <- fuzz.and_then(fuzz.int_between(2 * ap3x, 1_000 * ap3x))
  let taken <- fuzz.and_then(fuzz.int_between(2 * ap3x, funds))
  let to_escrow <- fuzz.map(fuzz.bool())
  ReturnedSpend {
    owner,
    redeemer: if pay {
      Pay
    } else {
      Close
    },
    signers: [delegate_key_hash(), ..others],
    outputs: [
      if to_escrow {
        escrow_output(owner, taken)
      } else {
        delegate_payout(taken)
      },
    ],
    funds,
  }
}

/// The vault handler on the spend, with `signers` as the required signers.
fn spends(
  r: ReturnedSpend,
  redeemer: VaultSpend,
  signers: List<ByteArray>,
) -> Bool {
  let returned = Returned { owner: r.owner }
  let tx =
    Transaction {
      ..transaction.placeholder,
      inputs: [
        wallet_input(seed()),
        Input {
          output_reference: vault_ref(),
          output: Output {
            address: vault_address(),
            value: assets.from_lovelace(r.funds),
            datum: InlineDatum(returned),
            reference_script: None,
          },
        },
      ],
      reference_inputs: chain_refs(4, agent_delegator(0)),
      outputs: r.outputs,
      extra_signatories: signers,
      validity_range: now(),
    }
  vault_spend(
    identity_hash,
    delegation_hash,
    escrow_hash,
    returned,
    redeemer,
    vault_ref(),
    tx,
  )
}

fn label_spend(r: ReturnedSpend) -> Void {
  fuzz.label(
    when (r.owner, r.redeemer) is {
      (PrincipalKey { .. }, Pay) -> @"principal vault, Pay"
      (PrincipalKey { .. }, Close) -> @"principal vault, Close"
      (_, Pay) -> @"agent vault, Pay"
      (_, Close) -> @"agent vault, Close"
    },
  )
}

/// Part 2 §12.3: the delegate, also with other keys that are not the owner's,
/// cannot spend a `Returned` output with `Pay` or `Close`.
test prop_returned_vault_never_spendable_by_delegate(
  r via returned_spend(),
) fail {
  label_spend(r)
  spends(r, r.redeemer, r.signers)
}

/// The positive control: the owner closes the same `Returned` output.
test prop_returned_vault_closes_by_owner(r via returned_spend()) {
  label_spend(r)
  and {
    spends(r, Close, [owner_key(r.owner), ..r.signers]),
    !list.has(r.signers, owner_key(r.owner)),
  }
}
