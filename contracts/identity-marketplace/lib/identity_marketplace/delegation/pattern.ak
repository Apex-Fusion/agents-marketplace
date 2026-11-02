//// Action and resource patterns of delegations: Part 2 §5.1 of
//// `docs/IDENTITY_REGISTRY.md`.
////
//// ```abnf
//// action           = internal / external
//// resource         = script / external
//// action-pattern   = "*" / internal / prefix / external
//// resource-pattern = "*" / script / external
//// internal         = seg *( "." seg )
//// prefix           = seg *( "." seg ) ".*"
//// seg              = 1*( %x61-7A / DIGIT / "-" )
//// external         = ( %s"oauth:" / %s"mcp:" / %s"https://" ) 1*VCHAR
//// script           = %s"script:" 56lowhex
//// ```
////
//// Coverage: a pattern `p` covers a value `a` when `p = "*"`, or `p = a`, or
//// `p = x ".*"` (a `prefix`) and `a` starts with `x "."`. External and script
//// patterns match only exactly.
////
//// The same rule decides whether a parent pattern covers a child pattern. A
//// child `x.*` is then covered only by `*`, by `x.*` itself, or by a parent
//// `y.*` where `x` starts with `y "."`. A child `*` is covered only by `*`. A
//// plain string-prefix test is wrong: `oc.*` does not cover `ocr.*`.
////
//// `covers` trusts that its pattern follows the grammar. The delegation
//// contract checks the grammar of every pattern when it mints a delegation,
//// and a delegation output never changes.

use aiken/collection/list
use aiken/primitive/bytearray

/// The pattern that covers every value.
pub const star: ByteArray = "*"

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
    } else {
      and {
        n == 63,
        bytearray.take(pattern, 7) == "script:",
        lowhex_span(pattern, 7, n),
      }
    }
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
/// pattern covers each child pattern.
pub fn narrower(child: List<ByteArray>, parent: List<ByteArray>) -> Bool {
  list.all(child, fn(pattern) { covered(parent, pattern) })
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
    ["*", script_resource, "https://api.example.com/v1", "oauth:x", "mcp:y"],
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
