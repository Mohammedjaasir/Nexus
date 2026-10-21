---
name: nexus-sde-tests-first
description: Write or update the tests that pin a change before changing the code, using the repository's own test runner, so Nexus's test check has real evidence to judge.
version: 1
---

# Write or update tests first

A change to behaviour is proven by a test that fails before the change and
passes after it. Nexus judges a change set by running the repository's tests on
its head commit (the `cs.tests_pass` check); a change with no test that covers
it gives that check nothing to stand on.

## Steps

1. Find the test runner the repository already uses: `node:test`, jest, vitest
   or mocha for Node projects, pytest for Python projects. Use it; do not add a
   new framework.
2. Find where similar tests live and how they are named. Put the new test next
   to them, following the same pattern.
3. Write a test for each acceptance criterion the change touches. Name the test
   after the behaviour, and mention the criterion id in the name or a comment
   when the requirement has one.
4. Run only the new tests with `sandbox_exec` and confirm they fail for the
   expected reason (the behaviour is missing), not for a typo or an import
   error.
5. Change the code until the new tests pass, then run the whole suite to check
   nothing else broke.
6. When fixing a defect, first write a test that reproduces it.

## Good tests

- Test behaviour through the public interface, not private details.
- Keep each test independent: no order dependence, no shared mutable state.
- No network, no real clock, no randomness without a fixed seed. The container
  has no network, so a test that needs one fails.
- Assert exact values. A test that only checks "no error was thrown" proves
  little.
- Never skip, delete or weaken an existing test to make the suite pass. If an
  existing test is wrong, say so in the change message and explain why.

## What not to do

- Do not mark a test as skipped or todo to hide a failure.
- Do not change the test runner's configuration to report success.
- Do not leave debugging output or focused-only markers (`.only`) behind.
