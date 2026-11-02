//// Adoption allowlist tree: Part 2 §3.4 (`docs/IDENTITY_REGISTRY.md`).
////
//// The leaves are `blake2b_256(id)` for each allowlisted identifier, sorted
//// in ascending byte order. Each level pairs the nodes from the left. A node
//// is `blake2b_256(min(l, r) ++ max(l, r))`. A last node without a pair moves
//// up unchanged. A proof lists the paired nodes from the leaf upward.

use aiken/builtin
use aiken/collection/list
use aiken/crypto.{blake2b_256}

/// A node of the tree: `blake2b_256(min(l, r) ++ max(l, r))` in byte order.
pub fn node(left: ByteArray, right: ByteArray) -> ByteArray {
  if builtin.less_than_bytearray(right, left) {
    blake2b_256(builtin.append_bytearray(right, left))
  } else {
    blake2b_256(builtin.append_bytearray(left, right))
  }
}

/// Adopt rule 4: start with `x = blake2b_256(id)`; for each element `s` of
/// `proof`, `x = node(x, s)`; the result equals `root`.
pub fn member(root: ByteArray, id: ByteArray, proof: List<ByteArray>) -> Bool {
  list.foldl(proof, blake2b_256(id), fn(sibling, x) { node(x, sibling) }) == root
}
