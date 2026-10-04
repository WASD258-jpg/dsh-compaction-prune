#!/usr/bin/env bash
# Verify the rewritten CI step body before pushing it.
#
# Run exactly the block that will go into the workflow, plus a negative control:
# a suite that DOES emit a marker must make it fail. A check that cannot fail is
# not a check.

set +e
cd "$(dirname "$0")/.." || exit 2

echo "=== positive: the real suites must all pass ==="
fail=0
found=0
for t in tests/*.spec.mjs; do
  if [ ! -f "$t" ]; then
    echo "no test suites matched $t"
    exit 1
  fi
  found=$((found + 1))
  out=$(node "$t" 2>&1)
  code=$?
  if [ "$code" -ne 0 ]; then
    echo "== $t exited $code =="
    echo "$out" | tail -20
    fail=1
    continue
  fi
  if printf '%s\n' "$out" | grep -qE '\[PROBLEM\]|\[FAIL\]|WRONGLY ACCEPTED'; then
    echo "== $t reported a problem =="
    printf '%s\n' "$out" | grep -E '\[PROBLEM\]|\[FAIL\]|WRONGLY ACCEPTED'
    fail=1
  fi
done
echo "checked $found suite(s), fail=$fail"
echo ""

echo "=== negative control: a marker in the output MUST fail the step ==="
tmp=$(mktemp -d)
printf 'console.log("[FAIL] synthetic marker")\n' > "$tmp/synthetic.spec.mjs"
negfail=0
for t in "$tmp"/*.spec.mjs; do
  out=$(node "$t" 2>&1 || true)
  if printf '%s\n' "$out" | grep -qE '\[PROBLEM\]|\[FAIL\]|WRONGLY ACCEPTED'; then
    negfail=1
  fi
done
rm -rf "$tmp"
if [ "$negfail" -eq 1 ]; then
  echo "negative control behaves correctly (a marker was detected)"
else
  echo "NEGATIVE CONTROL FAILED: a synthetic marker went undetected"
  exit 1
fi
echo ""

echo "=== negative control 2: a non-zero exit MUST fail the step ==="
tmp2=$(mktemp -d)
printf 'process.exit(3)\n' > "$tmp2/failing.spec.mjs"
exfail=0
for t in "$tmp2"/*.spec.mjs; do
  out=$(node "$t" 2>&1)
  code=$?
  if [ "$code" -ne 0 ]; then exfail=1; fi
done
rm -rf "$tmp2"
if [ "$exfail" -eq 1 ]; then
  echo "negative control behaves correctly (a non-zero exit was detected)"
else
  echo "NEGATIVE CONTROL FAILED: a non-zero exit went undetected"
  exit 1
fi

if [ "$fail" -eq 0 ]; then
  echo ""
  echo "PREFLIGHT PASS — the rewritten step is correct and still detects defects"
  exit 0
fi
exit 1
