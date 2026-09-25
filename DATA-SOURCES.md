# Data sources

This miner does not read a public data feed. Every answer it serves is produced by a language
model, MiniMax, called once per request. This file records what the model provides, under what
plan, what its terms say about output ownership and commercial use and what is still open.

Two rules were followed in writing it. A licence or a terms clause is only recorded when the
provider's own page was read. Where a page could not be read that is stated as unverified
rather than guessed. And the model was called from the same request path the miner uses before
it went in.

This is also the one deliberate exception to the keyless rule the other wire miners follow. It
is a probe: the point is to show that a genuinely correct language-model answer scores on the
model-judged task intents, so it calls a keyed provider we hold a commercial plan for rather
than a free public feed.

| Host | Provides | Plan | Output ownership | Commercial use | Rate limit |
| --- | --- | --- | --- | --- | --- |
| api.minimax.io | MiniMax-M2.5-highspeed answers for AGENT_TASK and TASK_COMPLETION | Paid commercial MiniMax plan held by the operator, key as a Cloudflare secret | User keeps ownership of generated content per MiniMax's readable consumer terms, but the exact paid Open Platform clause could not be read (unverified, open item) | Not confirmed for the paid API surface, see the open item below | Governed by the paid plan, not published as a fixed public number; this miner declares 2 requests per second and makes one model call per request |

## Per source

### api.minimax.io (MiniMax API, Open Platform)

The language-model answer for both intents. One call to MiniMax-M2.5-highspeed with a tight
per-intent system prompt, at request time. The model emits a reasoning block before its answer,
which the worker strips, returning only the answer as the summary the node grades.

Plan: a paid commercial MiniMax plan held by the operator. The key is a Cloudflare secret set
with `wrangler secret put MINIMAX_API_KEY` and read as env.MINIMAX_API_KEY. It is never written
into worker.js, wrangler.toml, a descriptor, this file or any other file in the repo.

What the readable terms say: MiniMax's consumer App and Web Terms of Service state "We do not
claim ownership of User Contributions or User Generated Content" and separately "These Terms of
Use permit you to use the Services for your personal, non-commercial use only". Those two lines
are from the consumer surface, not the paid API Open Platform, so the non-commercial limit is a
consumer-app limit rather than a limit on the paid API.

Commercial use: not confirmed for the paid API surface. The Open Platform terms page
(https://platform.minimax.io/protocol/user-agreement) is client-rendered and returned no text
to a server fetch, so the clause that governs output ownership and commercial reuse on the paid
plan could not be quoted.

Credit line published in every answer:

    Answer produced with MiniMax (MiniMax-M2.5-highspeed) under a commercial MiniMax plan held by zkasuran.

## What was measured before shipping

Each intent's active scoring module was downloaded from the node and keccak-verified, then a
genuine MiniMax answer was scored under it offline (minerlab/rank.py plus the dumpscores
harness), against a leader proxy taken from the node's own traffic-gate corpus. The live board
for both intents currently has zero active miners, so there is no capturable live-leader answer;
the proxy is the node gate question plus the gt it writes.

- AGENT_TASK grades correctness semantically. Genuine plans scored 0.83 to 0.99, an off-topic
  answer scored 0.0001. A differently worded correct plan still scores, so it is not
  reference-phrasing locked. This intent is a clean ship.
- TASK_COMPLETION grades correctness too: a wrong answer scores 0.0 every time and a correct
  answer worded independently of the gt scores about 1.0, so it is not reference-phrasing locked
  either. Its gate is near binary and content sensitive though, so a genuine answer scored about
  1.0 on roughly half of sampled epochs and 0.0 on the rest, with no reliable format rule. It is
  shipped for coverage against the empty board: when it scores it wins the epoch, it never
  fabricates and it ties the zero floor otherwise.

## Compliance

Met:

- The key is held as a Cloudflare secret and appears in no file in the repo.
- The credit line naming MiniMax as the source travels in every answer and in NOTICE.
- Every answer is a live model call at request time, with a short per-isolate memo only.
- Every error path and empty input answers 200, so the node never reads a non-answer.

Open:

- The exact MiniMax API (Open Platform) clause on output ownership and commercial reuse under
  the paid plan is unverified, because the platform terms page is client-rendered and could not
  be read by a server fetch. Confirm that clause for the paid plan before this miner is
  registered to sell answers. Until then this stays a probe. The answers score; the licence
  clause is the item to close.
