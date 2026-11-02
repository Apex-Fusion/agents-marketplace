# Delegation and vault tests (slice W2-DEL)

Part 2 of the plan (`docs/IDENTITY_REGISTRY.md`): §5.1 patterns, §5.2 delegations, §5.3 vaults, §12.1 rows "Delegation", "Vault" and "Other purposes".

| Code | Path |
|---|---|
| Delegation validator, parameter `identity_hash` | `validators/delegation.ak` |
| Vault validator, parameters `identity_hash`, `delegation_hash`, `escrow_hash` | `validators/vault.ak` |
| Patterns (§5.1) | `lib/identity_marketplace/delegation/pattern.ak` |
| Lookup and use checks (§5.2) | `lib/identity_marketplace/delegation/chain.ak` |
| Delegation handlers | `lib/identity_marketplace/delegation/handlers.ak` |
| Vault handler | `lib/identity_marketplace/vault/handlers.ak` |
| Test fixtures | `lib/identity_marketplace/delegation/fixtures.ak` |
| Tests | `lib/identity_marketplace/delegation/tests.ak`, `lib/identity_marketplace/vault/tests.ak`, `pattern.ak`, both validators |

Run: `cd contracts/identity-marketplace && aiken check -D -m identity_marketplace/delegation -m identity_marketplace/vault -m delegation -m vault`.

Each attack test changes one thing in a transaction that passes in a positive test. Every `fail` test was also run once without `fail`, with a trace on each condition of the handlers, to check that it fails at the intended condition.

## §12.1 Delegation

| Attack (must fail) | Tests |
|---|---|
| A child wider than its parent: actions | `delegate_child_wider_actions`, `delegate_child_star_action_under_prefix` |
| A child wider than its parent: resources | `delegate_child_wider_resources`, `delegate_child_resource_under_empty_parent` |
| A child wider than its parent: period | `delegate_child_starts_before_parent`, `delegate_child_ends_after_parent` |
| A child wider than its parent: depth | `delegate_child_same_depth_as_parent`, `delegate_child_depth_skips_one` |
| A child wider than its parent: remaining | `delegate_child_wider_remaining`, `delegate_under_parent_with_no_hops_left` |
| A child wider than its parent: value | `delegate_child_without_value_limit`, `delegate_child_higher_per_tx`, `delegate_child_higher_total` |
| A shorter `period_ms` | `delegate_child_shorter_period_ms` |
| `oc.*` treated as covering `ocr.*` | `covers_oc_prefix_not_ocr` (pattern), `delegate_oc_prefix_does_not_cover_ocr`, `use_oc_prefix_for_ocr_action` |
| An external pattern used as a prefix | `covers_external_only_exactly` (pattern), `delegate_external_pattern_as_prefix`, `use_external_pattern_as_prefix` |
| `period_ms = 0` | `delegate_period_ms_zero` |
| A delegate key without the delegation purpose | `delegate_key_without_delegation_purpose` |
| A delegate key that does not sign | `delegate_key_not_signed`, `use_delegate_key_not_signed`, `pay_without_delegate_key` |
| A sub-delegation without the signature of the parent's delegate key | `delegate_sub_without_parent_key_signature` |
| A sub-delegation signed by a parent delegate key that its agent removed | `delegate_sub_parent_key_removed` |
| A parent token from another policy or address | `delegate_parent_token_from_other_policy`, `delegate_parent_at_staked_address`, `delegate_parent_at_other_script`, `use_delegation_from_other_policy`, `use_parent_at_staked_address` |
| A change to a delegation output | `spend_rejects_delegate_redeemer`, `spend_change_without_burn`, `spend_burn_of_another_token` |
| Undelegate by a stranger | `undelegate_by_stranger`, `undelegate_by_delegate`, `undelegate_by_agent_key_without_delegation_purpose`, `undelegate_agent_record_missing`, `undelegate_ancestor_not_reference_input` |
| Use after the parent's Undelegate | `use_after_parent_undelegate`, `pay_after_undelegate` |
| Use with a delegate key that the delegate removed | `use_with_removed_delegate_key`, `pay_after_delegate_key_removed` |

Other attacks on the delegation contract: `delegate_parent_missing`, `delegate_sub_delegator_is_not_parent_delegate`, `delegate_sub_delegator_principal_key`, `delegate_sub_delegator_suspended`, `delegate_principal_not_signed`, `delegate_agent_delegator_without_signature`, `delegate_agent_delegator_suspended`, `delegate_agent_delegator_record_missing`, `delegate_delegate_suspended`, `delegate_delegate_revoked`, `delegate_delegate_record_missing`, `delegate_root_with_depth_two`, `delegate_seed_not_spent`, `delegate_name_not_from_seed`, `delegate_mints_quantity_two`, `delegate_mints_second_name`, `delegate_output_with_foreign_asset`, `delegate_output_with_reference_script`, `delegate_output_with_datum_hash`, `delegate_token_leaves_delegation_address`, `delegate_two_outputs_at_delegation_address`, `delegate_invalid_action_pattern`, `delegate_invalid_resource_pattern`, `delegate_without_actions`, `delegate_seventeen_actions`, `delegate_nine_resources`, `delegate_empty_period`, `delegate_time_after_year_9999`, `delegate_negative_time`, `delegate_total_above_cap`, `delegate_per_tx_above_total`, `delegate_organisation_too_long`, `delegate_purpose_not_32_bytes`, `delegate_unbounded_range`, `delegate_range_over_one_hour`, `undelegate_two_delegation_inputs`, `undelegate_burns_another_token`, `undelegate_burns_quantity_two`, `undelegate_unbounded_range`, `undelegate_range_over_one_hour`, `use_delegate_suspended`, `use_delegate_record_missing`, `use_intermediate_delegator_revoked`, `use_intermediate_delegator_suspended`, `use_root_agent_suspended`, `use_by_subagent_delegate_without_parent_record`, `use_by_subagent_delegate_after_epoch_bump`, `use_action_not_covered`, `use_resource_not_covered`, `use_empty_resource_list`, `use_before_period`, `use_after_period`, `use_delegation_with_second_token`, `use_delegation_as_spent_input`, `use_with_unbounded_range`, `use_after_intermediate_key_removal` (decision 1).

Positive controls: `delegate_by_principal_key`, `delegate_by_agent_controller`, `delegate_by_agent_delegation_key`, `delegate_sub_delegation`, `delegate_sub_delegation_narrower`, `delegate_sub_delegation_under_parent_without_limit`, `delegate_depth_4`, `delegate_oc_prefix_covers_oc_child`, `delegate_external_pattern_exact`, `valid_delegation_limits`, `spend_undelegate_burns_own_token`, `undelegate_by_principal_key`, `undelegate_by_agent_controller`, `undelegate_by_agent_delegation_key`, `undelegate_by_root_principal_of_ancestor`, `undelegate_by_ancestor_agent_controller`, `undelegate_by_revoked_agent_controller`, `use_depth_1_principal`, `use_depth_2_principal`, `use_depth_4_agent_root`, `use_by_subagent_delegate`, `use_at_period_start`, `use_at_period_end`, `use_oc_prefix_for_oc_action`, `use_finds_delegation`, `delegation_mint_delegate_wiring`, `delegation_spend_and_mint_undelegate_wiring`. Pattern unit tests: `valid_action_patterns`, `invalid_action_patterns`, `valid_resource_patterns`, `invalid_resource_patterns`, `covers_star_and_exact`, `covers_prefix`, `narrower_lists`.

## §12.1 Vault

| Attack (must fail, unless marked) | Tests |
|---|---|
| Pay without the delegate key | `pay_without_delegate_key`, `pay_signed_by_owner_not_delegate` |
| Pay above `per_tx` | `pay_above_per_tx` (control `pay_amount_equal_to_per_tx`) |
| Pay above `total` | `pay_above_total` (control `pay_up_to_total`) |
| A new period that starts before `hi` | `pay_new_period_starts_before_hi`, `pay_new_period_keeps_old_spent`, `pay_restarts_period_too_early` (controls `pay_new_period`, `pay_new_period_at_its_first_time`, `pay_same_period_until_its_end`) |
| Pay to an escrow that is not Open | `pay_escrow_not_open`, `pay_escrow_with_submitted_at`, `pay_escrow_with_receipt_hash` |
| … not at the exact escrow address | `pay_escrow_with_stake_credential`, `pay_escrow_at_other_script` |
| … above the cap | `pay_escrow_above_cap` (control `pay_escrow_at_cap`) |
| … not fully funded | `pay_escrow_not_fully_funded`, `pay_escrows_hold_less_than_amount` |
| … with more AP3X than payment + bonds (decision 11) | `pay_escrow_value_above_job`, `pay_escrow_value_far_above_job` (controls: every passing Pay, whose escrows hold exactly the job) |
| … with `deliver_by` beyond 7 days | `pay_escrow_deliver_by_beyond_7_days` (control `pay_escrow_deliver_by_at_7_days`) |
| … without the vault refund | `pay_escrow_without_vault_refund`, `pay_escrow_refund_to_owner_key`, `pay_escrow_refund_for_other_owner`, `pay_escrow_refund_with_live_datum` |
| … with another buyer key | `pay_escrow_other_buyer_key` |
| A second script input | `pay_second_script_input`, `pay_two_vault_inputs` |
| Pay from a `Returned` output | `pay_from_returned` |
| Close by anybody but the owner | `close_by_stranger`, `close_by_delegate`, `close_agent_by_delegation_key`, `close_agent_without_record`, `close_agent_with_other_record` |
| **Must pass:** Close after Undelegate | `close_after_undelegate` |

Other vault attacks: `pay_with_mint`, `pay_with_withdrawal`, `pay_with_unbounded_range`, `pay_with_range_over_one_hour`, `pay_vault_input_with_token` (decision 4), `pay_delegator_is_not_owner`, `pay_delegation_without_value_limit`, `pay_delegation_without_hire_action`, `pay_delegation_for_other_escrow_script`, `pay_delegate_suspended`, `pay_after_delegation_period`, `pay_escrow_with_foreign_asset`, `pay_escrow_with_reference_script`, `pay_escrow_with_datum_hash`, `pay_escrow_negative_bond` (decision 5), `pay_continuing_output_with_token`, `pay_continuing_output_with_reference_script`, `pay_continuing_output_at_staked_address`, `pay_two_vault_outputs`, `pay_continuing_datum_other_delegation`, `pay_continuing_datum_lower_spent`, `pay_zero_amount` and `pay_adds_funds` (decision 3), `vault_spend_without_datum_fails`, `vault_spend_pay_with_parameters_in_other_order`.

Positive controls: `pay_one_escrow`, `pay_several_escrows`, `pay_delegation_with_exact_action_and_star_resource`, `pay_at_end_of_delegation_period`, `close_live_by_principal`, `close_returned_by_principal`, `close_live_by_agent_controller`, `close_returned_by_agent_controller`, `close_several_vault_inputs`, `hire_action_and_escrow_resource`, `vault_spend_pay_wiring`.

§12.3 "No vault action lets the delegate spend a `Returned` output": `pay_from_returned`, `close_by_delegate`.

## §12.1 Other purposes

| Script | Tests |
|---|---|
| `delegation` (mint and spend only) | `delegation_as_withdraw_fails`, `delegation_as_publish_fails`, `delegation_as_vote_fails`, `delegation_as_propose_fails` |
| `vault` (spend only) | `vault_as_mint_fails`, `vault_as_withdraw_fails`, `vault_as_publish_fails`, `vault_as_vote_fails`, `vault_as_propose_fails` |

## §12.4 Benchmark

A depth-4 delegation chain (root delegator agent 0; 4 delegations and 5 identity records as reference inputs) used by a vault payment. The test cost includes the construction of the test transaction (`pay_depth_4_fixture_only`), so the handler alone costs about the difference.

| Test | Traces off (`aiken check -t silent`): memory / CPU | Traces on (default): memory / CPU |
|---|---|---|
| `pay_depth_4_chain_three_escrows` | 3,671,038 / 1,228,121,630 | 4,324,662 / 1,400,541,854 |
| `pay_depth_4_chain_five_escrows` | 4,018,094 / 1,368,786,660 | 4,773,118 / 1,568,287,334 |
| `pay_depth_4_fixture_only` | 573,259 / 164,087,723 | 573,259 / 164,087,723 |

The ledger limits are 16,000,000 memory units and 10,000,000,000 CPU units per transaction (the shared code uses 14,000,000 memory units for Vector). A Pay transaction runs no other script (the vault input is the only script input, and the transaction has no mint).

## Decisions

1. **Keys of every link.** The use check (`chain.use_delegation`) checks `active_key(delegate, delegate_key, delegation)` for every delegation of the chain, not only for the delegation in use. §5.2 names only "the delegate". Reason: when an agent removes the key that its delegation names, the sub-delegations that this key signed stop at once, as after `Undelegate` of the parent. Test: `use_after_intermediate_key_removal`.
2. **Coverage on the delegation in use.** The use check tests the action, the resource and the period only on the delegation in use. The contract mints a child only when it is narrower than its parent, and a delegation output never changes, so the ancestors cover at least as much.
3. **Empty resource list.** A delegation with `resources = []` covers no resource. This agrees with the narrowing rule of §5.1, where a child with `[]` is narrower than every parent; the other reading would let such a child be wider. Tests: `use_empty_resource_list`, `delegate_child_resource_under_empty_parent`.
4. **Positive amount.** Pay needs `amount > 0`. A zero amount would restart a period at a time that the delegate selects, and a negative amount (the continuing output holds more AP3X) would lower `spent`. Tests: `pay_zero_amount`, `pay_adds_funds`.
5. **AP3X-only vault input.** Pay needs a vault input with AP3X only. The continuing output must hold AP3X only (§5.3), so another asset in the input would leave the vault outside the limits. The owner can always Close such an output. Test: `pay_vault_input_with_token`.
6. **Escrow outputs.** Every output whose payment credential is `Script(escrow_hash)` is an escrow output of the payment: it must be at the exact escrow address and pass all escrow checks. Payment, buyer bond and supplier bond are each at least 0, so a negative value cannot lower the sum below the cap. Tests: `pay_escrow_with_stake_credential`, `pay_escrow_negative_bond`.
7. **Undelegate.** The time rule of §5.2 ("every transaction has `hi − lo ≤ 3,600,000`") applies to `Undelegate` too. Undelegate does not check the effective status of a delegator agent, so a suspended or revoked agent can still withdraw authority (`undelegate_by_revoked_agent_controller`). The walk up the ancestors skips a delegator agent whose record is not a reference input and stops at an ancestor that is not a reference input. Exactly one input has the payment credential `Script(delegation_hash)`, with any stake credential.
8. **Close** has no time rule and no status check (§5.3 lists none). An agent owner closes only with its controller key, as §5.3 says; a listed delegation key is not enough (`close_agent_by_delegation_key`).
9. **Datum limits.** Besides the datum comments of §5.2: times are in `[0, 253,402,300,799,999]`, `0 ≤ per_tx`, `period_ms < 2^63`, `parent` and `purpose` 32 bytes, `delegate` and an `Agent` identifier 32 bytes, `delegate_key` and a `PrincipalKey` hash 28 bytes, an organisation 1..64 bytes. Duplicate patterns are allowed.
10. **Spend redeemer.** The spend handler of the delegation contract takes `DelegationMint` as its redeemer and accepts only `Undelegate`. It also requires the burn of the token of the spent output, so the mint handler runs with `Undelegate`.
11. **Exact job (decision of 2026-11-02, review R2 LOW-1).** Each escrow output of a Pay holds exactly payment + buyer bond + supplier bond, not at least that amount. Accept and Release check only the job amounts, so with this rule the whole escrow value follows the escrow rules, and a refund returns all of it to `VA`. Builders put a min-UTxO top-up into the buyer bond. Tests: `pay_escrow_value_above_job`, `pay_escrow_value_far_above_job`; both fail with the earlier rule. `pay_escrow_negative_bond` now uses a job equal to the output's AP3X, so that only the negative bond rejects it.
