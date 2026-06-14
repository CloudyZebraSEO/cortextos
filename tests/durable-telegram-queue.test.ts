import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { FastChecker } from '../src/daemon/fast-checker.js';
import type { BusPaths } from '../src/types/index.js';

/**
 * Durable Telegram queue (.pending-telegram.jsonl) — the fix for the archive-not-injected
 * message-loss bug. Telegram messages are acked upstream (offset advanced) at queue-time,
 * so the in-memory inject queue MUST survive a daemon/PTY restart. These tests exercise the
 * real FastChecker persist/recover/clear path with a stub agent.
 */
describe('Durable Telegram queue', () => {
  const testDir = join(tmpdir(), `cortextos-durable-tg-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  const stateDir = join(testDir, 'state', 'testbot');
  const pendingPath = join(stateDir, '.pending-telegram.jsonl');

  const paths = (): BusPaths => ({
    ctxRoot: testDir, inbox: join(testDir, 'inbox'), inflight: join(testDir, 'inflight'),
    processed: join(testDir, 'processed'), logDir: join(testDir, 'logs'), stateDir,
    taskDir: join(testDir, 'tasks'), approvalDir: join(testDir, 'approvals'),
    analyticsDir: join(testDir, 'analytics'), deliverablesDir: join(testDir, 'deliverables'),
  });
  const stubAgent = () => ({ name: 'testbot', status: 'running' }) as any;
  const newChecker = () => new FastChecker(stubAgent(), paths(), testDir, { log: () => {} });

  beforeEach(() => { mkdirSync(stateDir, { recursive: true }); mkdirSync(join(testDir, 'inbox'), { recursive: true }); });
  afterEach(() => { try { rmSync(testDir, { recursive: true, force: true }); } catch { /* ignore */ } });

  it('persists a queued Telegram message to the durable file', () => {
    const fc = newChecker();
    fc.queueTelegramMessage('=== TELEGRAM from Steve ===\nhello scribe\n', 'telegram-message:42');
    expect(existsSync(pendingPath)).toBe(true);
    const lines = readFileSync(pendingPath, 'utf8').trim().split('\n');
    expect(lines.length).toBe(1);
    const entry = JSON.parse(lines[0]);
    expect(entry.pid).toMatch(/^tg-\d+$/);
    expect(entry.formatted).toContain('hello scribe');
    expect(entry.dedupKey).toBe('telegram-message:42');
  });

  it('recovers queued messages into a fresh instance (simulated restart)', () => {
    const fc1 = newChecker();
    fc1.queueTelegramMessage('msg A\n', 'k:a');
    fc1.queueTelegramMessage('msg B\n', 'k:b');
    // simulate restart: a brand-new FastChecker on the same stateDir
    const fc2 = newChecker() as any;
    expect(fc2.telegramMessages.length).toBe(2);
    expect(fc2.telegramMessages.map((m: any) => m.formatted)).toEqual(['msg A\n', 'msg B\n']);
    // pids preserved so the durable mirror can be reconciled after inject
    expect(fc2.telegramMessages.every((m: any) => /^tg-\d+$/.test(m.pid))).toBe(true);
  });

  it('clears only the injected pids and leaves the rest pending', () => {
    const fc = newChecker() as any;
    fc.queueTelegramMessage('one\n', 'k:1');
    fc.queueTelegramMessage('two\n', 'k:2');
    const [p1] = [...fc.pendingTgDurable.keys()];
    fc.clearPendingTelegram([p1]);
    expect(fc.pendingTgDurable.size).toBe(1);
    const remaining = readFileSync(pendingPath, 'utf8').trim().split('\n').map((l: string) => JSON.parse(l));
    expect(remaining.length).toBe(1);
    expect(remaining[0].formatted).toBe('two\n');
  });

  it('removes the durable file once the last message is cleared', () => {
    const fc = newChecker() as any;
    fc.queueTelegramMessage('solo\n', 'k:solo');
    const pids = [...fc.pendingTgDurable.keys()];
    fc.clearPendingTelegram(pids);
    expect(fc.pendingTgDurable.size).toBe(0);
    expect(existsSync(pendingPath)).toBe(false);
  });

  it('preserves multi-line formatted bodies across the round-trip', () => {
    const body = '=== TELEGRAM from Steve ===\nline1\nline2\n\nReply using: cortextos bus send-telegram 123 "x"\n';
    newChecker().queueTelegramMessage(body, 'k:multiline');
    const fc2 = newChecker() as any;
    expect(fc2.telegramMessages[0].formatted).toBe(body);
  });

  it('tolerates a malformed line and still recovers the valid entries', () => {
    // a torn/garbage line should not take down recovery of good entries
    const good = JSON.stringify({ pid: 'tg-7', formatted: 'good\n', dedupKey: 'k:good' });
    writeFileSync(pendingPath, good + '\n{ this is not json\n', 'utf8');
    const fc = newChecker() as any;
    expect(fc.telegramMessages.length).toBe(1);
    expect(fc.telegramMessages[0].formatted).toBe('good\n');
  });

  it('continues the pid sequence after recovery so new pids do not collide', () => {
    writeFileSync(pendingPath, JSON.stringify({ pid: 'tg-5', formatted: 'recovered\n' }) + '\n', 'utf8');
    const fc = newChecker() as any;
    fc.queueTelegramMessage('new\n', 'k:new');
    const pids = [...fc.pendingTgDurable.keys()];
    // new pid must be > tg-5
    const newPid = pids.find((p: string) => p !== 'tg-5')!;
    expect(parseInt(newPid.split('-')[1], 10)).toBeGreaterThan(5);
  });
});
