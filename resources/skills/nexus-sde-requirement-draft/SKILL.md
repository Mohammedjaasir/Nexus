---
name: nexus-sde-requirement-draft
description: Draft a requirement with a clear title and testable acceptance criteria, saved as a draft for the user to review and promote.
version: 1
---

# Draft a requirement

A requirement says what a change must achieve, in words a reviewer can check.
Nexus validates its shape (the `req.schema` check) and the user decides whether
it becomes the requirement the work follows. This turn drafts; it never
promotes.

## The shape

Save the draft with the `requirement_draft` tool:

- `title`: one line, at most 200 characters, naming the outcome (not the
  implementation). Example: "Users can reset a forgotten password by email".
- `body` (optional): the context. Who needs it, what happens today, what is out
  of scope, and any constraint the user stated. Plain Markdown, no secrets.
- `criteria`: at least one acceptance criterion, each with a short stable `id`
  (`AC1`, `AC2`, ...) and a `text` that can be checked by a test or a
  demonstration.
- `clientKey`: a key you reuse if you retry, so a retry never makes a second
  draft.

## Good acceptance criteria

- One observable behaviour per criterion: given a starting state, when
  something happens, then a result can be seen.
- Concrete values instead of words like "fast", "secure" or "user-friendly".
  If a number is needed and unknown, say it is to be decided.
- Cover the error cases the user mentioned, not only the happy path.
- No implementation details (no file names, function names or libraries)
  unless the user required them.

## Steps

1. Call `context_get` and read what the user asked for, any earlier
   requirement and any review comments.
2. List what is unclear. If something essential is missing, write the
   criterion with the open question stated plainly instead of guessing.
3. Draft the title, body and criteria, then save them with
   `requirement_draft`.
4. If the draft is refused, read the reason, correct the shape and save again
   with the same `clientKey`.
5. Tell the user in one or two sentences what the draft covers and what is
   still open.
