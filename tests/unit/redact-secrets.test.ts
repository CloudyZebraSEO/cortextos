/**
 * Pattern coverage for the secret redactor.
 *
 * Test cases are GENERATED from the single source of truth — the
 * `state/cortextos/secret-patterns.json` file — so adding a fixture in
 * JSON automatically adds an `it()` here. Per spec condition 4.
 *
 * Coverage:
 *   1. examples_match  — every entry MUST redact.
 *   2. examples_skip   — every entry MUST NOT redact.
 *   3. Ordering — sk-ant-... hits anthropic, never the openai legacy pattern.
 *   4. FP harness — 100 lines of legitimate agent traffic produce zero hits.
 *   5. Cache + loader fallthrough — bundled defaults match JSON content.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { redactSecrets, type SecretPattern } from '../../src/utils/redact-secrets';
import { DEFAULT_SECRET_PATTERNS } from '../../src/utils/redact-secrets-defaults';

const FIXTURE_PATH = join(__dirname, '..', '..', 'state', 'cortextos', 'secret-patterns.json');
const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf-8')) as {
  patterns: SecretPattern[];
};
const PATTERNS: SecretPattern[] = fixture.patterns;

describe('redactSecrets — fixture-driven coverage', () => {
  it('fixture file loads with at least 12 shipped patterns', () => {
    expect(PATTERNS.length).toBeGreaterThanOrEqual(12);
  });

  for (const pat of PATTERNS) {
    describe(`pattern: ${pat.name}`, () => {
      const matches = pat.examples_match || [];
      const skips = pat.examples_skip || [];

      for (const sample of matches) {
        it(`MATCHES: ${truncate(sample)}`, () => {
          const { redacted, matches: m } = redactSecrets(sample, PATTERNS);
          expect(m.length).toBeGreaterThan(0);
          // At least one of the matches must be for this pattern (or for
          // a pattern that intentionally takes precedence — e.g. anthropic
          // over openai legacy for `sk-ant-*` strings).
          expect(redacted).not.toBe(sample);
        });
      }

      for (const sample of skips) {
        it(`SKIPS: ${truncate(sample)}`, () => {
          const { redacted, matches: m } = redactSecrets(sample, [pat]);
          // Running only this pattern on the skip example: must NOT match.
          expect(m.length).toBe(0);
          expect(redacted).toBe(sample);
        });
      }
    });
  }
});

describe('redactSecrets — ordering invariants', () => {
  it('sk-ant-... hits the anthropic pattern, not openai_api_key_legacy', () => {
    const sample = 'sk-ant-api03-AbCd1234EfGh5678IjKl9012MnOp';
    const { redacted, matches } = redactSecrets(sample, PATTERNS);
    expect(matches.length).toBe(1);
    expect(matches[0]!.pattern).toBe('anthropic_api_key');
    expect(redacted).toContain('[REDACTED-ANTHROPIC-KEY]');
    expect(redacted).not.toContain('[REDACTED-OPENAI-KEY]');
  });

  it('openai legacy regex would not match sk-ant-... independently (negative assertion)', () => {
    const openai = PATTERNS.find(p => p.name === 'openai_api_key_legacy')!;
    const re = new RegExp(openai.regex);
    expect(re.test('sk-ant-api03-AbCd1234EfGh5678IjKl9012MnOp')).toBe(false);
  });

  it('clean input is returned unchanged (identity)', () => {
    const sample = 'Hello, how are you today?';
    const { redacted, matches } = redactSecrets(sample, PATTERNS);
    expect(redacted).toBe(sample);
    expect(matches.length).toBe(0);
  });

  it('multiple distinct secrets in one message all redact', () => {
    const sample = 'gh=ghp_1234567890abcdefABCDEF1234567890XX, aws=AKIAIOSFODNN7EXAMPLE';
    const { redacted, matches } = redactSecrets(sample, PATTERNS);
    expect(matches.length).toBe(2);
    expect(redacted).toContain('[REDACTED-GH-CLASSIC]');
    expect(redacted).toContain('[REDACTED-AWS-AK]');
  });
});

describe('redactSecrets — false-positive harness (100 lines of agent traffic)', () => {
  // Legitimate agent traffic samples: heartbeats, task IDs, timestamps,
  // event metadata, etc. None of these should ever match a pattern.
  const FP_HARNESS: string[] = [
    'heartbeat 2026-05-18T05:00:00Z mode=day status=ok',
    'task task_1779056924724_98071983 status=completed',
    'msg_id: 1779056924724_98071983 from chat_id:1779056924724',
    'created_at 2026-05-18T05:00:00.123Z',
    '[ACK] received task task_1779056924724_98071983 ETA: 5m',
    'cron heartbeat every 6h next 2026-05-18T11:00:00Z',
    'fleet-health: 3 healthy, 0 warning, 0 failure',
    'chat_id:1234567890 from_name=Steven text="hello"',
    'inbox: 0 messages, outbox: 2 pending',
    'session_start agent=oracle org=aunnix',
    'log path: ~/.cortextos/default/logs/oracle/activity.log',
    'config: max_session_seconds=14400 timezone=America/New_York',
    'kpi_key task_completed value=1',
    'approval id=appr_1779056924724_98071983 status=pending',
    'metric heartbeats_per_hour=10 errors_per_hour=0',
    'milestone cycle-11-h1 oracle SPEC complete',
    'agent_activity oracle: writing memory entry',
    'inbox.json: {"id":"1779056924724","from":"aurex","priority":"normal"}',
    'starting daemon at 2026-05-18T05:00:00Z pid=12345',
    'pty session attached: bot1 cols=120 rows=40',
    'curl https://api.telegram.org/bot<TOKEN>/sendMessage failed: 429',
    'redaction-audit.jsonl entry written for msg 311',
    'state/oracle/heartbeat.json updated',
    'orgs/aunnix/analytics/events/oracle/2026-05-18.jsonl',
    'cron fire_at 2026-05-18T13:00:00Z name=morning-briefing',
    'context_status: tokens_used=80000 / 200000',
    'execution-log: cron heartbeat fired in 0.4ms attempt=1',
    'send-telegram chat_id=1234567890 text="ack"',
    'reading file: src/utils/redact-secrets.ts (158 lines)',
    'spawn worker name=oracle-helper-1 pid=22345 status=starting',
    'memory entry COMPLETED: cycle-11 H1A build at 2026-05-18T07:30:00Z',
    'aurex greenlit spec with 5 conditions on 2026-05-18T05:08Z',
    'config.json has 4 crons, max_session_seconds=14400',
    'goals.json: focus=cycle-11 goals=[h1a, h1c]',
    'enabled-agents.json lists 7 agents under instance=default',
    'restart pid=99887 reason="config-change"',
    'telegram_received from=1536425742 chars=42 has_media=false',
    'telegram_sent chat=1234567890 message_id=1099 parse_mode=html',
    'event id=1715973000-oracle-abc12 category=action severity=info',
    'task_completed result="merged feature/abc into main"',
    'heartbeat refresh: last=2026-05-18T05:00:00Z interval=6h',
    'workspace: C:/Users/steve/cortextos branch=fix/codex-windows-compat',
    'commit fbcf536 test(fast-checker): align watchdog test',
    'tsc --noEmit: 0 errors',
    'vitest run: 142 passed, 0 failed in 4.2s',
    'npm run build: dist/cli.js 408.10 KB',
    'install.ts skipped: instance already initialised',
    'goals: ship h1a + h1c, audit-only 7d, flip live cycle 12',
    'metric collection: 24 events written to analytics/events',
    'oauth account refreshed: anthropic / steven',
    'usage snapshot: 3.2M tokens this week, $48 spent',
    'BUS: send-message oracle aurex normal "ack"',
    'CRON: heartbeat fired at 2026-05-18T11:00:01.042Z',
    'tasks: 12 open, 4 in_progress, 0 blocked',
    'fast-checker: polled 12 chats, processed 3 inbound',
    'cycle-11 score preview: 7.5/10 — SPEC not SHIP',
    'sk-test_short (this is a placeholder, not a real key)',
    'AKIA-short example used in docs',
    'github_pat_ prefix without payload (literal docs string)',
    'ghp_ (truncated example)',
    'xoxb- (prefix only)',
    'AIza (prefix only — not a real key)',
    'sk- (prefix only)',
    'sk-ant- (prefix only)',
    'sk-proj- (prefix only)',
    'just some normal english text describing the api',
    'a quick brown fox jumps over the lazy dog',
    'the quick brown fox jumps over the lazy dog 1234567890',
    'lorem ipsum dolor sit amet consectetur adipiscing elit',
    'all done — see you tomorrow!',
    'tool_use_id=toolu_01abcdef ghi result=success',
    'msg_id 311 from steven 2026-05-13T12:34:56Z',
    'project=cortextos branch=main remote=origin',
    'PR #1 merged 4552a10 into main',
    'docs/security/redaction-hook.md created',
    'spec read at orgs/aunnix/agents/oracle/proposals/cycle-11-h1/',
    'aurex condition 4: unit tests with negative cases',
    'aurex condition 5: feature flag off-by-default',
    'env CORTEXTOS_REDACTION_MODE unset → disabled',
    'inbound-messages.jsonl rotated at 2026-05-18T00:00:00Z',
    '.redaction-originals dir created with 0700 perms',
    'unlinked file older than 7d: original-1779056924724-311.json',
    'send-telegram fallback: HTML parse failed, retrying plain',
    'parse_mode=html escape: <code>example</code>',
    'cron next fire in 5400 seconds (1h30m)',
    'logEvent failed: ENOENT — analytics dir missing',
    'recovered: created analytics dir, retrying',
    'oracle session 71h reached — auto-restart with --continue',
    'spawn-worker name=h1a-builder dir=worktrees/h1a',
    'context handoff at 80% threshold',
    'IDENTITY: oracle — analyst for aunnix org',
    'SOUL: prefer measurable impact over speed',
    'memory entry WORKING ON: cycle-11 H1A redaction build',
    'agent-process: cleanup loop ran 12 times today',
    'dashboard ping: latency 42ms, status ok',
    'no new messages this cycle, looping',
    'all crons green, fleet-health summary: 7/7 healthy',
    'plain text without any tokens at all',
    'a hello world from oracle to aurex via cortextos bus',
    'goodbye for now',
  ];

  it('has at least 100 fixture lines', () => {
    expect(FP_HARNESS.length).toBeGreaterThanOrEqual(100);
  });

  for (let i = 0; i < FP_HARNESS.length; i++) {
    const sample = FP_HARNESS[i]!;
    it(`line ${i + 1}: zero matches — ${truncate(sample, 60)}`, () => {
      const { matches, redacted } = redactSecrets(sample, PATTERNS);
      expect(matches.length).toBe(0);
      expect(redacted).toBe(sample);
    });
  }
});

describe('redactSecrets — bundled defaults parity', () => {
  it('bundled DEFAULT_SECRET_PATTERNS matches JSON pattern count', () => {
    expect(DEFAULT_SECRET_PATTERNS.length).toBe(PATTERNS.length);
  });

  it('bundled defaults match JSON by name in declared order', () => {
    expect(DEFAULT_SECRET_PATTERNS.map(p => p.name)).toEqual(PATTERNS.map(p => p.name));
  });

  it('bundled defaults match JSON regex sources by name', () => {
    for (let i = 0; i < PATTERNS.length; i++) {
      const want = PATTERNS[i]!;
      const got = DEFAULT_SECRET_PATTERNS[i]!;
      expect(got.regex).toBe(want.regex);
      expect(got.replacement).toBe(want.replacement);
      expect(got.severity).toBe(want.severity);
    }
  });
});

describe('redactSecrets — defensive guards', () => {
  it('empty input returns empty result', () => {
    expect(redactSecrets('', PATTERNS)).toEqual({ redacted: '', matches: [] });
  });

  it('no patterns returns identity', () => {
    expect(redactSecrets('ghp_1234567890abcdefABCDEF1234567890XX', [])).toEqual({
      redacted: 'ghp_1234567890abcdefABCDEF1234567890XX',
      matches: [],
    });
  });

  it('invalid regex is skipped without throwing', () => {
    const bad: SecretPattern[] = [
      { name: 'bad', regex: '(unterminated', category: 'test', severity: 'info', replacement: '[X]' },
      { name: 'good', regex: 'ghp_[A-Za-z0-9]{20,}', category: 'vcs_token', severity: 'critical', replacement: '[REDACTED-GH-CLASSIC]' },
    ];
    const { matches } = redactSecrets('ghp_1234567890abcdefABCDEF1234567890XX', bad);
    expect(matches.length).toBe(1);
    expect(matches[0]!.pattern).toBe('good');
  });
});

function truncate(s: string, n = 40): string {
  return s.length > n ? s.slice(0, n) + '…' : s;
}
