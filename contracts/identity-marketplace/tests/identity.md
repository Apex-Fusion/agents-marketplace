# Identity and configuration validators: test map (slice W2-ID)

This file maps each item of Part 2 §12.1 (`docs/IDENTITY_REGISTRY.md`) that is in scope for the `identity`, `config_holder` and `config_seal` validators to the Aiken tests that cover it. A `fail` test must fail. A test without `fail` must pass; when it checks an attack, it uses `!handler(...)`.

Run the tests from `contracts/identity-marketplace`:

```sh
aiken check -D
# One module:
aiken check -m "identity_marketplace/identity/tests/holds.{..}"
# Benchmarks without trace overhead:
aiken check -t silent --plain-numbers -m "identity_marketplace/identity/tests/benchmarks.{..}"
```

Each negative test starts from a transaction that passes and changes one thing. With the default trace level, the output of a `fail` test shows the check that rejected it.

## Code

| Path | Content |
|---|---|
| `validators/identity.ak` | Validator `identity(legacy_hash, legacy_root, config_policy, config_holder)`: mint, spend, `else` fails. Wiring and other-purpose tests. |
| `validators/config.ak` | Validators `config_holder` (no parameters; spend returns `False`, `else` fails) and `config_seal(seed, config_holder)` (mint, `else` fails). Tests. |
| `lib/identity_marketplace/identity/mint.ak` | `mint_ok(params: IdentityParams, redeemer: IdentityMint, own_policy: PolicyId, tx: Transaction) -> Bool` (§3.4). |
| `lib/identity_marketplace/identity/spend.ak` | `spend_ok(params: IdentityParams, redeemer: IdentitySpend, own_ref: OutputReference, tx: Transaction) -> Bool` (§3.5–§3.7). |
| `lib/identity_marketplace/identity/rules.ak` | `IdentityParams` and the §3.2 definitions: `signer_ok` (`ok(s)`), `covers`, `eligible_guardian`, `guardian_bound`, `accountable`, `current_author`, `kept_holds`, `reason_ok`, `invalid_from_ok`, `terminal`, `successor_ok`, `tombstone`, `record_output`. |
| `lib/identity_marketplace/identity/datum.ak` | `valid_datum(record, m1) -> Bool` (§3.3), `tombstone_fields`, `rights_within_role`, `signer_allowed`. |
| `lib/identity_marketplace/identity/allowlist.ak` | `node(l, r)` and `member(root, id, proof)` (§3.4 allowlist tree). |
| `lib/identity_marketplace/config/record.ak` | `token_name`, `module1(refs, config_policy, config_holder) -> Option<ByteArray>` (`M1`), `seal_ok(seed, config_holder, own_policy, tx) -> Bool`. |
| `lib/identity_marketplace/identity/kit.ak` | Test kit: records, keys, parties, holds, windows, the configuration reference input, legacy inputs, the allowlist tree builder, transactions for every action, the largest record. |
| `lib/identity_marketplace/identity/tests/*.ak`, `lib/identity_marketplace/config/tests.ak` | The tests below. |

Test module abbreviations: **R** `tests/register`, **A** `tests/adopt`, **D** `tests/datum`, **U** `tests/update`, **H** `tests/holds`, **S** `tests/status`, **C** `tests/recovery` (recovery, controller change, epoch), **X** `tests/scope`, **B** `tests/benchmarks`, **G** `config/tests`, **VI** `validators/identity`, **VC** `validators/config`.

## §12.1 coverage

### Identifier

| Attack | Tests |
|---|---|
| A name not derived from the seed | R `register_name_not_from_seed`, `register_with_redeemer_of_other_seed`; vectors of Part 1 §3.1: R `register_identifier_vectors` |
| A seed that is not spent | R `register_seed_not_spent` |
| A mint of quantity 2 or of a second name | R `register_quantity_2`, `register_second_name`; A `adopt_identity_quantity_2`, `adopt_with_second_identity_name` |
| A legacy mint or burn in a Register | R `register_with_legacy_mint`, `register_with_legacy_burn` |

### Record output

| Attack | Tests |
|---|---|
| The token leaves `IA` | R `register_token_leaves_identity_address`; X `scope_token_leaves_identity_address` |
| An output at the identity script with a stake credential | R `register_output_with_stake_credential`; X `scope_output_with_stake_credential` |
| A datum hash or no datum | R `register_datum_hash`, `register_no_datum`; X `scope_output_datum_hash`, `scope_output_no_datum` |
| A foreign asset | R `register_foreign_asset`; X `scope_output_foreign_asset` |
| A reference script | R `register_reference_script`; X `scope_output_reference_script` |
| Less than 10 AP3X on a live record | R `register_less_than_10_ap3x` (and `register_exactly_10_ap3x` passes); U `update_below_floor`; C `change_controller_below_floor`, `bump_epoch_below_floor` |
| Two outputs at `IA` | R `register_two_outputs_at_identity_address`; A `adopt_two_outputs_at_identity_address`; X `scope_two_outputs_at_identity_address` |
| A field outside a limit | R `register_field_outside_limit`; X `scope_output_field_outside_limit`; D `datum_controller_not_32_bytes`, `datum_nine_keys`, `datum_key_lengths`, `datum_p256_pop_length`, `datum_purposes_out_of_range`, `datum_nine_parties`, `datum_key_hash_length`, `datum_organisation_length`, `datum_party_period`, `datum_threshold_range`, `datum_pending_recovery_forms`, `datum_lineage`, `datum_epoch_range`, `datum_name_length`, `datum_description_framework_endpoint_lengths`, `datum_capabilities`, `datum_holds_count`, `datum_hold_times`, `datum_tombstone_fields`; C `recover_init_new_controller_not_32_bytes` |
| Duplicate keys or capabilities | D `datum_duplicate_key`, `datum_duplicate_capability`; R `register_duplicate_keys`, `register_duplicate_capabilities` |
| Two parties with the same role and signer | D `datum_same_role_and_signer` (and `datum_same_signer_other_roles` passes); R `register_same_role_and_signer`; U `update_appoints_party_twice` |
| A P-256 key with a transaction or delegation purpose | D `datum_p256_transaction_purpose`, `datum_p256_delegation_purpose`; R `register_p256_transaction_purpose` |
| A P-256 key without `pop` | D `datum_p256_without_pop`; R `register_p256_without_pop`; U `update_adds_p256_key_without_pop` |
| The purpose value 4 | D `datum_purpose_value_4`; R `register_purpose_value_4` |
| Other valid-datum rules (§3.3): Ed25519 without `pop`, terminal datum is a tombstone, subagent endpoint | D `datum_ed25519_with_pop`, `datum_terminal_is_tombstone`, `datum_subagent_endpoint`, positive cases `datum_valid_*`, `datum_every_ed25519_purpose_sum`, `datum_rights_within_role` |

### Time

| Attack | Tests |
|---|---|
| An unbounded range | R `register_unbounded_lower`, `register_unbounded_upper`; X `scope_unbounded_range` |
| A range over one hour, on every action | R `register_range_over_one_hour`; A `adopt_range_over_one_hour`; U `update_range_over_one_hour`; C `change_controller_range_over_one_hour`, `bump_epoch_range_over_one_hour`, `recover_init_range_over_one_hour`, `recover_cancel_range_over_one_hour`, `recover_finalize_range_over_one_hour`; H `suspend_range_over_one_hour`, `unsuspend_range_over_one_hour`; S `revoke_range_over_one_hour`, `retire_range_over_one_hour`, `reclaim_range_over_one_hour`, `set_successor_range_over_one_hour`. A range of exactly one hour passes: R `register_range_of_one_hour`, A `adopt_range_of_one_hour`, X `scope_range_of_one_hour` |
| `created_at ≠ hi` | R `register_created_at_not_hi`, `register_created_at_after_hi`; A `adopt_created_at_not_hi` |
| `created_at` changed | U `update_changes_created_at`; X `scope_created_at_changed_on_suspend`, `scope_created_at_changed_on_reclaim` |
| A time after the year 9999 | R `register_after_year_9999`, `register_party_time_after_year_9999`; D `datum_created_at_range`, `datum_party_times`, `datum_hold_times`, `datum_tombstone_fields` |
| A negative time | R `register_negative_time`; D `datum_created_at_range`, `datum_party_times`, `datum_hold_times` |

### Signatures

| Attack | Tests |
|---|---|
| The controller does not sign | R `register_controller_does_not_sign`, `register_controller_set_party_needs_controller`; A `adopt_controller_does_not_sign`; U `update_controller_does_not_sign`; C `change_controller_old_key_does_not_sign`, `bump_epoch_by_party`; S `retire_by_party`, `reclaim_by_revoking_party`, `set_successor_by_revoking_party`, `revoke_by_controller_without_signature`; H `suspend_by_controller_without_signature` |
| A new Ed25519 key does not sign | R `register_ed25519_key_does_not_sign`; A `adopt_ed25519_key_does_not_sign`; U `update_adds_unsigned_ed25519_key` (and `register_p256_key_without_signature`, `update_adds_p256_key` pass) |
| A new controller does not sign | C `change_controller_new_key_does_not_sign`, `recover_init_without_new_key_signature` |
| A party does not sign its appointment | R `register_party_does_not_sign`; A `adopt_party_does_not_sign`; U `update_appointment_not_signed` |

### Adopt

| Attack | Tests |
|---|---|
| No legacy burn | A `adopt_without_legacy_burn` |
| A burn of another name (mint X, burn Y) | A `adopt_burn_of_other_name` |
| The legacy owner does not sign | A `adopt_legacy_owner_does_not_sign` |
| A name outside `legacy_root` | A `adopt_name_outside_root`, `adopt_wrong_proof` |
| A script owner | A `adopt_script_owner` |
| Legacy input forms (§3.4 rule 3) | A `adopt_with_datum_hash` (passes), `adopt_legacy_input_with_stake_credential`, `adopt_two_legacy_inputs`, `adopt_legacy_input_with_two_tokens`, `adopt_legacy_input_without_datum`, `adopt_datum_hash_not_in_transaction`, `adopt_legacy_datum_not_decoded`, `adopt_as_subagent`, `adopt_with_identity_input`, `adopt_without_accountable_party` |
| Allowlist tree (§3.4): odd number of leaves, unpaired last leaf, independent root vector | A `allowlist_root_vector`, `allowlist_proof_of_unpaired_last_leaf`, `allowlist_proof_of_paired_leaf`, `allowlist_every_member`, `allowlist_rejects_others`, `allowlist_single_leaf`, `adopt_identifier_with_long_proof`, `adopt_every_allowlisted_identifier` |

### Spend scope

| Attack | Tests |
|---|---|
| Two identity inputs | X `scope_two_identity_inputs`, `scope_second_identity_input_first` |
| An identity input with a stake credential | X `scope_identity_input_with_stake_credential`, `scope_second_identity_input_with_stake_credential`; R `register_with_staked_identity_input` |
| An input at `IA` without a token | X `scope_input_without_token`, `scope_input_with_two_tokens`, `scope_input_datum_hash`, `scope_input_datum_not_a_record` |
| A Register together with an Update | X `scope_register_together_with_update` (spend side), `scope_register_together_with_update_mint_side`; R `register_with_identity_input` |
| Any mint or burn of the own policy in a spend | X `scope_mint_of_own_policy`, `scope_burn_of_own_token` |
| Must pass: an input of another script | X `scope_other_script_input_allowed` |

### Parties

| Attack | Tests |
|---|---|
| Removal without consent or notice | U `update_removes_party_without_consent_or_notice`, `update_removes_party_before_notice_ends`, `update_removes_module1_before_notice_ends`; passes: `update_removes_party_after_notice`, `update_removes_party_with_consent`, `update_removes_module1_after_notice_without_configuration` |
| Notice shorter than 7 days from `hi` | U `update_notice_shorter_than_7_days`, `update_notice_counted_from_lo`, `update_notice_with_other_change`, `update_moves_notice_without_signature`, `update_cancels_notice_without_signature`; passes: `update_gives_notice_of_7_days`, `update_gives_module1_notice` |
| A changed party without its signature | U `update_changes_party_without_signature` (passes signed: `update_changes_party_with_signature`) |
| Party order (§3.6) | U `update_reorders_matched_parties`, `update_new_party_before_matched_party`; passes: `update_keeps_order_and_appends` |
| Rights above the role's highest rights | D `datum_rights_above_role`; R `register_rights_above_role`; U `update_rights_above_role` |
| A Distributor or Guardian that suspends | D `datum_distributor_or_guardian_suspend_right`; H `suspend_by_distributor`, `suspend_by_guardian`, `suspend_by_party_without_suspend_right` |
| A party outside its period | H `suspend_by_party_before_its_period`, `suspend_by_party_after_its_period`; S `revoke_by_party_outside_period`; C `recover_init_guardian_before_its_period`, `recover_init_guardian_after_its_period` |
| A party revocation that names a successor | S `revoke_by_party_with_successor` |
| A `Script` party that is not Module-1 | D `datum_script_party_other_than_module1`, `datum_signers_by_role`; R `register_script_party_not_module1`; U `update_appoints_other_script` |
| A Module-1 action without the withdrawal | R `register_module1_without_withdrawal`, `register_module1_withdrawal_of_other_script`; U `update_appoints_module1_without_withdrawal`; H `suspend_by_module1_without_withdrawal`, `unsuspend_module1_hold_without_withdrawal`; S `revoke_by_module1_without_withdrawal` |
| `ok(Script)` needs `M1` from the configuration reference input | S `revoke_by_module1_without_configuration` (fails at the authorisation); R `register_module1_without_configuration`, `register_configuration_at_other_address`; U `update_appoints_module1_without_configuration`, `update_with_module1_party_needs_configuration`; H `suspend_by_module1_without_configuration`; G `module1_*` |
| Reason 64 from another author | H `suspend_reason_64_by_controller`, `suspend_reason_64_by_key_party`; S `revoke_reason_64_by_controller`, `revoke_reason_64_by_key_party`; passes for Module-1: H `suspend_by_module1`, S `revoke_by_module1` |
| A Module-1 consent withdrawal attached to Revoke, Retire, Suspend, Unsuspend, RecoverInit or RecoverCancel (F-05) | Module-1 side: its withdraw handler checks the identity redeemer. Identity side: these actions accept `ok(Script { M1 })` only where the table allows a party or author; see Decision 4 |

### Holds

| Attack | Tests |
|---|---|
| A hold over 30 days | H `suspend_over_30_days` (passes at 30 days: `suspend_for_30_days`); D `datum_hold_times` |
| Unsuspend by anybody but the author | H `unsuspend_by_other_signer`, `unsuspend_controller_drops_party_hold`, `unsuspend_author_without_hold`, `unsuspend_module1_hold_by_controller`, `suspend_controller_party_key_cannot_lift_other_hold` |
| A Suspend that drops or shortens a hold in force of another current author | H `suspend_drops_hold_in_force_of_other_author`, `suspend_shortens_hold_of_other_author`, `suspend_reorders_holds`, `unsuspend_shortens_other_hold`; passes: `suspend_keeps_holds_of_other_authors` |
| Two holds by one author | H `suspend_two_holds_by_one_author`; D `datum_two_holds_by_one_author` |
| More than 10 holds | H `suspend_more_than_10_holds`; D `datum_holds_count` |
| The controller that holds a hold through its own party key and so blocks another party's Suspend | H `suspend_controller_party_key_does_not_block`, `suspend_not_blocked_by_holds_of_removed_party_keys` (both pass) |
| A Module-1 hold dropped after the removal of Module-1, also without the configuration reference input | H `suspend_drops_module1_hold_after_removal_without_configuration`, `suspend_drops_module1_hold_after_removal_with_configuration`, `unsuspend_drops_module1_hold_after_removal`; passes: `suspend_keeps_module1_hold_after_removal_without_configuration`, `unsuspend_keeps_module1_hold_after_removal_without_configuration` |
| Must pass: a Suspend that drops the hold of a removed key party | H `suspend_drops_hold_of_removed_key_party` (and `suspend_keeps_hold_of_removed_key_party` fails) |
| Lapsed holds are dropped | H `suspend_drops_lapsed_holds`, `suspend_keeps_lapsed_hold` (fails), `unsuspend_lapsed_own_hold`, `unsuspend_drops_lapsed_and_removed_holds` |
| Other Suspend/Unsuspend rules | H `suspend_until_not_after_hi`, `suspend_since_not_lo`, `suspend_hold_of_other_author`, `suspend_every_allowed_reason`, `suspend_reason_not_allowed`, `suspend_renews_own_hold`, `suspend_shortens_own_hold`, `suspend_by_party_index_out_of_range`, `suspend_changes_other_field`, `unsuspend_last_hold_gives_active`, `unsuspend_last_hold_kept_suspended`, `unsuspend_of_active_record` |

### Module-1 verdicts (identity side)

| Item | Tests |
|---|---|
| Reason 64 only for author `Script { M1 }` | see Parties, "Reason 64 from another author" |
| Unsuspend of a Module-1 hold | H `unsuspend_module1_hold_without_withdrawal`, `unsuspend_module1_hold_by_controller`; with the withdrawal the identity side accepts and Module-1 refuses: `unsuspend_by_module1_relies_on_module1_withdraw_rule` (Decision 4) |
| A verdict revocation with a successor | S `revoke_by_party_with_successor` (every party revocation) |
| A verdict hold by Module-1 in the largest record | B `bench_suspend_by_module1_largest`, `bench_revoke_by_module1_largest` |

The other verdict rules (verdict mint and burn, `until` = the later of `lo + duration` and the current Module-1 hold, a verdict that shortens a Module-1 hold, a verdict revocation with `invalid_from`, one verdict used twice, a verdict for another agent, Consent rules) are checks of Module-1 `identity_party`.

### Statuses

| Attack | Tests |
|---|---|
| Any spend of a tombstone except Reclaim and SetSuccessor | U `update_of_tombstone`; C `change_controller_of_tombstone`, `bump_epoch_of_tombstone`, `recover_init_of_tombstone`; H `suspend_of_tombstone`; S `revoke_of_tombstone`, `retire_of_tombstone`; X `lifecycle_tombstone_stays_terminal` (Unsuspend) |
| SetSuccessor twice | S `set_successor_twice` |
| SetSuccessor that the controller does not sign, for example by the revoking party | S `set_successor_by_revoking_party` |
| A successor without consent | S `revoke_successor_without_consent`, `retire_successor_without_consent`, `set_successor_without_consent` |
| A successor that is the record itself, a subagent or a tombstone | S `revoke_successor_is_record_itself`, `revoke_successor_is_subagent`, `revoke_successor_is_tombstone`, `revoke_successor_missing`, `set_successor_is_record_itself`, `set_successor_is_tombstone` |
| Reason 1 without `invalid_from` | S `revoke_reason_1_without_invalid_from` (passes with it: `revoke_reason_1_with_invalid_from`) |
| `invalid_from` before `created_at` | S `revoke_invalid_from_before_created_at`, `revoke_invalid_from_after_lo` |
| A reason not allowed for the action | S `revoke_reason_not_allowed`, H `suspend_reason_not_allowed` |
| Must pass: SetSuccessor by the controller after a party revocation | S `set_successor_after_party_revocation` |
| Tombstone form and other rules | S `revoke_keeps_keys`, `revoke_changes_name`, `revoke_at_not_lo`, `revoke_by_other_than_author`, `retire_at_not_lo`, `retire_not_tombstone`, `reclaim_changes_datum`, `reclaim_back_to_live_status`, `reclaim_of_live_record`, `set_successor_changes_other_status_field`, `set_successor_to_none`, `set_successor_of_live_record`, `tombstone_back_to_live_by_set_successor`, `tombstone_kit_matches_rules` |

### Value

| Attack | Tests |
|---|---|
| Value taken on Suspend, Unsuspend, Revoke, SetSuccessor or any recovery action | H `suspend_takes_value`, `unsuspend_takes_value`; S `revoke_takes_value`, `set_successor_takes_value`; C `recover_init_takes_value`, `recover_cancel_takes_value`, `recover_finalize_takes_value` (adding value passes: H `suspend_adds_value`) |
| Reclaim or Retire by anybody but the controller | S `reclaim_by_revoking_party`, `retire_by_party` (the controller passes: `reclaim_by_controller`, `retire_takes_deposit_down_to_ledger_minimum`) |
| The 10-AP3X floor for Update, ChangeController, BumpEpoch | U `update_takes_ap3x_down_to_floor`, `update_below_floor`; C `change_controller_down_to_floor`, `change_controller_below_floor`, `bump_epoch_down_to_floor`, `bump_epoch_below_floor` |

### Recovery

| Attack | Tests |
|---|---|
| RecoverInit below the threshold | C `recover_init_below_threshold`, `recover_cancel_below_threshold`, `recover_cancel_by_controller` |
| With an ineligible guardian | C `recover_init_with_non_guardian`, `recover_init_guardian_without_recover_right`, `recover_init_guardian_before_its_period`, `recover_init_guardian_after_its_period`, `recover_init_guardian_does_not_sign`, `recover_cancel_with_non_guardian` |
| With one guardian counted twice (same index or same signer) | C `recover_init_same_index_twice`, `recover_init_same_signer_twice` |
| With a recovery pending | C `recover_init_with_recovery_pending` |
| Without the new key's signature | C `recover_init_without_new_key_signature` |
| RecoverFinalize before `effective_after` | C `recover_finalize_before_effective_after`, `recover_init_delay_from_lo`, `recover_init_short_delay` |
| Recovery after a controller change | C `recovery_after_controller_change`, `change_controller_keeps_pending_recovery` |
| An Update with a threshold above the guardian bound | U `update_threshold_above_guardian_bound`, `update_guardian_leaves_threshold_kept`; R `register_threshold_above_guardian_bound`, `register_guardian_ended_does_not_count`; passes: `update_guardian_leaves_threshold_lowered`, `register_future_guardian_counts` |
| A pending recovery with threshold 0 | D `datum_pending_recovery_with_threshold_0`; U `update_threshold_0_with_pending_recovery`; C `recover_init_threshold_0`; passes: `update_threshold_0_cancels_pending_recovery` |
| Must pass: Suspend, Unsuspend and RecoverFinalize after a guardian's period ended | H `suspend_after_guardian_period_ended`, `unsuspend_after_guardian_period_ended`; C `recover_finalize_after_guardian_period_ended`; U `update_profile_with_threshold_above_bound_kept` |
| Other recovery rules | C `recover_init`, `recover_init_with_every_guardian`, `recover_init_while_suspended`, `recover_init_changes_other_field`, `recover_cancel`, `recover_cancel_without_pending`, `recover_cancel_keeps_pending`, `recover_finalize_by_anybody`, `recover_finalize_keeps_holds`, `recover_finalize_without_pending`, `recover_finalize_other_controller`, `recover_finalize_epoch_not_increased`; U `update_clears_pending_recovery_without_threshold_0`, `update_sets_pending_recovery`, `update_keeps_pending_recovery` |

### Subagents

| Attack | Tests |
|---|---|
| Depth 5 | R `register_subagent_depth_5` (depth 4 passes: `register_subagent_depth_4`) |
| A stale `parent_epoch` | R `register_subagent_stale_parent_epoch` (passes with the current epoch: `register_subagent_current_parent_epoch`) |
| A parent that does not sign or is not Active | R `register_subagent_parent_does_not_sign`, `register_subagent_parent_suspended`, `register_subagent_parent_unaccountable`, `register_subagent_parent_tombstone`, `register_subagent_grandparent_epoch_increased`, `register_subagent_parent_missing`, `register_subagent_parent_at_other_address`, `register_subagent_wrong_depth` |
| An endpoint on a subagent | R `register_subagent_with_endpoint`; D `datum_subagent_endpoint` |
| A subagent that survives an epoch increase, a controller change or a recovery | C `subagent_ends_with_epoch_increase`, `subagent_ends_with_controller_change`, `subagent_ends_with_recovery` (the subagent is `EffActive` before: `subagent_active_before_epoch_increase`); C `bump_epoch_by_two`, `change_controller_epoch_not_increased`, `recover_finalize_epoch_not_increased` |

### Other purposes

| Attack | Tests |
|---|---|
| `identity` used as withdraw, publish, vote or propose | VI `identity_withdraw_fails`, `identity_publish_fails`, `identity_vote_fails`, `identity_propose_fails` |
| `config_holder` used for any purpose | VC `config_holder_spend_fails`, `config_holder_mint_fails`, `config_holder_withdraw_fails`, `config_holder_publish_fails`, `config_holder_vote_fails`, `config_holder_propose_fails` |
| `config_seal` used as spend, withdraw, publish, vote or propose | VC `config_seal_spend_fails`, `config_seal_withdraw_fails`, `config_seal_publish_fails`, `config_seal_vote_fails`, `config_seal_propose_fails` |
| Wiring of the handlers | VI `identity_mint_wiring`, `identity_mint_wiring_rejects`, `identity_spend_wiring`, `identity_spend_wiring_rejects`; VC `config_seal_mint_wiring`, `config_seal_mint_wiring_rejects` |

### Configuration record (§3.8)

| Rule | Tests |
|---|---|
| The seal mints only when the transaction spends `seed` | G `seal_mints_configuration_token`, `seal_without_seed` |
| Exactly one token `identity-config` (hex `6964656e746974792d636f6e666967`), never a burn | G `config_token_name_hex`, `seal_quantity_2`, `seal_other_name`, `seal_second_token`, `seal_burn` |
| The token goes to the exact `config_holder` enterprise address | G `seal_to_staked_holder`, `seal_to_other_script`, `seal_to_key_address` |
| Its inline datum is a 28-byte byte string | G `seal_datum_hash`, `seal_no_datum`, `seal_datum_not_bytes`, `seal_datum_wrong_length`, `seal_datum_too_long` |
| `M1` lookup | G `module1_found`, `module1_none_without_configuration`, `module1_ignores_staked_holder`, `module1_ignores_input_without_token`, `module1_ignores_other_policy`, `module1_datum_not_inline`, `module1_from_first_holder_input` |

## Valid actions and other rule tests

Every action has at least one positive test. These tests also cover the rules of §3.4–§3.7 that the §12.1 rows do not name.

| Action | Positive tests | Other rule tests (must fail) |
|---|---|---|
| Register | R `register_root`, `register_every_party_kind`, `register_without_keys`, `register_subagent_depth_1`, `register_subagent_signers_also_cover_parent`, `register_unrelated_signer_is_harmless`, `register_module1_party_with_stray_withdrawal_is_harmless`; D `datum_valid_record`, `datum_valid_largest`, `datum_valid_subagent`, `datum_valid_time_bounds`, `datum_valid_tombstones`, `datum_valid_without_parties_or_keys`, `datum_eight_keys` | R `register_not_active`, `register_with_pending_recovery`, `register_epoch_not_0`, `register_as_tombstone`, `register_without_accountable_party`, `register_accountable_party_not_yet_started`, `register_accountable_party_ends_before_hi`; D `datum_script_party_without_configuration` |
| Adopt | A `adopt_with_inline_datum`, `adopt_party_signs` | see the Adopt table |
| Update | U `update_profile`, `update_without_change`, `update_while_suspended`, `update_adds_signed_ed25519_key`, `update_removes_key`, `update_reorders_keys`, `update_appoints_signed_party`, `update_appoints_module1`, `update_with_module1_party_kept`, `update_removes_last_accountable_party`; X `scope_update` | U `update_changes_controller`, `update_changes_lineage`, `update_changes_epoch`, `update_changes_status`, `update_kept_key_changes_purposes`, `update_kept_key_changes_purposes_with_pop_unchanged`, `update_kept_p256_key_changes_pop` |
| ChangeController | C `change_controller`, `change_controller_cancels_pending_recovery`, `change_controller_keeps_holds` | C `change_controller_lifts_holds`, `change_controller_changes_other_field` |
| Suspend | H `suspend_by_controller`, `suspend_by_party` | H `suspend_by_party_without_signature` |
| Unsuspend | H `unsuspend_by_author`, `unsuspend_controller_hold` | see the Holds table |
| Revoke | S `revoke_by_controller`, `revoke_by_controller_with_successor`, `revoke_by_accountable_party`, `revoke_while_suspended_ends_holds`, `revoke_every_allowed_reason` | S `revoke_by_party_without_revoke_right`, `revoke_by_responsible_party`, `revoke_by_provider`, `revoke_by_party_without_signature` |
| Retire | S `retire_by_controller`, `retire_with_successor` | see the Statuses table |
| Reclaim | S `reclaim_after_party_revocation`, `reclaim_keeps_whole_deposit` | see the Value table |
| SetSuccessor | S `set_successor_after_controller_revocation`, `set_successor_after_retire` | see the Statuses table |
| BumpEpoch | C `bump_epoch` | C `bump_epoch_changes_other_field` |
| RecoverInit, RecoverCancel, RecoverFinalize | see the Recovery table | see the Recovery table |
| Any spend | — | X `scope_own_input_missing` |

## §12.3 properties (identity)

| Property | Tests |
|---|---|
| No sequence of valid transactions moves a tombstone back to a live status | Every action except Reclaim and SetSuccessor fails on a tombstone (Statuses table); S `reclaim_back_to_live_status`, `tombstone_back_to_live_by_set_successor`; X `lifecycle_sequence`, `lifecycle_tombstone_stays_terminal` |
| No sequence changes `created_at` or the token name | The spend handler checks `D'.created_at = D.created_at` for every action before the action branch: X `scope_created_at_changed_on_suspend`, `scope_created_at_changed_on_reclaim`, U `update_changes_created_at`; the record output must hold `(own, id)`: X `scope_output_with_other_token_name`; X `lifecycle_sequence` |
| No path lets anybody except the controller reduce a record's value | Value table; the actions without "kept" (Update, ChangeController, BumpEpoch, Retire, Reclaim) need the controller's signature |
| No action by one author removes or shortens the hold in force of another current author | Holds table |
| A subagent under an old epoch is Revoked; a child is never better than its parent | Library `effective` (foundation tests); Register needs `effective(P) = Active`: R `register_subagent_*`; C `subagent_ends_with_*` |

## §12.4 benchmarks

Module B. Fixtures are module constants (the compiler evaluates them), so the numbers cover the handler call. Trace level silent, aiken v1.1.21, stdlib v3.1.0. Ledger limits per transaction: 16,000,000 memory units and 10,000,000,000 CPU units.

The largest record: 8 keys (5 Ed25519 with every purpose, 3 P-256 with `pop`), 8 parties (Module-1 and 7 key parties, 64-byte organisations, `not_after` set), 10 holds in force, 16 capabilities of 64 bytes, name 64, description 256, framework 64, endpoint 256 bytes. Its inline datum is 3,975 bytes of CBOR (B `largest_datum_size`); its tombstone is 181 bytes (`largest_tombstone_size`). Recovery actions use the same record with three guardians (threshold 3).

| Test | Memory | CPU |
|---|---:|---:|
| `bench_register_largest` (13 required signers, Module-1 party) | 2,678,349 | 903,798,451 |
| `bench_adopt_largest` (13-node proof) | 2,851,089 | 957,409,124 |
| `bench_register_subagent_depth_4` (4 ancestors of the largest size as reference inputs) | 6,183,244 | 2,012,482,342 |
| `bench_update_largest` (new key, removal notice, new description) | 4,703,524 | 1,772,355,564 |
| `bench_change_controller_largest` | 3,610,690 | 1,285,709,520 |
| `bench_suspend_largest` (key party renews its hold) | 4,009,069 | 1,470,339,936 |
| `bench_suspend_by_module1_largest` | 4,023,033 | 1,480,923,961 |
| `bench_unsuspend_largest` | 3,820,798 | 1,391,056,424 |
| `bench_revoke_largest` (controller, reason 1, successor) | 1,740,307 | 567,006,903 |
| `bench_revoke_by_module1_largest` | 1,194,735 | 397,780,863 |
| `bench_retire_largest` (successor) | 1,637,228 | 531,853,629 |
| `bench_reclaim_largest` | 433,914 | 153,209,931 |
| `bench_set_successor_largest` | 1,118,338 | 372,811,768 |
| `bench_bump_epoch_largest` | 3,608,811 | 1,284,932,354 |
| `bench_recover_init_largest` (3 guardians) | 3,946,770 | 1,396,309,034 |
| `bench_recover_cancel_largest` | 3,911,849 | 1,384,275,263 |
| `bench_recover_finalize_largest` | 3,684,433 | 1,306,254,902 |

The highest case uses 39% of the memory limit and 20% of the CPU limit.

## Decisions

1. **Valid datum on every record output, in full.** The handlers check §3.3 on the whole `D'` in every spend, also for fields that the action does not change. A `Script` party is valid only with `hash = M1`, and `M1` comes only from the configuration reference input (§3.2). So every transaction whose record output has a Module-1 party needs the configuration reference input, also a controller action that does not touch the party. Tests: U `update_with_module1_party_needs_configuration`, H `suspend_by_module1_without_configuration`. A record without a `Script` party needs no configuration input: H `suspend_keeps_module1_hold_after_removal_without_configuration`, U `update_removes_module1_after_notice_without_configuration`.
2. **No identity input in a Register or Adopt.** §3.4 rule 4 says "no transaction input is at `IA`". The handler rejects every input with payment credential `Script(own hash)`, with any stake credential. Such an input can never be spent anyway (spend rule 1).
3. **Exactly one input at `LA` in an Adopt.** §3.4 rule 3 reads as "exactly one". A second legacy input fails: A `adopt_two_legacy_inputs`.
4. **Module-1 approval stays with Module-1.** As the spec says, `ok(Script { M1 })` is `hash = M1` plus a withdrawal for `Script(M1)`. With the withdrawal, the identity side accepts an Unsuspend of the Module-1 hold and a removal of the Module-1 party before its notice ends; Module-1's withdraw handler never approves them (§3.8 Limits). The tests `unsuspend_by_module1_relies_on_module1_withdraw_rule` and `update_removes_module1_with_withdrawal_relies_on_module1` record this. The same applies to F-05, to "a later verdict never shortens a Module-1 hold" and to the verdict `until`: the identity Suspend rule lets every author replace its own hold with any `until` in `(hi, lo + 30 days]` (H `suspend_shortens_own_hold`).
5. **Every hold lasts at most 30 days.** The valid datum checks `until − since ≤ 30 days` for every hold (Part 1 §5), not only for the new hold.
6. **Signer hashes are 28 bytes.** The valid datum requires 28 bytes for `KeyHash` and `Script` signers in parties, holds and `Revoked.by` (Part 1 §5).
7. **A successor must be a live record.** "Live" means not terminal: an Active or a Suspended root record counts (S `revoke_successor_suspended_record`).
8. **SetSuccessor sets a successor.** A SetSuccessor whose `D'` has no successor fails (S `set_successor_to_none`).
9. **Guardians with distinct signers.** A valid datum has no two parties with the same role and signer, so the guardian bound counts parties, and RecoverInit/RecoverCancel check distinct signers (which also makes the indices distinct).
10. **Checks for every redeemer come before the redeemer branch.** The window (`lo`, `hi`, at most one hour), the identity input count, the own-policy mint, the record output and `D'.created_at = D.created_at` are evaluated before the action branch, so the optimizer cannot move them into some branches only. Each action has its own over-one-hour test.
11. **`config_seal` output value.** The output that holds the token must be at the exact holder address with the 28-byte inline datum. The seal does not limit the other assets of that output; the spec does not ask for it.

## Requests to other slices

- **Builders (wave 3):** add the configuration reference input to every identity transaction whose record output has a Module-1 party (Decision 1), and to every transaction that uses `ok(Script { M1 })`. A subagent Register needs the parent and every ancestor as reference inputs and the parent controller's signature. A successor needs the successor record as reference input and its controller's signature.
- **Module-1 `identity_party`:** the identity contract relies on the withdraw handler for the rules in Decision 4.
