# Escrow and advert tests (slice W2-ESC)

Scope: Part 2 §6.1 (new escrow), §6.2 (new advert), §12.1 rows "Escrow" and "Other purposes", and the Claim and Submit cases of §12.4 (`docs/IDENTITY_REGISTRY.md`).

Run: `cd contracts/identity-marketplace && aiken check -D`.

| Module | Content | Tests |
|---|---|---|
| `lib/identity_marketplace/escrow/rules.ak` | The escrow rules. The validator calls `spend`. | 0 |
| `lib/identity_marketplace/escrow/fixtures.ak` | Test data. A `Case` is a datum, a redeemer and a transaction that pass. | 0 |
| `lib/identity_marketplace/escrow/ported_tests.ak` | The 17 legacy escrow tests, ported. | 17 |
| `lib/identity_marketplace/escrow/rule_tests.ak` | Positive controls and the §12.1 escrow attacks. | 108 |
| `validators/escrow.ak` | Validator wiring, other purposes, §12.4 benchmark. | 10 |
| `lib/identity_marketplace/advert/rules.ak` | The advert rules, the 9 legacy advert tests (ported) and 7 new tests. | 16 |
| `validators/advert.ak` | Validator wiring and other purposes. | 7 |

Each attack test changes one part of a passing case. A test that asserts `!run(...)` (or `!update(...)`, `!retire(...)`) passes only when the rules return `False`. A `fail` test is used only where the rule stops the script: the validity window, a missing datum, the advert's continuing output, and the `else` handlers. For each `fail` test, the trace shows the intended `expect` (for example `hi - lo <= max_range_ms`).

## §12.1 "Escrow" row

| Attack (must fail) | Tests |
|---|---|
| Two escrow inputs | `two_escrow_inputs_rejected` (every redeemer; a second input at the escrow address, and one at the escrow script with a stake credential) |
| A legacy escrow input | `legacy_escrow_input_rejected` (every redeemer) |
| Any second script input | `second_script_input_rejected` (every redeemer; the identity script, and another script with a stake credential) |
| A mint, withdrawal or certificate | `mint_rejected`, `withdrawal_rejected`, `certificate_rejected`; rule 2 also: `vote_rejected`, `proposal_rejected` (every redeemer) |
| Claim with an unlisted key | `claim_rejects_unlisted_key` |
| Claim with a key without the transaction purpose | `claim_rejects_key_without_transaction_purpose` |
| Claim with a controller-only key | `claim_rejects_controller_only_key` (control: `claim_with_listed_controller_key`) |
| Claim with no capability | `claim_rejects_missing_capability` |
| Claim by a subagent | `claim_rejects_subagent` (the test also shows that the subagent is Active) |
| Claim by a suspended or unaccountable agent | `claim_rejects_suspended_agent`, `claim_rejects_unaccountable_agent` (no Accountable Party; a party that ends before `hi`; a party that starts after `lo`); also `claim_rejects_revoked_or_retired_agent` (control: `claim_with_ended_hold`) |
| Claim with a record at a wrong address | `claim_rejects_record_at_wrong_address` (identity script with a stake credential, another script, a key address) |
| Claim with a record with a fake token | `claim_rejects_record_with_fake_token` (a token of another policy, no token) |
| Claim with the record of another agent | `claim_rejects_record_of_another_agent`; also `claim_rejects_missing_record` |
| Claim above the cap | `claim_rejects_value_above_cap`, `claim_rejects_input_above_cap`, `claim_rejects_negative_amount` (control: `claim_at_value_cap`) |
| Claim or Submit with a range over one hour | `claim_rejects_range_over_one_hour`, `submit_rejects_range_over_one_hour`; rule 3 for the other redeemers: `accept_rejects_range_over_one_hour`, `reclaim_rejects_range_over_one_hour`, `reclaim_with_refund_rejects_range_over_one_hour`, `release_rejects_range_over_one_hour`, `refund_revoked_rejects_range_over_one_hour`; unbounded ranges: `claim_rejects_unbounded_lower_bound`, `submit_rejects_unbounded_upper_bound`, `reclaim_rejects_unbounded_upper_bound` (control: `claim_with_one_hour_range`) |
| A continuing escrow output with a stake credential | `claim_rejects_continuing_output_with_stake_credential`, `submit_rejects_continuing_output_with_stake_credential`; also `claim_rejects_two_continuing_outputs`, `claim_rejects_missing_continuing_output`, `claim_rejects_changed_value`, `claim_rejects_continuing_datum_not_inline`, `claim_rejects_continuing_output_with_reference_script` |
| Submit after key removal, suspension or revocation | `submit_rejects_after_key_removal`, `submit_rejects_after_suspension`, `submit_rejects_after_revocation`; also `submit_rejects_after_retirement`, `submit_rejects_unaccountable_agent`, `submit_rejects_key_without_transaction_purpose`, `submit_rejects_subagent`, `submit_rejects_missing_record` |
| A changed `agent_id` or `refund` | `claim_rejects_changed_agent_id`, `claim_rejects_changed_refund`, `submit_rejects_changed_agent_id`, `submit_rejects_changed_refund`; also `claim_rejects_other_field_change`, `submit_rejects_submitted_at_other_than_hi`, `submit_rejects_receipt_other_than_redeemer` |
| A buyer payout to a wrong refund address or with a wrong datum | `accept_with_refund_rejects_payout_to_buyer_key`, `accept_with_refund_rejects_wrong_datum`, `accept_with_buyer_refund_rejects_datum_or_stake`, `reclaim_with_refund_rejects_wrong_address`, `reclaim_with_refund_rejects_wrong_datum`, `refund_revoked_rejects_wrong_refund_address_or_datum` |
| Reclaim with a refund address and less than a full refund | `reclaim_with_refund_rejects_less_than_full_refund` (the escrow input holds 1.5 AP3X above payment + bonds) |
| RefundRevoked against a live agent | `refund_revoked_rejects_active_agent`, `refund_revoked_rejects_suspended_agent` (a hold in force; no Accountable Party); also `refund_revoked_rejects_missing_record`, `refund_revoked_rejects_record_of_another_agent`, `refund_revoked_rejects_record_at_wrong_address`, `refund_revoked_rejects_terminal_states` |
| RefundRevoked of a Submitted escrow without an "invalid from" time at or before `submitted_at` | `refund_revoked_submitted_rejects_no_invalid_from`, `refund_revoked_submitted_rejects_invalid_from_after_submission`, `refund_revoked_submitted_rejects_retired_agent` (control: `refund_revoked_submitted_invalid_from_at_submission`) |
| RefundRevoked with less than a full refund or to a buyer address with a stake credential | `refund_revoked_rejects_less_than_full_refund`, `refund_revoked_rejects_staked_buyer_address` |
| Each payout below its due amount | Accept: `accept_rejects_supplier_shorted`, `accept_rejects_buyer_shorted` (ported), `accept_with_refund_rejects_buyer_shorted`. Reclaim: `reclaim_rejects_buyer_shorted`, `reclaim_with_refund_rejects_less_than_full_refund`. Release: `release_rejects_supplier_shorted`. RefundRevoked: `refund_revoked_rejects_less_than_full_refund` |

Rule checks that are kept from the legacy escrow have the ported tests (signers, states, deadlines, receipt hash) and `reclaim_without_refund_needs_buyer_signature`, `accept_with_refund_needs_buyer_signature`, `reclaim_rejects_submitted_escrow`, `release_rejects_non_supplier`.

## §12.1 "Other purposes" row

| Script | Tests (each must fail) |
|---|---|
| `escrow` | `escrow_fails_as_withdraw`, `escrow_fails_as_publish`, `escrow_fails_as_vote`, `escrow_fails_as_propose`, `escrow_fails_as_mint` |
| `advert` | `advert_fails_as_withdraw`, `advert_fails_as_publish`, `advert_fails_as_vote`, `advert_fails_as_propose`, `advert_fails_as_mint` |

## Positive controls

| Redeemer | Tests |
|---|---|
| All | `every_case_passes` (one case for each redeemer, and Reclaim with a refund address), `escrow_spend_runs_the_rules`, `escrow_spend_reads_records_of_the_parameter` |
| Claim | `claim_happy_path`, `claim_with_one_hour_range`, `claim_at_value_cap`, `claim_keeps_refund`, `claim_with_listed_controller_key`, `claim_with_ended_hold`, `claim_with_largest_record`, `bench_claim_largest_record` |
| Submit | `submit_happy_path`, `submit_keeps_refund`, `submit_skips_capability_and_value_checks`, `submit_with_largest_record`, `bench_submit_largest_record` |
| Accept | `accept_happy_path`, `accept_with_buyer_refund_address`, `accept_with_vault_refund` |
| Reclaim | `reclaim_from_open_happy_path`, `reclaim_from_claimed_happy_path`, `reclaim_without_refund_keeps_legacy_amount`, `reclaim_with_refund_without_any_signature`, `reclaim_with_refund_returns_input_ap3x` |
| Release | `release_happy_path`, `release_with_refund_set`, `release_does_not_read_registry` |
| RefundRevoked | `refund_revoked_open_escrow_of_revoked_agent`, `refund_revoked_open_escrow_of_retired_agent`, `refund_revoked_claimed_escrow_of_revoked_agent`, `refund_revoked_claimed_escrow_of_retired_agent`, `refund_revoked_submitted_invalid_from_at_submission`, `refund_revoked_submitted_invalid_from_before_submission`, `refund_revoked_after_deliver_by`, `refund_revoked_to_vault_refund`, `refund_revoked_to_buyer_refund_address`, `refund_allowed_by_state_and_status` |
| UpdateAdvert | `update_advert_happy_path`, `update_advert_active_to_retired_allowed`, `update_advert_keeps_agent_id_with_other_changes`, `advert_spend_runs_the_rules` |
| RetireAdvert | `retire_advert_happy_path`, `advert_spend_runs_the_rules` |

Other checks: `escrow_spend_without_datum_fails` (a spend without a datum fails) and `fixtures_match_constants` (the test data agrees with the constants of `rule_tests`).

## §6.2 advert rules

| Rule | Tests |
|---|---|
| The supplier key signs UpdateAdvert | `update_advert_rejects_unsigned` |
| `supplier_pkh` stays | `update_advert_rejects_different_supplier` |
| `advertised_at` does not go down | `update_advert_rejects_timestamp_regress` |
| UpdateAdvert keeps `agent_id` | `update_advert_rejects_changed_agent_id` (control: `update_advert_keeps_agent_id_with_other_changes`) |
| Exactly one continuing output, with an inline datum that decodes as the new `AdvertDatum` | `update_advert_rejects_two_continuing_outputs`, `update_advert_rejects_missing_continuing_output`, `update_advert_rejects_datum_hash`, `update_advert_rejects_legacy_layout` |
| The supplier key signs RetireAdvert | `retire_advert_rejects_unsigned` |
| RetireAdvert pays the supplier key | `retire_advert_rejects_payment_to_wrong_address` |
| PostAdvert runs no spend | `post_advert_spend_rejected`, `post_advert_shape_is_well_formed` |
| The validator calls the rules | `advert_spend_runs_the_rules`, `advert_spend_without_datum_fails` |
| The contract does not check identity | No identity input is read: the advert tests have no reference inputs. |

## Ported legacy tests

All 17 escrow tests keep their names, amounts and times, and no test changes its expectation. These parts changed in every test:

- The datum has `agent_id` and `refund = None`.
- `supplier_pkh` is the key hash of an Ed25519 key that the agent's record lists with the transaction purpose. The legacy test values for `buyer_pkh` and `supplier_pkh` had 29 bytes; the new values have 28 bytes.
- The transaction holds the escrow input, because rule 1 counts script inputs. Claim and Submit read the agent's record as a reference input.
- Each test runs every rule of §6.1 (`rules.spend`), not only the rule of one redeemer.
- An adversarial test asserts `False` (`!spend(...)`). The legacy test was a `fail` test with `expect`, which also passes when the script crashes for another reason.

| Legacy test | Expectation | Notes |
|---|---|---|
| `claim_happy_path` | pass | Needs the record as a reference input. |
| `submit_happy_path` | pass | Needs the record as a reference input. `submitted_at` is the upper bound. |
| `accept_happy_path` | pass | |
| `reclaim_from_open_happy_path` | pass | The range must be finite now (rule 3); the legacy range is. |
| `reclaim_from_claimed_happy_path` | pass | As above. |
| `release_happy_path` | pass | |
| `claim_rejects_non_supplier` | reject | |
| `claim_rejects_after_deliver_by` | reject | |
| `submit_rejects_no_receipt_hash` | reject | The continuing datum must equal the expected datum. |
| `submit_rejects_short_receipt_hash` | reject | |
| `submit_rejects_double_submit` | reject | |
| `accept_rejects_non_buyer` | reject | |
| `accept_rejects_after_window` | reject | |
| `accept_rejects_supplier_shorted` | reject | |
| `accept_rejects_buyer_shorted` | reject | |
| `reclaim_rejects_before_deliver_by` | reject | |
| `release_rejects_before_window` | reject | |

The 9 legacy advert tests keep their names and expectations in `lib/identity_marketplace/advert/rules.ak`. The datum has `agent_id`, and the adversarial tests assert `False`.

One legacy behaviour changes, but no ported test covers it: the legacy Reclaim accepted an unbounded upper bound of the validity range. Rule 3 now applies to every redeemer (`reclaim_rejects_unbounded_upper_bound`).

## §12.4 benchmark: Claim and Submit with the largest record

The largest record has 8 keys (7 P-256 keys with `pop`, then the supplier's Ed25519 key), 8 parties (each with a 64-byte organisation and both optional times; the Accountable Party comes last), 10 ended holds, 16 capabilities of 64 bytes (the escrow's capability comes last), a 64-byte name, a 256-byte description, a 64-byte framework, a 256-byte endpoint and a pending recovery. The transaction has 3 inputs (the escrow and 2 wallet inputs), 4 reference inputs (the record comes last, after another agent's largest record) and 2 outputs. The case is a module constant, so the measured units are those of the validator handler, without the cost of the test data.

| Test | Memory | CPU | Share of the limits (16,000,000 memory, 10,000,000,000 CPU) |
|---|---|---|---|
| `bench_claim_largest_record` | 1.72 M | 542.89 M | 10.8 %, 5.4 % |
| `bench_submit_largest_record` | 1.65 M | 519.70 M | 10.3 %, 5.2 % |

The units come from `aiken check` (Aiken v1.1.21). They do not include the decoding of the script context, datum and redeemer, which the ledger adds. The compiled scripts (`aiken build`, parameter not applied) have 5,880 bytes (escrow) and 1,024 bytes (advert). The legacy scripts have 3,442 and 1,036 bytes.

## Decisions

1. **RefundRevoked reads the record's own status.** "R is Revoked or Retired" means that the status of the record is `Revoked` or `Retired` (a tombstone). It does not mean the effective status. Claim and Submit need an independent record, and the lineage never changes. Thus a Claimed or Submitted escrow always has a root record, and for a root record the two readings are the same. They differ only for an Open escrow whose `agent_id` names a subagent. Nobody can claim such an escrow, and the buyer gets the funds back by Reclaim after `deliver_by`. This reading also needs no ancestor records.
2. **The amounts of a Claim are not negative.** Claim also requires payment, buyer bond and supplier bond each to be at least 0. Without this check, a negative bond lets the sum stay at the cap while the payment is above it.
3. **One output with the escrow script's payment credential.** Claim and Submit require exactly one output whose payment credential is the escrow script, with any stake credential. That output must have no stake credential (so it is at the exact escrow address), the value of the escrow input, no reference script, and an inline datum that is equal to the expected datum. The legacy escrow also counted the payment credential. The reference-script rule stops a supplier from raising the cost of the later spends (Accept, Reclaim, RefundRevoked). Builders never add a reference script to an escrow output.
4. **Rule 3 for every redeemer.** Every redeemer needs a finite range of at most one hour. Accept, Reclaim and Release keep the legacy timing functions (`before_or_at`, `after_or_at`), with the legacy handling of inclusive and exclusive bounds. The window is computed before the redeemer branches. The compiler moves a value that is used only once into the branch that uses it, and then the window check would not run for the other redeemers.
5. **RefundRevoked without a refund address** counts outputs at the enterprise address of `buyer_pkh` with any datum. The rule names only the address. The buyer key can spend such an output whatever its datum.
6. **Payouts count AP3X only** (rules 4 to 6, as written). Builders lock AP3X only (§5.3, §6.5).
7. **No record, no Claim, Submit or RefundRevoked.** When `find_record` finds no record, these redeemers return `False`. A record datum that does not decode stops the script (`find_record`).
8. **Accept with a refund address** still needs the buyer key's signature (legacy rule). The buyer bond goes to the refund address.
9. **The advert keeps the legacy output rule.** UpdateAdvert finds its continuing output by the payment credential, with any stake credential, as the legacy advert does (§6.2: "the contract rules stay as today"). Only the supplier can update an advert, and the advert holds only the supplier's deposit.
