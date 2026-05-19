/**
 * Telegram message logging and last-sent context caching.
 * Matches the bash send-telegram.sh outbound logging (lines 100-108)
 * and last-sent cache (lines 111-113).
 */

import { appendFileSync, readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from 'fs';
import { join, dirname } from 'path';
import { logEvent } from '../bus/event.js';
import type { BusPaths, TelegramMessage } from '../types/index.js';
import { redactSecrets, type SecretMatch } from '../utils/redact-secrets.js';
import {
  loadSecretPatterns,
  getRedactionMode,
  type RedactionMode,
} from '../utils/redact-secrets-config.js';

/**
 * Optional metadata attached to an outbound Telegram message log entry.
 * Fields are all optional so existing callers that pass nothing still
 * produce the same JSONL shape as before this extension.
 *
 * - `parseMode`: which parse_mode the first send attempt used. "html"
 *   for the default path (Markdown-to-HTML conversion), "none" when the
 *   caller used --plain-text.
 */
export interface OutboundLogMetadata {
  parseMode?: 'html' | 'none';
}

/**
 * Append an outbound message to the agent's JSONL log.
 * Path: {ctxRoot}/logs/{agentName}/outbound-messages.jsonl
 */
export function logOutboundMessage(
  ctxRoot: string,
  agentName: string,
  chatId: string | number,
  text: string,
  messageId: number,
  metadata?: OutboundLogMetadata,
): void {
  const logDir = join(ctxRoot, 'logs', agentName);
  mkdirSync(logDir, { recursive: true });

  // Only emit metadata fields that were actually set so the base log shape
  // stays unchanged for callers that pass nothing (backwards compat).
  const meta: Record<string, unknown> = {};
  if (metadata?.parseMode !== undefined) meta.parse_mode = metadata.parseMode;

  const entry = JSON.stringify({
    timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    agent: agentName,
    chat_id: String(chatId),
    text,
    message_id: messageId,
    ...meta,
  });

  appendFileSync(join(logDir, 'outbound-messages.jsonl'), entry + '\n', 'utf-8');
}

/**
 * Optional context passed by callers (`recordInboundTelegram`) that can
 * resolve org-scoped paths. When supplied, the redaction hook emits
 * `security/redaction_detected` (audit-only) or `security/redaction_applied`
 * (live) events through the standard bus event logger. When absent,
 * redaction still runs (mode-dependent) but no bus event is emitted —
 * the audit JSONL file alone records the hit.
 */
export interface InboundRedactionContext {
  paths: BusPaths;
  org: string;
}

/**
 * Result of a single `logInboundMessage` call — exposed for tests and
 * for callers that want to react to a redaction (e.g. log a warning).
 */
export interface LogInboundResult {
  mode: RedactionMode;
  matches: SecretMatch[];
  /** True when the archived JSONL line was the redacted form (live mode + hits). */
  redactedArchive: boolean;
}

/**
 * Append an inbound message to the agent's JSONL log.
 * Path: {ctxRoot}/logs/{agentName}/inbound-messages.jsonl
 *
 * Cycle 11 H1A wrap: before the archive write, the message text is run
 * through the secret-pattern detector controlled by the
 * `CORTEXTOS_REDACTION_MODE` env var.
 *
 *   - `disabled` (default when unset) — feature off, identical to pre-H1A
 *     behavior. No detector invocation, no audit log, no events.
 *   - `audit-only` — detector runs; if matches are found the RAW message
 *     is still archived, a record is appended to `redaction-audit.jsonl`,
 *     and a `security/redaction_detected` event is emitted (when a
 *     redaction context is supplied).
 *   - `live` — detector runs; on matches, the REDACTED message is
 *     archived, the RAW pre-redaction body is preserved under
 *     `state/{agent}/.redaction-originals/{ts}-{msgid}.json` (0600), and
 *     a `security/redaction_applied` event is emitted.
 *
 * Clean messages (zero matches) take the legacy path and emit no event,
 * keeping noise out of the activity feed.
 */
export function logInboundMessage(
  ctxRoot: string,
  agentName: string,
  rawMessage: Record<string, unknown>,
  ctx?: InboundRedactionContext,
): LogInboundResult {
  const logDir = join(ctxRoot, 'logs', agentName);
  mkdirSync(logDir, { recursive: true });

  const mode = getRedactionMode();
  const rawText = typeof rawMessage.text === 'string' ? rawMessage.text : '';
  const messageId = typeof rawMessage.message_id === 'number' ? rawMessage.message_id : null;
  const fromId = typeof rawMessage.from === 'number' ? rawMessage.from : rawMessage.from ?? null;

  let matches: SecretMatch[] = [];
  let archiveText = rawText;
  let archiveRecord: Record<string, unknown> = rawMessage;
  let redactedArchive = false;

  if (mode !== 'disabled' && rawText) {
    try {
      const { patterns } = loadSecretPatterns();
      const result = redactSecrets(rawText, patterns);
      matches = result.matches;

      if (matches.length > 0) {
        // Audit log first — same content for both modes.
        try {
          const auditEntry = JSON.stringify({
            ts: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
            message_id: messageId,
            from: fromId,
            matches: matches.map(m => ({
              pattern: m.pattern,
              category: m.category,
              severity: m.severity,
              start: m.start,
              end: m.end,
              length: m.length,
            })),
            mode,
            action: mode === 'live' ? 'redacted' : 'would-redact',
          });
          appendFileSync(join(logDir, 'redaction-audit.jsonl'), auditEntry + '\n', 'utf-8');
        } catch {
          // Audit-log failure must not block message archive.
        }

        if (mode === 'live') {
          // Preserve original under restricted-perm dir, then archive the redacted form.
          try {
            const originalsDir = join(ctxRoot, 'state', agentName, '.redaction-originals');
            mkdirSync(originalsDir, { recursive: true });
            try { chmodSync(originalsDir, 0o700); } catch { /* best-effort on Windows */ }
            const tsStamp = new Date().toISOString().replace(/[:.]/g, '-');
            const idPart = messageId ?? 'noid';
            const originalPath = join(originalsDir, `${tsStamp}-${idPart}.json`);
            writeFileSync(
              originalPath,
              JSON.stringify({
                preserved_at: new Date().toISOString(),
                message_id: messageId,
                from: fromId,
                original: rawMessage,
              }, null, 2),
              { encoding: 'utf-8', mode: 0o600 },
            );
          } catch {
            // Failure to preserve original must not block archive write —
            // the audit log already records that a redaction happened.
          }

          archiveText = result.redacted;
          archiveRecord = { ...rawMessage, text: result.redacted };
          redactedArchive = true;
        }

        // Emit bus event when we have an event-emission context.
        if (ctx) {
          try {
            const eventName = mode === 'live' ? 'redaction_applied' : 'redaction_detected';
            const severity = mode === 'live' ? 'warning' : 'info';
            logEvent(ctx.paths, agentName, ctx.org, 'security', eventName, severity, {
              message_id: messageId,
              from: fromId,
              match_count: matches.length,
              patterns: matches.map(m => m.pattern),
              mode,
            });
          } catch {
            // Event-log failure must not break message processing.
          }
        }
      }
    } catch {
      // Any unexpected redactor failure falls back to writing the raw
      // message unchanged. Safety > opportunistic redaction.
      archiveText = rawText;
      archiveRecord = rawMessage;
      matches = [];
      redactedArchive = false;
    }
  }

  // Voiding unused-var warning when archive text equals raw (legacy path).
  void archiveText;

  const entry = JSON.stringify({
    ...archiveRecord,
    archived_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    agent: agentName,
  });

  appendFileSync(join(logDir, 'inbound-messages.jsonl'), entry + '\n', 'utf-8');

  return { mode, matches, redactedArchive };
}

/**
 * Persist an inbound Telegram message to the daemon's JSONL archive AND
 * emit a `message/telegram_received` bus event so dashboards and
 * experiment cycles can count fleet-wide inbound traffic. Symmetric with
 * `telegram_sent` emitted from the outbound path in `cortextos bus
 * send-telegram`.
 *
 * Wrapped: a logEvent failure (e.g. unwritable analytics dir) must not
 * break message processing — the logged inbound JSONL still goes through.
 */
export function recordInboundTelegram(
  paths: BusPaths,
  ctxRoot: string,
  agentName: string,
  org: string,
  fromName: string,
  msg: TelegramMessage,
  log?: (m: string) => void,
): void {
  const text = (msg.text || msg.caption || '').toString();
  logInboundMessage(
    ctxRoot,
    agentName,
    {
      message_id: msg.message_id,
      from: msg.from?.id,
      from_name: fromName,
      chat_id: msg.chat?.id,
      text,
      timestamp: new Date().toISOString(),
    },
    { paths, org },
  );

  const hasMedia = !!(msg.photo || msg.document || msg.voice || msg.audio || msg.video || msg.video_note);
  try {
    logEvent(paths, agentName, org, 'message', 'telegram_received', 'info', {
      chat_id: String(msg.chat?.id ?? ''),
      message_id: msg.message_id,
      from_id: msg.from?.id,
      from_name: fromName,
      has_media: hasMedia,
      text_chars: text.length,
    });
  } catch (err) {
    log?.(`logEvent(telegram_received) failed: ${err}`);
  }
}

/**
 * Cache the last-sent text for a given chat.
 * Path: {ctxRoot}/state/{agentName}/last-telegram-{chatId}.txt
 */
export function cacheLastSent(
  ctxRoot: string,
  agentName: string,
  chatId: string | number,
  text: string,
): void {
  const stateDir = join(ctxRoot, 'state', agentName);
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, `last-telegram-${chatId}.txt`), text, 'utf-8');
}

/**
 * Read the last-sent text for a given chat, or null if not cached.
 */
export function readLastSent(
  ctxRoot: string,
  agentName: string,
  chatId: string | number,
): string | null {
  const filePath = join(ctxRoot, 'state', agentName, `last-telegram-${chatId}.txt`);
  if (!existsSync(filePath)) {
    return null;
  }
  return readFileSync(filePath, 'utf-8');
}

/**
 * Build a short recent conversation snippet for context injection.
 * Reads the last cputime         unlimited
filesize        unlimited
datasize        unlimited
stacksize       7MB


/**
 * Build a short recent conversation snippet for context injection.
 * Reads the last `limit` messages (combined inbound + outbound) for the
 * given agent/chatId, sorts by timestamp, and returns a formatted string.
 * Returns null if no history is available.
 */
export function buildRecentHistory(
  ctxRoot: string,
  agentName: string,
  chatId: string | number,
  limit: number = 6,
): string | null {
  const logDir = join(ctxRoot, 'logs', agentName);
  const inboundPath = join(logDir, 'inbound-messages.jsonl');
  const outboundPath = join(logDir, 'outbound-messages.jsonl');
  const chatIdStr = String(chatId);

  interface Entry { ts: string; speaker: string; text: string; }
  const entries: Entry[] = [];

  const readLines = (filePath: string, speaker: string) => {
    if (!existsSync(filePath)) return;
    try {
      const raw = readFileSync(filePath, 'utf-8').trim();
      if (!raw) return;
      const lines = raw.split('\n').filter(Boolean);
      const tail = lines.slice(-(limit * 2));
      for (const line of tail) {
        try {
          const obj = JSON.parse(line);
          if (String(obj.chat_id) !== chatIdStr) continue;
          const text = (obj.text || '').trim();
          if (!text) continue;
          entries.push({ ts: obj.timestamp || obj.archived_at || '', speaker, text });
        } catch { /* skip malformed */ }
      }
    } catch { /* skip unreadable */ }
  };

  readLines(inboundPath, process.env.ADMIN_USERNAME ?? 'user');
  readLines(outboundPath, agentName);

  if (entries.length === 0) return null;

  entries.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  const recent = entries.slice(-limit);

  const formatted = recent.map(e => {
    const preview = e.text.length > 200 ? e.text.slice(0, 200) + '...' : e.text;
    return '[' + e.speaker + ']: ' + preview;
  });

  return formatted.join('\n');
}
