from cbor2 import CBORTag


def _build_datum_fields(
    task_hash_hex, buyer_vkh, supplier_vkh, payment_dfm,
    buyer_bond, supplier_bond, deadline_posix_ms, dispute_window_ms,
    state_field, resolver_cred,
):
    if supplier_vkh is None:
        supplier_field = CBORTag(122, [])
    else:
        supplier_field = CBORTag(121, [CBORTag(121, [supplier_vkh])])

    return CBORTag(121, [
        bytes.fromhex(task_hash_hex),
        CBORTag(121, [buyer_vkh]),
        payment_dfm,
        buyer_bond,
        supplier_field,
        supplier_bond,
        deadline_posix_ms,
        dispute_window_ms,
        state_field,
        CBORTag(121, [resolver_cred]),
    ])


def build_open_datum(task_hash_hex, buyer_vkh, payment_dfm, buyer_bond,
                     supplier_bond, deadline_posix_ms, dispute_window_ms, resolver_cred):
    state_field = CBORTag(121, [])
    return _build_datum_fields(
        task_hash_hex=task_hash_hex, buyer_vkh=buyer_vkh, supplier_vkh=None,
        payment_dfm=payment_dfm, buyer_bond=buyer_bond, supplier_bond=supplier_bond,
        deadline_posix_ms=deadline_posix_ms, dispute_window_ms=dispute_window_ms,
        state_field=state_field, resolver_cred=resolver_cred,
    )


def build_claimed_datum(task_hash_hex, buyer_vkh, supplier_vkh, payment_dfm,
                        buyer_bond, supplier_bond, deadline_posix_ms, dispute_window_ms,
                        resolver_cred):
    state_field = CBORTag(122, [])
    return _build_datum_fields(
        task_hash_hex=task_hash_hex, buyer_vkh=buyer_vkh, supplier_vkh=supplier_vkh,
        payment_dfm=payment_dfm, buyer_bond=buyer_bond, supplier_bond=supplier_bond,
        deadline_posix_ms=deadline_posix_ms, dispute_window_ms=dispute_window_ms,
        state_field=state_field, resolver_cred=resolver_cred,
    )


def build_submitted_datum(task_hash_hex, buyer_vkh, supplier_vkh, payment_dfm,
                          buyer_bond, supplier_bond, deadline_posix_ms, dispute_window_ms,
                          result_hash_hex, submitted_posix_ms, resolver_cred):
    state_field = CBORTag(123, [
        bytes.fromhex(result_hash_hex),
        submitted_posix_ms,
    ])
    return _build_datum_fields(
        task_hash_hex=task_hash_hex, buyer_vkh=buyer_vkh, supplier_vkh=supplier_vkh,
        payment_dfm=payment_dfm, buyer_bond=buyer_bond, supplier_bond=supplier_bond,
        deadline_posix_ms=deadline_posix_ms, dispute_window_ms=dispute_window_ms,
        state_field=state_field, resolver_cred=resolver_cred,
    )
