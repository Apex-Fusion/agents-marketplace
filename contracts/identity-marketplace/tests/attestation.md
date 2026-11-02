# Attestation contract tests

Specification: Part 2 §4.1 and §12.1 of [`docs/IDENTITY_REGISTRY.md`](../../../docs/IDENTITY_REGISTRY.md).

| Item | Path |
|---|---|
| Validator (wiring only) | `validators/attestation.ak` |
| Rules (pure handlers) | `lib/identity_marketplace/attestation/handlers.ak` |
| Test fixtures (test-only) | `lib/identity_marketplace/attestation/fixtures.ak` |
| Rule tests | `lib/identity_marketplace/attestation/tests.ak` |
| Wiring and purpose tests | `validators/attestation.ak` |

Run: `cd contracts/identity-marketplace && aiken check -D`. Only the attestation tests: `aiken check -D -m 'identity_marketplace/attestation/tests.{..}'` and `aiken check -D -m 'attestation.{..}'`.

Each negative test changes one thing in a transaction that passes. `!handler(...)` tests check that a rule returns `False`. `fail` tests check that the handler fails: an unbounded range, a range over one hour, a datum that does not decode, a missing ancestor record, or a spend without a datum.

## §12.1 "Attestation"

Each attack must fail.

| §12.1 item | Tests |
|---|---|
| No subject record | `attest_no_subject_record`, `attest_subject_record_with_stake_credential`, `contest_no_subject_record` |
| The issuer does not sign | `attest_issuer_not_signed`, `attest_registered_issuer_not_signed`, `revoke_att_unregistered_issuer_not_signed` |
| An `issuer_id` key without the assertion purpose | `attest_issuer_key_without_assertion`, `attest_issuer_key_not_listed`, `revoke_att_issuer_key_without_assertion` |
| RevokeAtt or Withdraw by a removed issuer key | `revoke_att_by_removed_issuer_key`, `withdraw_by_removed_issuer_key` |
| `solicited` without the subject's controller | `attest_solicited_without_subject_controller` |
| An output with a foreign asset, a reference script or a stake credential | `attest_output_foreign_asset`, `attest_output_reference_script`, `attest_output_stake_credential`, `attest_extra_output_at_script_with_stake_credential`, `revoke_att_output_foreign_asset`, `revoke_att_output_reference_script`, `revoke_att_output_stake_credential`, `contest_output_foreign_asset`, `contest_output_reference_script`, `contest_output_stake_credential` |
| A RevokeAtt or Contest that moves the token away from `AA` or lowers the value | `revoke_att_token_to_key_address`, `revoke_att_token_to_other_script`, `revoke_att_output_stake_credential`, `revoke_att_value_lowered`, `contest_token_to_key_address`, `contest_output_stake_credential`, `contest_value_lowered` |
| `issued_at ≠ hi` | `attest_issued_at_lo`, `attest_issued_at_after_hi` |
| `valid_until` before `issued_at` | `attest_valid_until_before_issued_at` |
| A reserved `att_type` | `attest_reserved_types` (−1, 6, 7, 14, 16, 255) |
| RevokeAtt by the subject | `revoke_att_by_subject` |
| Contest by the issuer | `contest_by_issuer` (issuer key), `contest_by_issuer_controller` |
| Withdraw before 90 days | `withdraw_revoked_before_90_days`, `withdraw_expired_before_90_days`, `withdraw_active_without_valid_until` |
| A burn of two attestations with one input | `withdraw_burn_of_two_tokens_with_one_input` (Withdraw and Burn both fail), `withdraw_two_inputs_one_burn`, `withdraw_two_inputs_two_burns` |

## §12.1 "Other purposes"

The attestation script used as withdraw, publish, vote or propose fails (§3.9). Tests in `validators/attestation.ak`: `purpose_withdraw_fails`, `purpose_publish_fails`, `purpose_vote_fails`, `purpose_propose_fails`.

## Rules for every action

A rule that holds for several actions has a test for each action. The tests that start with `mint_` or `spend_` are in `validators/attestation.ak` and go through the validator's redeemer dispatch. Every handler starts with the condition `lo <= hi`, so the window rule runs before any branch (see the module comment of `handlers.ak`). "—": the rule does not apply to the action.

| Rule | Attest | Burn | RevokeAtt | Contest | Withdraw |
|---|---|---|---|---|---|
| A range over one hour fails | `attest_range_over_one_hour`, `mint_attest_range_over_one_hour` | `burn_range_over_one_hour`, `mint_burn_range_over_one_hour` | `revoke_att_range_over_one_hour`, `spend_revoke_att_range_over_one_hour` | `contest_range_over_one_hour`, `spend_contest_range_over_one_hour` | `withdraw_range_over_one_hour`, `spend_withdraw_range_over_one_hour` |
| An infinite bound fails | `attest_unbounded_range` | `burn_unbounded_range` | `revoke_att_unbounded_range` | `contest_unbounded_range` | `withdraw_unbounded_range` |
| A second input at the attestation script fails | `attest_with_attestation_input`, `attest_with_script_input_with_stake_credential` | `withdraw_two_inputs_one_burn`, `withdraw_two_inputs_two_burns` | `revoke_att_two_attestation_inputs` | `contest_two_attestation_inputs` | `withdraw_two_inputs_one_burn`, `withdraw_two_inputs_two_burns` |
| A spent input that is not authentic fails (no token, or a stake credential) | — | `withdraw_input_without_token`, `withdraw_input_with_stake_credential`, `burn_without_attestation_input` | `revoke_att_input_without_token`, `revoke_att_input_with_stake_credential` | `contest_input_without_token`, `contest_input_with_stake_credential` | `withdraw_input_without_token`, `withdraw_input_with_stake_credential` |
| A second output at the attestation script fails | `attest_two_outputs_at_aa`, `attest_extra_output_at_script_with_stake_credential` | — | `revoke_att_two_outputs_at_aa` | `contest_two_outputs_at_aa` | — |
| The output datum is inline and is an attestation | `attest_datum_hash`, `attest_no_datum`, `attest_datum_not_attestation` | — | `revoke_att_output_datum_hash`, `revoke_att_datum_not_attestation` | `contest_output_datum_hash`, `contest_datum_not_attestation` | — |
| A spend without a datum fails | — | — | `spend_revoke_att_without_datum` | `spend_contest_without_datum` | `spend_withdraw_without_datum` |
| The mint of the attestation policy is as the action needs | `attest_quantity_two`, `attest_second_name`, `attest_name_not_from_seed` | `withdraw_burn_quantity_two`, `withdraw_burn_of_other_token`, `burn_with_positive_quantity` | `revoke_att_with_mint_of_own_policy` | `contest_with_burn_of_own_policy` | `withdraw_without_burn`, `withdraw_burn_of_other_token`, `withdraw_burn_quantity_two` |
| Value: enough AP3X, no other asset, no reference script | `attest_deposit_below_minimum`, `attest_output_foreign_asset`, `attest_output_reference_script` | — | `revoke_att_value_lowered`, `revoke_att_output_foreign_asset`, `revoke_att_output_reference_script` | `contest_value_lowered`, `contest_output_foreign_asset`, `contest_output_reference_script` | — |
| The output is exactly at `AA` | `attest_output_stake_credential`, `attest_token_outside_aa` | — | `revoke_att_output_stake_credential`, `revoke_att_token_to_key_address`, `revoke_att_token_to_other_script` | `contest_output_stake_credential`, `contest_token_to_key_address` | — |

## Other §4.1 rules

| Rule | Tests that must fail |
|---|---|
| Attest spends `seed` | `attest_seed_not_spent` |
| Attest: `AttActive` and `contested = None` | `attest_status_revoked`, `attest_contested_set` |
| Registered issuer: effective status Active | `attest_issuer_record_missing`, `attest_issuer_suspended`, `attest_issuer_unaccountable`, `attest_issuer_revoked`, `attest_issuer_parent_ended_subagents`, `attest_issuer_parent_missing` |
| `valid_until` at most 366 days after `issued_at`; types 2 and 3 require it; `valid_from` at or before it; valid times | `attest_valid_until_over_366_days`, `attest_software_without_valid_until`, `attest_environment_without_valid_until`, `attest_valid_from_after_valid_until`, `attest_valid_from_outside_time_range` |
| Lengths of the datum comments | `attest_byte_lengths`, `attest_five_links`, `attest_link_limits`, `attest_format_out_of_range` |
| RevokeAtt: `AttActive` to `AttRevoked { at: lo, reason }`, nothing else changes | `revoke_att_already_revoked`, `revoke_att_at_not_lo`, `revoke_att_reason_not_redeemer_reason`, `revoke_att_changes_other_field`, `revoke_att_reason_out_of_range` |
| Issuer authority | `revoke_att_issuer_record_missing`, `revoke_att_by_stranger`, `withdraw_issuer_record_missing`, `withdraw_by_subject` |
| Contest: only `contested` changes; `uri` 1–256 bytes, `sha256` 32 bytes | `contest_changes_status`, `contest_changes_other_field`, `contest_removes_anchor`, `contest_anchor_limits` |
| Burn appears only with Withdraw | `burn_with_other_spend_redeemer`, `burn_without_spend_redeemer` |

## Positive controls

| Action | Tests that must pass |
|---|---|
| Attest | `attest_registered_issuer`, `attest_unregistered_issuer`, `attest_via_handle_mint`, `attest_solicited_with_subject_controller`, `attest_subject_tombstone`, `attest_subject_suspended`, `attest_issuer_subagent_active`, `attest_allowed_types`, `attest_valid_until_optional_for_other_types`, `attest_valid_until_bounds`, `attest_valid_from_bounds`, `attest_limits_at_bounds`, `attest_deposit_above_minimum`, `attest_with_mint_of_other_policy`, `attest_range_one_hour`, `mint_attest` |
| RevokeAtt | `revoke_att_by_issuer_key`, `revoke_att_by_issuer_controller`, `revoke_att_via_handle_spend`, `revoke_att_unregistered_issuer`, `revoke_att_by_controller_after_key_removal`, `revoke_att_by_controller_of_issuer_tombstone`, `revoke_att_adds_ap3x`, `revoke_att_contested_attestation`, `revoke_att_reason_bounds`, `spend_revoke_att` |
| Contest | `contest_by_subject_controller`, `contest_via_handle_spend`, `contest_replaces_anchor`, `contest_revoked_attestation`, `contest_unregistered_issuer`, `contest_uri_bounds`, `contest_subject_tombstone`, `spend_contest` |
| Withdraw | `withdraw_after_revocation` (at `at + 90 days`), `withdraw_after_expiry` (at `valid_until + 90 days`), `withdraw_revoked_before_expiry`, `withdraw_via_handle_spend`, `withdraw_by_issuer_controller`, `withdraw_unregistered_issuer`, `spend_withdraw` |
| Burn | `burn_with_withdraw`, `burn_via_handle_mint`, `mint_burn` |
| Identifier | `attestation_id_vectors` (the two vectors of Part 1 §3.1) |

## Largest cases

The transactions are compile-time constants (`largest_*_tx` in `fixtures.ak`), so the test budgets show the cost of the rules. The issuer is a depth-4 subagent: 8 keys (the issuer key last), 8 parties, 16 capabilities, a long profile, and its four ancestors as reference inputs. The subject's record is as large. The attestation has every optional field, 4 links, a 256-byte locator and a 256-byte anchor. The transaction has 8 required signers.

| Test | Action |
|---|---|
| `largest_attest` | Attest, solicited, with the effective status of the depth-4 issuer |
| `largest_revoke_att` | RevokeAtt by the listed issuer key |
| `largest_contest` | Contest with a new 256-byte anchor |
| `largest_withdraw` | Withdraw by the listed issuer key |
| `largest_burn` | Burn |

## Decisions

Where the specification leaves a choice, the rules use the reading that is safest for funds and records.

1. **"At `AA`" for inputs and for the counted outputs.** The rules count every input and every output whose payment credential is the attestation script, with any stake credential. The one output that a rule allows must also be exactly at `AA`. Attest thus fails when any input has the attestation script as payment credential. RevokeAtt, Contest and Withdraw need the spent input to be the only such input. Attest, RevokeAtt and Contest fail when a second output has the attestation script as payment credential, for example with a stake credential. Identity §3.5 rule 1 uses the same input count. An attestation transaction thus cannot lock AP3X at the script under a stake credential, and the continuing output is never ambiguous.
2. **Mint scope.** Attest checks only the mint of the attestation policy (exactly `[(id, +1)]`), as identity §3.4 rule 2 does. Other policies can mint or burn in the same transaction (`attest_with_mint_of_other_policy`). RevokeAtt and Contest forbid only a mint or burn of the attestation policy, as §4.1 says.
3. **Burn.** The Burn handler checks the window rule, exactly one token of the attestation policy with quantity −1, exactly one attestation input (by payment credential) that is exactly at `AA` and holds this token, and the spend redeemer `Withdraw` for this input in `tx.redeemers`. It does not repeat the issuer authority and the 90-day rule. The ledger runs the Withdraw spend handler for that input, and that handler checks them.
4. **Validity range on every action.** Every handler starts with the condition `lo <= hi` on the result of `common.window`, also Contest and Burn, which use neither bound otherwise. The window rule thus runs before any branch. An infinite bound or `hi − lo > 3,600,000` fails every action.
5. **`format`.** `Some(f)` needs `0 ≤ f ≤ 65535`. The datum comment says "CoAP Content-Format", and RFC 7252 §12.3 defines these numbers as 0–65535.
6. **Link relations.** Only 0–3 (supersedes, depends_on, corroborates, disputes). The datum comment defines only these four, so other values are rejected. A relying party could not read them.
7. **`locator`.** `Some(bytes)` with 0–256 bytes, as the comment "up to 256 bytes" says. The contest `uri` needs 1–256 bytes, as §4.1 says.
8. **Times.** `issued_at`, `valid_from` and `valid_until` are valid times, in `[0, 253,402,300,799,999]` (the §3.3 time rule). `valid_from` can be before `issued_at`. Without `valid_until`, `valid_from` only needs to be a valid time.
9. **Revocation reason.** `RevokeAtt { reason }` needs `0 ≤ reason < 2^63` (the §3.3 integer rule). The Appendix A codes are not enforced for attestations: their "Allowed in" column names only identity actions.
10. **Contest.** It is allowed on a revoked attestation and on a contested one (the new anchor replaces the old one). The new `contested` must be `Some`: the subject cannot clear its reply. The subject's record can be a tombstone: `find_record` accepts live records and tombstones, and §4.1 sets no status rule for Contest.
11. **Issuer authority.** It has no effective-status rule; §4.1 does not set one. An issuer record that is a tombstone counts. Its controller keeps the authority. Its keys do not, because a tombstone lists no keys.
12. **Attest by a registered issuer.** The issuer key must sign. A signature of the issuer record's controller does not replace it (`attest_registered_issuer_not_signed`), because §4.1 lists `signed(issuer)` as a separate rule.
13. **Subject record at Attest.** Any authentic record is accepted, whatever its effective status (`attest_subject_suspended`, `attest_subject_tombstone`).
14. **Identifier lengths.** `subject` and `issuer_id` are 32 bytes, the length of an identifier (Part 1 §3.1).
15. **Deposit.** 5 AP3X is `min_deposit = 5_000_000` base units (6 decimals; the identity tests use 10,000,000 for 10 AP3X).
16. **Withdraw outputs.** The rules do not say where the released deposit goes.
