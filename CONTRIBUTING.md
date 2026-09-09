# Contributing

This repository is a **specification draft**. There is no code, and code is not what it needs right now.

## Where to put things

| You want to | Use |
|---|---|
| Argue with a design decision | **Discussions → Ideas**, citing the SPEC section number |
| Ask how something is meant to work | **Discussions → Q&A** |
| Report that the spec text is wrong, contradictory or unclear | **Issues** |
| Say you'd run a node, and on what terms | **Discussions → Show and tell** |

Issues are for defects in the document. Discussions are for the design. Keeping them apart is what stops the issue tracker becoming a debate club before v1 is frozen.

## What is most useful

1. Attacks on [SPEC §3](SPEC.md#3-threat-model-and-trust-assumptions). The threat model is the load-bearing section; if it is wrong, everything downstream is decoration.
2. A CKB script author's read of [SPEC §4](SPEC.md#4-conditions) — the `type-id` and `median_time` assumptions in particular.
3. Node operator reality checks on [SPEC §11](SPEC.md#11-economics). The fee numbers are a proposal, not a finding.
4. Anything you know about why Sarcophagus wound down, especially first-hand ([SPEC §12.2](SPEC.md#122-sarcophagus)).

## House style for the spec

- Every section is numbered and stays numbered. Renumbering breaks every citation ever made.
- Decisions are stated with the reason attached. "We use X" without "because Y" gets reopened every six months.
- Limitations go in the spec, not in a FAQ. [§3.2](SPEC.md#32-what-crt-does-not-defend-against) and [§12.2](SPEC.md#122-sarcophagus) are the honest parts and they stay honest.
- `TODO:` markers in HTML comments mark things that must be resolved before the tag is cut.

## Pull requests

Against `SPEC.md`, only after the change has been discussed. A PR that changes a design decision without a linked discussion will be closed with a pointer to this line.
