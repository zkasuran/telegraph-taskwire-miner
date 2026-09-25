# TaskWire agent-task miner for Telegraph

One Cloudflare Worker that answers the model-judged Telegraph task intents by calling a language
model at request time and returning its answer as the graded summary.

| Intent | Endpoint | Descriptor id | The answer is |
| --- | --- | --- | --- |
| AGENT_TASK | `/agent-task` | 7426 | the concrete end-to-end plan an agent should follow to carry out the task |
| TASK_COMPLETION | `/task-complete` | 7427 | the finished result or the full sequence of steps that completes the task |

These are the model-judged tier of the network (Tier B, LLM-judge). The node writes its own
ground truth for each one with a model. The live scoring module grades the summary against
it. The question is a described multi-step task, which a reasoning language model answers
directly with no external tools. This miner produces that answer with MiniMax rather than
guessing a shape.

## The model source

Every answer is one call to `MiniMax-M2.5-highspeed` on the MiniMax API. This miner is **not
keyless**, which is the one deliberate exception to the rule the other wire miners follow. It
runs under a paid commercial MiniMax plan held by the operator. The key is a Cloudflare secret:

- the worker reads it as `env.MINIMAX_API_KEY`
- it is never written into `worker.js`, `wrangler.toml`, a descriptor, this README or any other
  file in this repo

The model terms, the plan and the one open licensing item are in `NOTICE` and `DATA-SOURCES.md`.

## Endpoints

Each route takes the task or the whole question on the query string. The bare route is declared,
never a template, so the node's exact-path match always lands.

```
GET /agent-task?task=<the described task or the whole question>
GET /task-complete?task=<the task to complete or the whole question>
```

The task is read from the first non-empty of `question`, `query`, `q`, `text`, `input`,
`content`, `task`, `goal` and `instruction`, so passing the whole question works as well as
passing the task alone.

```
GET /health      the intents served and whether the key is configured
GET /__last      the last few requests, for diagnostics
GET /            a usage summary
```

## The response

```json
{
  "intent": "AGENT_TASK",
  "headline": "Authenticate the customer and load the order.",
  "summary": "Authenticate the customer and load the order; verify the item is within the refund window; calculate the refund; issue it through the original processor; update the records; email a confirmation; log the action for audit.",
  "confidence": 0.95,
  "model": "MiniMax-M2.5-highspeed",
  "source": "MiniMax language model",
  "attribution": "Answer produced with MiniMax (MiniMax-M2.5-highspeed) under a commercial MiniMax plan held by zkasuran.",
  "as_of": "2026-09-26T00:00:00.000Z"
}
```

The node grades the `summary` field, so the descriptors set `label_field: summary`. The
`headline` field is a convenience sibling for a reader.

## Never a non-200 on a declared route

The node reads any 4xx or 5xx on a declared route as no answer and zeroes the whole epoch. So
every path answers 200: a missing input returns an honest note at confidence 0.2. A missing key,
a model error or a timeout returns a plain statement that the answer could not be produced, also
at low confidence. Only an undeclared path returns 404.

## Deploy

The worker itself needs no build. Two steps:

```bash
wrangler deploy
wrangler secret put MINIMAX_API_KEY      # paste the key when prompted, once
```

The secret is set on the deployed worker, not in this repo. `GET /health` reports
`key_configured` so you can confirm it landed without exposing the value.

## Verified before ship

Each intent's active scoring module was downloaded from the node and keccak-verified, then a
genuine MiniMax answer was scored under it offline with `work/telegraph/minerlab/rank.py` and the
dumpscores harness. The live board for both intents currently has zero active miners, so there is
no capturable live-leader answer; the reference is the node's own traffic-gate question plus the
ground truth it writes. Both modules grade correctness: an off-topic answer scores about zero,
and a correct answer worded independently of the reference still scores, so neither is
reference-phrasing locked.

| Intent | Genuine MiniMax answer | Off-topic answer | Behaviour |
| --- | --- | --- | --- |
| AGENT_TASK | 0.965, 0.993 and 0.834 to 0.993 across wordings on covered questions | 0.0001 | continuous semantic scorer, rewards a complete on-aspect plan |
| TASK_COMPLETION | about 1.0 on roughly half of sampled genuine answers, 0.0 on the rest | 0.0 | near-binary content-sensitive gate |

AGENT_TASK is a clean semantic scorer: a complete plan that covers the aspects the reference
covers scores 0.96 to 0.99, a plan that emphasises different aspects or is cut short scores
lower. An off-topic answer scores about zero. It is shipped as a real answer that wins when
it is complete and on aspect.

TASK_COMPLETION grades correctness the same way (a wrong answer always scores 0) but its gate is
near binary and content sensitive: a genuine answer scored about 1.0 on roughly half of the
sampled epochs and 0.0 on the rest, with no reliable format rule. It is shipped for coverage
against the empty board. When it scores it wins the epoch outright, it never fabricates and it
ties the zero floor otherwise.

MiniMax-M2.5-highspeed writes a reasoning block before its answer and was measured at 4 to 15
seconds per call, so the worker's request timeout is 20 seconds and `max_tokens` is 1200 so the
full plan survives the reasoning block. At 1000 tokens a longer plan was occasionally cut short,
which the module scored down, so the ceiling was raised for these longer answers while staying
inside the 20 second budget.

## Licence and data terms

- `LICENSE`: Source-Available No-Derivatives 1.0. Read it, audit it, run your own instance,
  publish what you find. Do not redistribute it or redeploy it as a competing miner. Calling the
  live endpoint is not restricted.
- `NOTICE` and `DATA-SOURCES.md`: the MiniMax terms, the paid plan, the credit line carried in
  every answer and the one open item (the paid Open Platform output-ownership clause could not be
  read from the client-rendered terms page, so it is recorded as unverified).

AI note: the answers this miner serves are produced by MiniMax. That is the whole design and it
is stated in every response, in `NOTICE` and here.
