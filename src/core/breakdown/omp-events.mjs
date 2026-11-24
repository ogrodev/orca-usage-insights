import { EXPLAIN_MARKER } from './claude-events.mjs';
import {
  agentTarget, commandTarget, customTarget, injectedTarget, mcpTarget, messagesTarget, pathTarget, searchTarget,
  sideTarget, summaryTarget, toolTarget, webSearchTarget, webTarget,
} from './targets.mjs';

const CALLS_MAX = 2000;
const MIN_YEAR = 2020;
const HEAD = /^\{"type":"([^"\\]*)"(?:,"customType":"([^"\\]*)")?/;
const HANDLED = new Set(['session', 'message', 'model_usage', 'compaction', 'custom_message']);
const CUSTOM_HANDLED = new Set(['date-cwd-reminder']);
const EDIT_FILE = /^\[([^\]#\n]+)#[0-9A-Fa-f]{4}\]/m;
const SELECTOR = /(?::(?:raw|-?\d[\d,+-]*))+$/;
const URL_SCHEME = /^([a-z][\w+.-]*):\/\//i;
const WEB_URL = /^https?:\/\//i;
const GLOB_START = /[*?{[]/;
const encoder = new TextEncoder();

export function createOmpEvents(ctx = {}, state = null) {
  const home = ctx?.home ?? '';
  let cwd = state?.cwd ?? '';
  let sessionId = state?.sessionId ?? '';
  const calls = new Map(state?.calls ?? []);

  function session(obj, out) {
    const meta = {};
    if (nonBlank(obj.id) && !sessionId) {
      sessionId = obj.id;
      meta.sessionId = sessionId;
    }
    if (nonBlank(obj.cwd) && obj.cwd !== cwd) {
      cwd = obj.cwd;
      meta.cwd = cwd;
    }
    if (Object.keys(meta).length > 0) out.push({ t: 'meta', ...meta });
  }

  function message(obj, where, out) {
    const m = isObject(obj.message) ? obj.message : {};
    switch (m.role) {
      case 'assistant':
        assistant(obj, m, out);
        break;
      case 'toolResult': {
        const id = nonBlank(m.toolCallId);
        const target = (id ? calls.get(id) : null) ?? toolTarget(m.toolName);
        out.push(arrival('tools', target, contentStats(m.content), where, id));
        break;
      }
      case 'user': {
        const event = arrival('messages', messagesTarget(), contentStats(m.content), where);
        if (firstText(m.content).trimStart().startsWith(EXPLAIN_MARKER)) event.explain = true;
        out.push(event);
        break;
      }
      default:
        out.push(arrival('injected', injectedTarget(), contentStats(m.content), where));
        break;
    }
  }

  function assistant(obj, m, out) {
    const usage = isObject(m.usage) ? ompUsage(m.usage) : null;
    if (usage && usage.input + usage.cacheRead + usage.cacheWrite > 0 && isTimestamp(obj.timestamp)) {
      out.push({ t: 'request', key: nonBlank(obj.id) ?? '', ts: obj.timestamp, model: modelName(m), usage, cost: m.usage.cost });
    }
    for (const block of Array.isArray(m.content) ? m.content.filter(isObject) : []) {
      if (block.type === 'toolCall') call(block, out);
      else if (block.type === 'text') out.push({ t: 'reply', chars: lengthOf(block.text) });
    }
  }

  function side(obj, out) {
    if (!isObject(obj.usage) || !isTimestamp(obj.timestamp)) return;
    const usage = ompUsage(obj.usage);
    if (usage.input + usage.cacheRead + usage.cacheWrite + usage.output === 0) return;
    out.push({ t: 'side', ts: obj.timestamp, model: modelName(obj), usage, cost: obj.usage.cost, target: sideTarget(obj.purpose) });
  }

  function call(block, out) {
    const id = nonBlank(block.id) ?? '';
    const { target, op } = toolCall(block);
    if (id) {
      calls.set(id, target);
      if (calls.size > CALLS_MAX) calls.delete(calls.keys().next().value);
    }
    out.push({ t: 'call', id, target, op });
  }

  function toolCall(block) {
    const name = typeof block.name === 'string' ? block.name : '';
    const args = argsOf(block.arguments);
    switch (name) {
      case 'read':
        return readCall(args.path, name);
      case 'write':
        return fileCall(args.path, 'write', name);
      case 'edit':
        return fileCall(typeof args.input === 'string' ? EDIT_FILE.exec(args.input)?.[1] : null, 'edit', name);
      case 'grep':
      case 'glob':
      case 'find':
        return { target: searchTarget(searchPath(args.path), cwd, home), op: 'search' };
      case 'bash':
        return { target: commandTarget(args.command), op: 'shell' };
      case 'web_search':
        return { target: webSearchTarget(), op: 'web' };
      case 'task':
        return { target: agentTarget(Array.isArray(args.tasks) ? (args.tasks.find(isObject)?.agent ?? 'task') : 'task'), op: 'agent' };
      default: {
        const server = /^mcp__([a-z0-9-]+)_/i.exec(name);
        return server ? { target: mcpTarget(server[1]), op: 'mcp' } : { target: toolTarget(name), op: 'other' };
      }
    }
  }

  function readCall(path, name) {
    if (typeof path !== 'string') return { target: toolTarget(name), op: 'other' };
    if (WEB_URL.test(path)) return { target: webTarget(path), op: 'web' };
    const scheme = URL_SCHEME.exec(path)?.[1]?.toLowerCase();
    if (scheme) return { target: toolTarget(`${name} ${scheme}://`), op: 'other' };
    return fileCall(path.replace(SELECTOR, ''), 'read', name);
  }

  function fileCall(path, op, name) {
    const target = pathTarget(path, cwd, home);
    return target ? { target, op } : { target: toolTarget(name), op: 'other' };
  }

  return {
    push(line, offset, bytes = null) {
      const text = String(line);
      const head = HEAD.exec(text.length > 80 ? text.slice(0, 80) : text);
      if (head && !HANDLED.has(head[1]) && !(head[1] === 'custom' && CUSTOM_HANDLED.has(head[2]))) return [];
      const obj = parseJson(text);
      if (!obj) return [];
      const where = {
        ts: typeof obj.timestamp === 'string' ? obj.timestamp : null,
        offset,
        bytes: bytes ?? encoder.encode(text).length,
      };
      const out = [];
      switch (obj.type) {
        case 'session':
          session(obj, out);
          break;
        case 'message':
          message(obj, where, out);
          break;
        case 'model_usage':
          side(obj, out);
          break;
        case 'compaction':
          out.push({ t: 'reset' });
          out.push(arrival('compaction', summaryTarget(), { chars: lengthOf(obj.summary), images: 0 }, where));
          break;
        case 'custom_message':
          out.push(arrival('injected', customTarget(obj.customType), { chars: valueChars(obj.content), images: 0 }, where));
          break;
        case 'custom':
          if (CUSTOM_HANDLED.has(obj.customType)) out.push(arrival('injected', customTarget(obj.customType), { chars: lengthOf(obj.data?.reminder), images: 0 }, where));
          break;
        default:
          break;
      }
      return out;
    },
    state() {
      return { cwd, sessionId, calls: [...calls] };
    },
  };
}

export function ompModelName(provider, model) {
  return `${nonBlank(provider) ?? 'unknown'}/${nonBlank(model) ?? 'unknown'}`;
}

function modelName(entry) {
  return ompModelName(entry.provider, entry.model);
}

function ompUsage(usage) {
  const cacheWrite = count(usage.cacheWrite);
  return {
    input: count(usage.input),
    output: count(usage.output),
    cacheRead: count(usage.cacheRead),
    cacheWrite,
    cacheWrite1h: Math.min(cacheWrite, count(usage.cttl?.ephemeral1h)),
  };
}

function searchPath(value) {
  if (typeof value !== 'string') return null;
  const first = value.split(';')[0].trim();
  const glob = first.search(GLOB_START);
  const path = (glob < 0 ? first : first.slice(0, glob)).replace(/\/+$/, '');
  return path === '' || path === '.' ? null : path;
}

function argsOf(value) {
  const parsed = typeof value === 'string' ? parseJson(value) : value;
  return isObject(parsed) ? parsed : {};
}

function arrival(bucket, target, stats, where, callId) {
  return {
    t: 'arrival',
    ts: where.ts,
    bucket,
    target,
    chars: stats.chars,
    images: stats.images,
    offset: where.offset,
    bytes: where.bytes,
    ...(callId ? { callId } : {}),
  };
}

function firstText(content) {
  if (typeof content === 'string') return content;
  const block = Array.isArray(content) ? content.find((b) => typeof b?.text === 'string') : null;
  return block?.text ?? '';
}

function contentStats(content) {
  if (typeof content === 'string') return { chars: content.length, images: 0 };
  const stats = { chars: 0, images: 0 };
  if (!Array.isArray(content)) return stats;
  for (const block of content.filter(isObject)) {
    if (block.type === 'image') stats.images += 1;
    else stats.chars += lengthOf(block.text);
  }
  return stats;
}

function valueChars(value) {
  if (value === undefined || value === null) return 0;
  return typeof value === 'string' ? value.length : JSON.stringify(value).length;
}

function lengthOf(value) {
  return typeof value === 'string' ? value.length : 0;
}

function count(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function parseJson(text) {
  try {
    const value = JSON.parse(text);
    return isObject(value) ? value : null;
  } catch {
    return null;
  }
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonBlank(value) {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function isTimestamp(value) {
  if (typeof value !== 'string') return false;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return false;
  const year = new Date(ms).getUTCFullYear();
  return year >= MIN_YEAR && year <= new Date().getUTCFullYear() + 1;
}
