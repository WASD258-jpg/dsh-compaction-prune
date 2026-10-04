#!/usr/bin/env bash
# Local mirror of the CI step "Test suites fail loudly on a positive problem marker".
#
# The CI run failed here while the same suites pass locally. The hypothesis is
# that GitHub's default `bash -e` aborts the script when `grep -q` finds nothing,
# which would make the step fail on a healthy repository. Reproduce it exactly,
# with and without -e, to tell the two apart.

cd "$(dirname "$0")" || exit 2

echo "=== A: exactly as CI runs it (bash -e) ==="
bash -e -c '
  fail=0
  for t in tests/*.spec.mjs; do
    out=$(node "$t" 2>&1)
    if echo "$out" | grep -qE "\[PROBLEM\]|\[FAIL\]|WRONGLY ACCEPTED"; then
      echo "  == $t reported a problem =="
      fail=1
    else
      echo "  ok $t"
    fi
  done
  exit $fail
'
echo "A exit=$?"
echo ""

echo "=== B: same, but with the grep guarded ==="
bash -c '
  fail=0
  for t in tests/*.spec.mjs; do
    out=$(node "$t" 2>&1)
    if echo "$out" | grep -qE "\[PROBLEM\]|\[FAIL\]|WRONGLY ACCEPTED"; then
      echo "  == $t reported a problem =="
      fail=1
    else
      echo "  ok $t"
    fi
  done
  exit $fail
'
echo "B exit=$?"
echo ""

echo "=== C: does any suite actually emit a marker? ==="
for t in tests/*.spec.mjs; do
  n=$(node "$t" 2>&1 | grep -cE '\[PROBLEM\]|\[FAIL\]|WRONGLY ACCEPTED' || true)
  echo "  $t -> $n marker(s)"
done
