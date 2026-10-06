# Security policy

## Reporting a vulnerability

Please report security problems privately, not in a public issue.

- Email: `info@chartrunner.xyz`
- Or use GitHub's "Report a vulnerability" button on this repository (private vulnerability reporting), if it is enabled.

Include what you found, how to reproduce it, and what you think the impact is. We will acknowledge the report, keep you
updated, and credit you in the fix unless you prefer otherwise.

## What is in scope

- `@chartrunner/verify` reporting "verified" for data, a memo or a transaction that does not satisfy SPEC.md.
- The verifier treating an RPC outage, a failed transaction, a missing memo or a wrong fee payer as anything other than
  a failure.
- A difference between SPEC.md, the golden vectors and the library that lets two parties compute different roots for
  the same rows.
- Anything in this repository or its CI that could leak a secret or let a third party publish code under this name.

## What is out of scope

- The ChartRunner app and its servers (report those through the same contact, but they are not code in this repository).
- The limits listed in SPEC.md section 8 ("what it does not prove"). They are documented properties of the format, not
  vulnerabilities.
- Results from an RPC endpoint you chose and do not trust.

## Keys

This repository contains no private keys, operator keys or API tokens and never needs any. If you find one, report it
as a vulnerability.
