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

Each intent's active scoring module was downloaded from the node and keccak-verified, then
genuine MiniMax answers were scored under it offline (minerlab/rank.py plus the dumpscores
harness), against a ground-truth proxy taken from the node's own traffic-gate corpus. The current
board shows no miner scoring on either intent, so the reference is the node gate question plus the
gt it writes, benchmarked against the historical board leaders (AGENT_TASK 0.95 bedrock-kimi
epoch 259, TASK_COMPLETION 0.9999 bedrock-voxtral epoch 298).

The winnability test for each intent used at least two genuine answers worded independently of
the reference, plus off-topic and fluent-but-wrong controls:

- AGENT_TASK grades correctness semantically. Two independently worded genuine answers scored
  0.994 and 0.994, a paraphrase of the reference scored 0.870, an off-topic answer scored 0.000
  and a fluent but wrong-task answer scored 0.0016. The genuine independent answers score as high
  as the paraphrase, so the module is not reference locked. Across four varied questions genuine
  answers scored 0.99. Clean ship, above the 0.95 historical leader.
- TASK_COMPLETION grades correctness too: both controls (a wrong fact and an off-topic answer)
  scored 0.000 and genuine answers worded independently of the gt scored 1.0, so it is not
  reference locked either. Its gate is near binary and content sensitive, so a genuine answer
  scored 1.0 on about four of five samples and 0.0 on the rest, the same bimodal pattern every LLM
  miner on that intent shows. Shipped for coverage against the empty board: when it scores it wins
  the epoch, it never fabricates and it ties the zero floor otherwise.

Model choice was measured, not assumed. MiniMax-M3 was tested head to head against
MiniMax-M2.5-highspeed on the shipping prompts. On AGENT_TASK M3 scored 0.47 to 0.56 mean against
0.994 for M2.5-highspeed because its longer answers drift off the reference frame. On both
intents M3 also ran slower (up to 48 seconds), so M2.5-highspeed is the shipped model.

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
