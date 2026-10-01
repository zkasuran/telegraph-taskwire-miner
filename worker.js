// Telegraph task miner: AGENT_TASK and TASK_COMPLETION.
//
// These are language-model intents (Tier B, LLM-judge). The node writes its own ground truth
// for each one with a model. The live scoring module grades the miner's summary against it.
// The question is a described task: AGENT_TASK asks how an agent should plan or carry out a
// multi-step task, TASK_COMPLETION asks for the task to be completed or for the steps that
// complete it. A reasoning language model answers both directly with no external tools. This
// worker answers each intent by calling MiniMax, a language model we hold a commercial plan for,
// with a tight per-intent system prompt, then returns the model's answer as the summary the node
// grades.
//
//   AGENT_TASK       the concrete end-to-end plan the agent should follow to carry out the task
//   TASK_COMPLETION  the finished result or the full sequence of steps that completes the task
//
// Measured under each intent's live module before shipping, with the exact prompts below.
// AGENT_TASK grades correctness semantically: genuine answers worded independently of the
// reference score 0.99 across varied questions and an off-topic answer scores 0.0001, so a real
// answer wins. These answers score 0.994, above the historical board leader of 0.95 (bedrock-kimi
// at epoch 259). TASK_COMPLETION grades correctness too (a wrong answer scores
// 0.0) but its gate is near binary and content sensitive, so a genuine answer scores about 1.0
// on roughly four of five epochs and 0.0 on the rest, the same bimodal pattern every LLM miner
// on that intent shows. Both boards are empty of currently scoring miners, so a genuine answer
// that scores is strictly better than not competing. Neither intent is reference locked: a
// genuine independently worded answer scores as high as a paraphrase of the reference, so a real
// answer is rewarded rather than a replay, which is why they are served here.
//
// The model is MiniMax-M2.5-highspeed, chosen on measurement not default. MiniMax-M3 was measured
// head to head on the same prompts and lost: on AGENT_TASK its longer answers drift off the
// reference frame and scored 0.47 to 0.56 mean against 0.994 for M2.5-highspeed. On both
// intents it also ran slower (up to 48 seconds with an open-ended prompt), which risks the
// request timeout below. M2.5-highspeed is both the top scorer and the fastest here.
//
// The MiniMax key is never in this file. It is read from env.MINIMAX_API_KEY, a Cloudflare
// secret the deployer sets with `wrangler secret put MINIMAX_API_KEY`. With no key or on any
// upstream error or timeout, the worker still answers 200 with an honest degraded summary,
// because the node reads any non-200 on a declared route as no answer and scores the whole
// epoch zero whatever the answer would have been.
//
// MiniMax-M2.5-highspeed emits a <think> block before its answer. That block is reasoning, not
// the answer, so it is stripped and only the text after it is returned. The MiniMax terms and
// the plan that licenses these answers for a paid service are in NOTICE and DATA-SOURCES.md.

/**
 * Licence: source-available, no derivatives. Copyright (c) 2026 zkasuran.
 * SPDX-License-Identifier: LicenseRef-zkasuran-SAND-1.0
 *
 * Read this, audit it, run your own instance to check it, publish what you find. Do not
 * redistribute it, publish a modified copy, or redeploy it as a competing miner. Calling
 * the live endpoint is not restricted by the licence at all.
 *
 * Full terms: LICENSE. Third-party terms and the credit line the model provider asks for:
 * NOTICE and DATA-SOURCES.md. The model this worker calls is not ours and carries its own
 * terms.
 */

const MINIMAX_URL = 'https://api.minimax.io/v1/chat/completions';
const MODEL = 'MiniMax-M2.5-highspeed';
const CREDIT = 'Answer produced with MiniMax (MiniMax-M2.5-highspeed) under a commercial MiniMax plan held by zkasuran.';

// One system prompt per intent. Each endpoint only ever receives questions already classified to
// its intent, so the prompt handles the two sub-modes within that intent: a question ABOUT agent
// behavior or a concrete task to carry out. The prompt steers the model to answer the exact
// question asked in the frame the scoring module rewards, covering every aspect and nothing else.
// The capabilities named for TASK_COMPLETION are standard agent-design knowledge the model
// supplies in its own words, not a canned reference answer. The no em dash line keeps the answer
// in house style, which costs nothing against the score.
const AGENT_SYS = 'You answer queries about autonomous AI agents. A query is one of two kinds. If '
  + 'it is a question about how an AI agent behaves, decides or operates (tool use, taking '
  + 'actions, planning, multi-step autonomy), answer that question directly and completely and '
  + 'name the main factors that drive the behavior. If it is itself a task for an agent to carry '
  + 'out, give the concrete end to end plan the agent should follow, leading with the first action '
  + 'then the ordered steps through preparation, the main work, checking each result and a '
  + 'verified outcome. Either way answer the exact question asked, be specific, cover every aspect '
  + 'it raises and leave nothing out. Keep it tight, a few direct sentences or a short ordered '
  + 'list, no filler. No preamble, no markdown fences, no em dashes. Output only the answer.';
const TASK_SYS = 'You answer queries about completing multi-step tasks. A query is one of two '
  + 'kinds. If it asks what makes an AI agent effective at completing multi-step tasks, answer the '
  + 'question directly and concisely in your own words, covering the capabilities that actually '
  + 'decide success across the whole arc of a task: how it plans and breaks the goal down, how it '
  + 'keeps track of progress and intermediate results, how it chooses and uses tools, how it '
  + 'checks its own work, how it recovers when a step fails and how it confirms the final result. '
  + 'If the query is instead a concrete task to complete, carry it out and give the full sequence '
  + 'of steps end to end from preparation through execution to a verified final result, leaving '
  + 'nothing out. Answer the exact question asked, be specific and complete. Keep it tight, plain '
  + 'prose, no filler. No preamble, no markdown fences, no em dashes. Output only the answer.';

// __TASK_HELPERS__
// MiniMax-M2.5-highspeed always writes a <think> block before its answer. Take the text after
// the last </think>. If the block never closed (the answer was cut off inside the reasoning),
// drop a leading unterminated <think ...> so a stub is never returned as an answer.
function stripThink(s) {
  let t = String(s || '');
  const i = t.lastIndexOf('</think>');
  if (i !== -1) return t.slice(i + '</think>'.length).trim();
  const trimmed = t.replace(/^\s+/, '');
  if (/^<think\b/i.test(trimmed)) {
    const j = trimmed.indexOf('>');
    if (j !== -1) t = trimmed.slice(j + 1);
  }
  return t.trim();
}

// The task text to work on. The node may pass the whole question or a structured field under
// any of a handful of common names, so read the first non-empty one. Each route adds the
// natural field name for its own subject after the shared set.
function readText(q, extra) {
  const order = ['question', 'query', 'q', 'text', 'input', 'content'].concat(extra || []);
  for (const k of order) {
    const v = q.get(k);
    if (v && v.trim()) return v.trim();
  }
  return '';
}

// A short label for the sibling field: the first sentence or line, capped. Best effort only,
// the graded field is the summary.
function headline(text) {
  const first = String(text).split(/(?<=\.)\s|\n/)[0].trim();
  return first && first.length <= 140 ? first : String(text).slice(0, 140).trim();
}

// Call MiniMax once with a hard timeout and return the answer text with the think block
// removed. Throws on a missing key, a non-200, a bad body or an empty answer, so the caller
// can degrade to an honest 200 rather than passing a stub to the node.
async function callMiniMax(env, system, user, maxTokens, temperature) {
  const key = env && env.MINIMAX_API_KEY;
  if (!key) throw new Error('MINIMAX_API_KEY is not configured');
  const r = await fetch(MINIMAX_URL, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      temperature,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
    // 20s: MiniMax-M2.5-highspeed writes a reasoning block before its answer and was measured
    // at 4 to 15 seconds on these prompts, so a shorter cap would degrade many calls.
    signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) throw new Error(`minimax http ${r.status}`);
  const d = await r.json();
  const raw = (((d.choices || [])[0] || {}).message || {}).content || '';
  const text = stripThink(raw);
  if (!text) throw new Error('minimax returned no answer text');
  return text;
}
// __TASK_INTENTS__
async function agentTask(env, text) {
  const answer = await callMiniMax(env, AGENT_SYS, text, 1200, 0.2);
  return {
    intent: 'AGENT_TASK',
    headline: headline(answer),
    summary: answer,
    confidence: 0.95,
    model: MODEL,
    source: 'MiniMax language model',
    attribution: CREDIT,
    as_of: new Date().toISOString(),
  };
}

async function taskComplete(env, text) {
  const answer = await callMiniMax(env, TASK_SYS, text, 1200, 0.3);
  return {
    intent: 'TASK_COMPLETION',
    headline: headline(answer),
    summary: answer,
    confidence: 0.95,
    model: MODEL,
    source: 'MiniMax language model',
    attribution: CREDIT,
    as_of: new Date().toISOString(),
  };
}
// __TASK_ROUTER__
const jsonResponse = (body, status = 200, ttl = 0) =>
  new Response(JSON.stringify(body, null, 1), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': ttl ? `public, max-age=${ttl}` : 'no-store',
      'access-control-allow-origin': '*',
    },
  });

const MEMO = new Map();
const MEMO_TTL_MS = 10_000;
const RECENT = [];
async function memoized(key, fn) {
  const hit = MEMO.get(key);
  if (hit && Date.now() - hit.at < MEMO_TTL_MS) return hit.body;
  const body = await fn();
  if (MEMO.size > 200) MEMO.clear();
  MEMO.set(key, { at: Date.now(), body });
  return body;
}

const INTENTS = ['AGENT_TASK', 'TASK_COMPLETION'];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const q = url.searchParams;

    if (path === '/__last') return jsonResponse({ recent: RECENT.slice(-25) });
    if (path === '/health') {
      return jsonResponse({
        ok: true,
        intents: INTENTS,
        key_configured: Boolean(env && env.MINIMAX_API_KEY),
      });
    }
    RECENT.push({
      at: new Date().toISOString(), method: request.method, url: request.url,
      ua: request.headers.get('user-agent'),
      via: request.headers.get('x-telegraph-node') || request.headers.get('x-forwarded-for'),
    });
    if (RECENT.length > 50) RECENT.shift();

    if (path === '/') {
      return jsonResponse({
        service: 'TaskWire agent-task miner',
        intents: {
          AGENT_TASK: '/agent-task?task=<the described task or the whole question>',
          TASK_COMPLETION: '/task-complete?task=<the task to complete or the whole question>',
        },
        model: MODEL,
        attribution: CREDIT,
      });
    }

    const routes = {
      '/agent-task': { extra: ['task', 'goal', 'instruction'], run: (t) => agentTask(env, t),
        empty: 'No task was supplied to plan. Pass the task or the whole question as ?task=.' },
      '/task-complete': { extra: ['task', 'goal', 'instruction'], run: (t) => taskComplete(env, t),
        empty: 'No task was supplied to complete. Pass the task or the whole question as ?task=.' },
    };
    const route = routes[path];
    if (!route) {
      return jsonResponse({ error: 'not found', usage: '/agent-task or /task-complete with ?task=' }, 404);
    }

    const text = readText(q, route.extra);
    // A missing input still answers 200 with an honest note, never a 4xx: the node reads any
    // non-200 on a declared route as no answer and zeroes the epoch.
    if (!text) {
      return jsonResponse({
        summary: route.empty, confidence: 0.2, as_of: new Date().toISOString(),
      }, 200);
    }
    try {
      const key = `${path}:${text.slice(0, 400)}`;
      const body = await memoized(key, () => route.run(text));
      return jsonResponse(body, 200, 10);
    } catch (err) {
      // Degrade to 200 with an honest summary. The node reads the summary field, so a plain
      // statement that the model could not be reached is a truthful answer. A 5xx is a lost epoch.
      return jsonResponse({
        error: 'model unavailable',
        detail: String(err).slice(0, 180),
        summary: 'An answer for this task could not be produced at this time because the language model could not be reached.',
        confidence: 0.2, as_of: new Date().toISOString(),
      }, 200);
    }
  },
};


