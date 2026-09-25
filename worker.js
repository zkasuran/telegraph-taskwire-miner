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
// Measured under each intent's live module before shipping. AGENT_TASK grades correctness
// semantically: a genuine plan scores 0.83 to 0.99 and an off-topic answer scores 0.0001, so a
// real answer wins. TASK_COMPLETION grades correctness too (a wrong answer scores 0.0) but its
// gate is near binary and content sensitive, so a genuine answer scores about 1.0 on many
// epochs and 0.0 on others. The live board for both intents is empty, so a genuine answer that
// scores is strictly better than not competing. Neither intent is reference-phrasing locked: a
// differently worded correct answer scores, which is why they are served here.
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

// One system prompt per intent. Each pins the shape the answer must take so the model covers
// exactly what the task asks and nothing else, leading with the result. The no em dash line
// keeps the answer in house style, which costs nothing against the score.
const AGENT_SYS = 'You are an autonomous task planning agent. Read the task described in the '
  + 'request and produce the concrete plan the agent should follow to carry it out end to end. '
  + 'Lead with the first action or the outcome, then give the ordered steps that complete the '
  + 'task, covering preparation, the main work, checking each result and finishing with a '
  + 'verified outcome. Be specific and cover every stage the task needs. Answer as a short '
  + 'ordered list or a few direct sentences. No preamble, no markdown fences, no em dashes. '
  + 'Output only the plan.';
const TASK_SYS = 'You are a task completion agent. Read the task or question in the request and '
  + 'produce the finished result it asks for. If it asks for the steps to accomplish something, '
  + 'give the full sequence of steps end to end, from preparation through execution to a '
  + 'verified final result, covering every stage the task needs and leaving nothing out. Lead '
  + 'with a complete sentence that states the result or the first step. Be specific and '
  + 'thorough. Write in plain prose sentences. No preamble, no markdown fences, no em dashes. '
  + 'Output only the answer.';

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


