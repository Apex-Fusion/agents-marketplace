//// Action and resource patterns of delegations: Part 2 §5.1 of
//// `docs/IDENTITY_REGISTRY.md`.
////
//// ```abnf
//// action           = internal / external
//// resource         = script / did / external
//// action-pattern   = "*" / internal / prefix / external
//// resource-pattern = "*" / script / did / external
//// internal         = seg *( "." seg )
//// prefix           = seg *( "." seg ) ".*"
//// seg              = 1*( %x61-7A / DIGIT / "-" )
//// external         = ( %s"oauth:" / %s"mcp:" / %s"https://" ) 1*VCHAR
//// script           = %s"script:" 56lowhex
//// did              = %s"did:vector:" 64lowhex
//// ```
////
//// Coverage: a pattern `p` covers a value `a` when `p = "*"`, or `p = a`, or
//// `p = x ".*"` (a `prefix`) and `a` starts with `x "."`. External, script and
//// did patterns match only exactly.
////
//// The same rule decides whether a parent pattern covers a child pattern. A
//// child `x.*` is then covered only by `*`, by `x.*` itself, or by a parent
//// `y.*` where `x` starts with `y "."`. A child `*` is covered only by `*`. A
//// plain string-prefix test is wrong: `oc.*` does not cover `ocr.*`.
////
//// A `did` pattern names one supplier agent. The 64 digits are the
//// identifier of the agent record. A resource list with `did` patterns
//// limits the agents that a vault can pay. `*` never counts as a `did`
//// pattern, and it never widens the list. So `resources_narrower` compares
//// the `did` patterns of two lists by equality, apart from the other
//// patterns, and the supplier test of a vault payment never calls `covers`.
////
//// `covers` trusts that its pattern follows the grammar. The delegation
//// contract checks the grammar of every pattern when it mints a delegation,
//// and a delegation output never changes.

use aiken/builtin
use aiken/collection/list
use aiken/primitive/bytearray

/// The pattern that covers every value.
pub const star: ByteArray = "*"

/// The prefix of a `did` pattern.
pub const did_prefix: ByteArray = "did:vector:"

/// The length of the prefix of a `did` pattern.
const did_prefix_length: Int = 11

/// The length of a `did` pattern: the prefix and 64 hexadecimal digits.
const did_length: Int = 75

/// True when `pattern` is an `action-pattern`.
pub fn valid_action_pattern(pattern: ByteArray) -> Bool {
  if pattern == star {
    True
  } else {
    let n = bytearray.length(pattern)
    let scheme = external_scheme_length(pattern)
    if scheme > 0 {
      visible_span(pattern, scheme, n)
    } else if ends_with_dot_star(pattern, n) {
      internal_span(pattern, 0, n - 2, 0)
    } else {
      internal_span(pattern, 0, n, 0)
    }
  }
}

/// True when `pattern` is a `resource-pattern`.
pub fn valid_resource_pattern(pattern: ByteArray) -> Bool {
  if pattern == star {
    True
  } else {
    let n = bytearray.length(pattern)
    let scheme = external_scheme_length(pattern)
    if scheme > 0 {
      visible_span(pattern, scheme, n)
    } else if is_did(pattern) {
      n == did_length && lowhex_span(pattern, did_prefix_length, n)
    } else {
      and {
        n == 63,
        bytearray.take(pattern, 7) == "script:",
        lowhex_span(pattern, 7, n),
      }
    }
  }
}

/// True when `pattern` starts with the prefix of a `did` pattern.
/// `valid_resource_pattern` decides whether the whole pattern is valid.
pub fn is_did(pattern: ByteArray) -> Bool {
  bytearray.take(pattern, did_prefix_length) == did_prefix
}

/// The resource `did:vector:<agent_id>`, with the 32-byte identifier of the
/// agent in lowercase hexadecimal.
pub fn did_resource(agent_id: ByteArray) -> ByteArray {
  bytearray.concat(did_prefix, hex(agent_id))
}

/// The lowercase hexadecimal text (`0-9`, `a-f`) of `bytes`.
pub fn hex(bytes: ByteArray) -> ByteArray {
  hex_from(#"", bytes, 0, builtin.length_of_bytearray(bytes))
}

/// The ASCII text `000102...fdfeff`: the two lowercase hexadecimal digits of
/// each byte `00` to `ff`, in order (512 bytes). A table is faster than the
/// arithmetic for each digit: a vault payment writes one agent identifier for
/// each escrow output. The test `hex_writes_every_byte` checks the table.
const hex_pairs: ByteArray =
  #"3030303130323033303430353036303730383039306130623063306430653066313031313132313331343135313631373138313931613162316331643165316632303231323232333234323532363237323832393261326232633264326532663330333133323333333433353336333733383339336133623363336433653366343034313432343334343435343634373438343934613462346334643465346635303531353235333534353535363537353835393561356235633564356535663630363136323633363436353636363736383639366136623663366436653666373037313732373337343735373637373738373937613762376337643765376638303831383238333834383538363837383838393861386238633864386538663930393139323933393439353936393739383939396139623963396439653966613061316132613361346135613661376138613961616162616361646165616662306231623262336234623562366237623862396261626262636264626562666330633163326333633463356336633763386339636163626363636463656366643064316432643364346435643664376438643964616462646364646465646665306531653265336534653565366537653865396561656265636564656565666630663166326633663466356636663766386639666166626663666466656666"

/// `text` followed by the hexadecimal digits of the bytes `[ix, end)` of
/// `bytes`.
fn hex_from(text: ByteArray, bytes: ByteArray, ix: Int, end: Int) -> ByteArray {
  if ix == end {
    text
  } else {
    hex_from(
      builtin.append_bytearray(
        text,
        builtin.slice_bytearray(
          2 * builtin.index_bytearray(bytes, ix),
          2,
          hex_pairs,
        ),
      ),
      bytes,
      ix + 1,
      end,
    )
  }
}

/// True when `pattern` covers `value`. `value` is an action, a resource or a
/// child pattern.
pub fn covers(pattern: ByteArray, value: ByteArray) -> Bool {
  if pattern == star || pattern == value {
    True
  } else {
    let n = bytearray.length(pattern)
    and {
      ends_with_dot_star(pattern, n),
      bytearray.starts_with(value, bytearray.take(pattern, n - 1)),
      external_scheme_length(pattern) == 0,
      bytearray.take(pattern, 7) != "script:",
    }
  }
}

/// True when a pattern of `patterns` covers `value`.
pub fn covered(patterns: List<ByteArray>, value: ByteArray) -> Bool {
  list.any(patterns, fn(pattern) { covers(pattern, value) })
}

/// True when the `child` list is narrower than the `parent` list: a parent
/// pattern covers each child pattern. A sub-delegation uses it for actions.
pub fn narrower(child: List<ByteArray>, parent: List<ByteArray>) -> Bool {
  list.all(child, fn(pattern) { covered(parent, pattern) })
}

/// True when the `child` resource list is narrower than the `parent` list. A
/// sub-delegation uses it for resources. The `did` patterns of a list are
/// the supplier list. The other patterns are `*`, `script` and `external`
/// patterns.
///
/// - The other patterns of the child follow `narrower`: a parent pattern that
///   is not a `did` pattern covers each of them.
/// - A parent without `did` patterns names no supplier. The child can have
///   any `did` patterns, or none.
/// - A parent with `did` patterns limits the suppliers. The child must have
///   `did` patterns, and each one must equal a `did` pattern of the parent.
///
/// `*` is not a `did` pattern. It never widens a supplier list.
pub fn resources_narrower(
  child: List<ByteArray>,
  parent: List<ByteArray>,
) -> Bool {
  let (child_dids, child_others) = list.partition(child, is_did)
  let (parent_dids, parent_others) = list.partition(parent, is_did)
  and {
    narrower(child_others, parent_others),
    when parent_dids is {
      [] -> True
      _ ->
        when child_dids is {
          [] -> False
          _ -> list.all(child_dids, fn(did) { list.has(parent_dids, did) })
        }
    },
  }
}

// ## Internal helpers

/// The length of the scheme of an `external` (`oauth:`, `mcp:` or
/// `https://`), or 0.
fn external_scheme_length(pattern: ByteArray) -> Int {
  if bytearray.take(pattern, 4) == "mcp:" {
    4
  } else if bytearray.take(pattern, 6) == "oauth:" {
    6
  } else if bytearray.take(pattern, 8) == "https://" {
    8
  } else {
    0
  }
}

/// True when the pattern of length `n` ends with `.*`, after at least one
/// other byte.
fn ends_with_dot_star(pattern: ByteArray, n: Int) -> Bool {
  n >= 3 && bytearray.at(pattern, n - 2) == 46 && bytearray.at(pattern, n - 1) == 42
}

/// True when the bytes `[i, end)` complete `seg *( "." seg )`. The current
/// segment already has `seg_length` bytes before `i`.
fn internal_span(bytes: ByteArray, i: Int, end: Int, seg_length: Int) -> Bool {
  if i == end {
    seg_length > 0
  } else {
    let byte = bytearray.at(bytes, i)
    if byte == 46 {
      seg_length > 0 && internal_span(bytes, i + 1, end, 0)
    } else {
      seg_byte(byte) && internal_span(bytes, i + 1, end, seg_length + 1)
    }
  }
}

/// `%x61-7A / DIGIT / "-"`.
fn seg_byte(byte: Int) -> Bool {
  byte >= 97 && byte <= 122 || byte >= 48 && byte <= 57 || byte == 45
}

/// True when the bytes `[i, end)` are `1*VCHAR` (`%x21-7E`).
fn visible_span(bytes: ByteArray, i: Int, end: Int) -> Bool {
  i < end && all_visible(bytes, i, end)
}

fn all_visible(bytes: ByteArray, i: Int, end: Int) -> Bool {
  if i == end {
    True
  } else {
    let byte = bytearray.at(bytes, i)
    byte >= 33 && byte <= 126 && all_visible(bytes, i + 1, end)
  }
}

/// True when the bytes `[i, end)` are lowercase hexadecimal digits (`0-9`,
/// `a-f`).
fn lowhex_span(bytes: ByteArray, i: Int, end: Int) -> Bool {
  if i == end {
    True
  } else {
    let byte = bytearray.at(bytes, i)
    and {
      byte >= 48 && byte <= 57 || byte >= 97 && byte <= 102,
      lowhex_span(bytes, i + 1, end),
    }
  }
}

// ## Tests

const script_resource: ByteArray =
  "script:e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5"

const did_a: ByteArray =
  "did:vector:a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1"

const did_b: ByteArray =
  "did:vector:b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2"

test valid_action_patterns() {
  list.all(
    [
      "*", "a", "ocr", "ocr.extract.v1", "marketplace.hire.v1", "a-b.c-9",
      "document-extraction", "ocr.*", "a.b-c.*", "oauth:x", "oauth:scope.read",
      "mcp:tools/read", "mcp:tools.*", "https://api.example.com/v1",
      "https://api.example.com/.*",
    ],
    valid_action_pattern,
  )
}

test invalid_action_patterns() {
  list.all(
    [
      "", ".", "a.", ".a", "a..b", "A", "Ocr.extract", "ocr_extract", "ocr*",
      ".*", "*.*", "a.*.*", "a.*b", "oauth:", "mcp:", "https://", "http://x",
      "mcp:a b", "oauth:\n", "ftp:x", script_resource, "a b", "ocr.*.v1",
    ],
    fn(pattern) { !valid_action_pattern(pattern) },
  )
}

test valid_resource_patterns() {
  list.all(
    [
      "*", script_resource, did_a, "https://api.example.com/v1", "oauth:x",
      "mcp:y",
    ],
    valid_resource_pattern,
  )
}

test invalid_resource_patterns() {
  list.all(
    [
      "", "ocr.extract", "ocr.*", "a",
      // 55 hexadecimal digits
      "script:e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e",
      // 57 hexadecimal digits
      "script:e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e",
      // uppercase digits
      "script:E5E5E5E5E5E5E5E5E5E5E5E5E5E5E5E5E5E5E5E5E5E5E5E5E5E5E5E5",
      // a digit outside 0-9 a-f
      "script:g5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5",
      "Script:e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5",
      "https://", "mcp:", "oauth:", "https://a b",
      // did: uppercase digits
      "did:vector:A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1",
      // did: 63 and 65 hexadecimal digits
      "did:vector:a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a",
      "did:vector:a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a",
      // did: a digit outside 0-9 a-f
      "did:vector:a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1g1",
      // did: no scheme, another method, the testnet form, the legacy form
      "vector:a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1",
      "did:web:example.com",
      "did:vector:testnet:a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1",
      "did:vector:agent:e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5:a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1",
      // did: a prefix form
      "did:vector:*",
    ],
    fn(pattern) { !valid_resource_pattern(pattern) },
  )
}

test covers_star_and_exact() {
  and {
    covers("*", "ocr.extract.v1"),
    covers("*", "https://api.example.com/v1"),
    covers("*", script_resource),
    covers("*", "*"),
    covers("ocr.extract.v1", "ocr.extract.v1"),
    covers("document-extraction", "document-extraction"),
    covers(script_resource, script_resource),
    !covers("ocr.extract.v1", "ocr.extract.v2"),
    !covers("ocr.extract", "ocr.extract.v1"),
    !covers("document-extraction", "*"),
  }
}

test covers_prefix() {
  and {
    covers("ocr.*", "ocr.extract"),
    covers("ocr.*", "ocr.extract.v1"),
    covers("marketplace.*", "marketplace.hire.v1"),
    covers("a.b.*", "a.b.c"),
    !covers("ocr.*", "ocr"),
    !covers("ocr.*", "ocrx"),
    !covers("ocr.extract.*", "ocr.other.v1"),
  }
}

/// §12.1 Delegation: `oc.*` treated as covering `ocr.*`.
test covers_oc_prefix_not_ocr() {
  and {
    !covers("oc.*", "ocr.*"),
    !covers("oc.*", "ocr.extract"),
    !covers("oc.*", "ocr"),
    !narrower(["ocr.*"], ["oc.*"]),
    !narrower(["ocr.extract.v1"], ["oc.*"]),
  }
}

/// §12.1 Delegation: an external pattern used as a prefix.
test covers_external_only_exactly() {
  and {
    covers("mcp:tools.*", "mcp:tools.*"),
    !covers("mcp:tools.*", "mcp:tools.read"),
    !covers("oauth:scope.*", "oauth:scope.read"),
    !covers("https://api.example.com/.*", "https://api.example.com/.v1"),
    !covers("https://api.example.com/v1", "https://api.example.com/v1/jobs"),
    !narrower(["mcp:tools.read"], ["mcp:tools.*"]),
    !narrower(["https://api.example.com/.v1"], ["https://api.example.com/.*"]),
  }
}

/// A `did` pattern matches by equality only. `*` still covers a `did`
/// pattern as it covers every value, so the supplier test of a vault payment
/// must not call `covers`.
test covers_did_only_exactly() {
  and {
    covers(did_a, did_a),
    !covers(did_a, did_b),
    !covers(did_a, script_resource),
    !covers(did_a, "*"),
    !covers(script_resource, did_a),
    covers("*", did_a),
  }
}

/// The table of `hex` gives the same two digits as the arithmetic of a digit
/// for each of the 256 byte values.
test hex_writes_every_byte() {
  list.all(
    list.range(0, 255),
    fn(byte) {
      hex(bytearray.push(#"", byte)) == bytearray.push(
        bytearray.push(#"", digit(byte % 16)),
        digit(byte / 16),
      )
    },
  )
}

fn digit(n: Int) -> Int {
  if n < 10 {
    n + 48
  } else {
    n + 87
  }
}

test narrower_lists() {
  and {
    narrower(["ocr.extract.v1"], ["ocr.*"]),
    narrower(["ocr.extract.*"], ["ocr.*"]),
    narrower(["ocr.*"], ["ocr.*"]),
    narrower(["ocr.*", "marketplace.hire.v1"], ["marketplace.*", "ocr.*"]),
    narrower(["*"], ["*"]),
    narrower(["ocr.*", "oauth:x"], ["*"]),
    narrower([], ["ocr.*"]),
    narrower([], []),
    !narrower(["*"], ["ocr.*"]),
    !narrower(["ocr.*"], ["ocr.extract.*"]),
    !narrower(["ocr.*"], ["ocr.extract.v1"]),
    !narrower(["ocr.extract.v1", "ocr.x"], ["ocr.extract.v1"]),
    !narrower(["ocr.extract.v1"], []),
    !narrower([script_resource], ["https://api.example.com/v1"]),
  }
}
