/**
 * Integration tests for the `logInboundMessage` redaction wrap.
 *
 * Covers each value of CORTEXTOS_REDACTION_MODE:
 *   - unset / disabled  → raw archived, no audit file, no events.
 *   - audit-only        → raw archived, audit file written, event emitted.
 *   - live              → redacted archived, raw preserved in originals dir,
 *                          event emitted, audit file written.
 * Plus the clean-message path (no event emitted regardless of mode).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { logInboundMessage } from '../../src/telegram/logging';
import { clearPatternCache } from '../../src/utils/redact-secrets-config';
import type { BusPaths } from '../../src/types';

const SECRET_TEXT = 'here is my token: ghp_1234567890abcdefABCDEF1234567890XX';
const CLEAN_TEXT = 'hello, how are you today?';

function makePaths(ctxRoot: string, agent: string): BusPaths {
  return {
    ctxRoot,
    inbox: join(ctxRoot, 'inbox', agent),
    inflight: join(ctxRoot, 'inflight', agent),
    processed: join(ctxRoot, 'processed', agent),
    logDir: join(ctxRoot, 'logs', agent),
    stateDir: join(ctxRoot, 'state', agent),
    taskDir: join(ctxRoot, 'tasks'),
    approvalDir: join(ctxRoot, 'approvals'),
    analyticsDir: join(ctxRoot, 'analytics'),
    deliverablesDir: join(ctxRoot, 'deliverables'),
  };
}

describe('logInboundMessage redaction wrap', () => {
  let testDir: string;
  let originalMode: string | undefined;
  let originalFwRoot: string | undefined;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-redact-int-'));
    originalMode = process.env.CORTEXTOS_REDACTION_MODE;
    originalFwRoot = process.env.CTX_FRAMEWORK_ROOT;
    // Force loader to use bundled defaults (no state/cortextos under tmp).
    process.env.CTX_FRAMEWORK_ROOT = testDir;
    clearPatternCache();
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
    if (originalMode === undefined) delete process.env.CORTEXTOS_REDACTION_MODE;
    else process.env.CORTEXTOS_REDACTION_MODE = originalMode;
    if (originalFwRoot === undefined) delete process.env.CTX_FRAMEWORK_ROOT;
    else process.env.CTX_FRAMEWORK_ROOT = originalFwRoot;
    clearPatternCache();
  });

  describe('mode: disabled (unset env)', () => {
    it('archives raw text, no audit file, no originals dir', () => {
      delete process.env.CORTEXTOS_REDACTION_MODE;
      const result = logInboundMessage(testDir, 'bot1', {
        message_id: 1,
        text: SECRET_TEXT,
      });
      expect(result.mode).toBe('disabled');
      expect(result.matches.length).toBe(0);
      expect(result.redactedArchive).toBe(false);

      const archive = readFileSync(
        join(testDir, 'logs', 'bot1', 'inbound-messages.jsonl'),
        'utf-8',
      );
      expect(archive).toContain('ghp_1234567890abcdefABCDEF1234567890XX');
      expect(existsSync(join(testDir, 'logs', 'bot1', 'redaction-audit.jsonl'))).toBe(false);
      expect(existsSync(join(testDir, 'state', 'bot1', '.redaction-originals'))).toBe(false);
    });
  });

  describe('mode: audit-only', () => {
    beforeEach(() => {
      process.env.CORTEXTOS_REDACTION_MODE = 'audit-only';
    });

    it('archives RAW text and writes audit log entry on secret hit', () => {
      const result = logInboundMessage(testDir, 'bot1', {
        message_id: 311,
        from: 1536425742,
        text: SECRET_TEXT,
      });
      expect(result.mode).toBe('audit-only');
      expect(result.matches.length).toBe(1);
      expect(result.matches[0]!.pattern).toBe('github_pat_classic');
      expect(result.redactedArchive).toBe(false);

      // Raw still in archive
      const archive = readFileSync(
        join(testDir, 'logs', 'bot1', 'inbound-messages.jsonl'),
        'utf-8',
      );
      expect(archive).toContain('ghp_1234567890abcdefABCDEF1234567890XX');

      // Audit file present and well-formed
      const auditPath = join(testDir, 'logs', 'bot1', 'redaction-audit.jsonl');
      expect(existsSync(auditPath)).toBe(true);
      const audit = JSON.parse(readFileSync(auditPath, 'utf-8').trim());
      expect(audit.mode).toBe('audit-only');
      expect(audit.action).toBe('would-redact');
      expect(audit.message_id).toBe(311);
      expect(audit.matches[0].pattern).toBe('github_pat_classic');

      // No originals preserved in audit-only mode
      expect(existsSync(join(testDir, 'state', 'bot1', '.redaction-originals'))).toBe(false);
    });

    it('emits security/redaction_detected event when context is supplied', () => {
      const paths = makePaths(testDir, 'bot1');
      logInboundMessage(
        testDir,
        'bot1',
        { message_id: 1, text: SECRET_TEXT },
        { paths, org: 'aunnix' },
      );

      const eventsDir = join(paths.analyticsDir, 'events', 'bot1');
      expect(existsSync(eventsDir)).toBe(true);
      const files = readdirSync(eventsDir);
      expect(files.length).toBeGreaterThan(0);
      const eventLine = readFileSync(join(eventsDir, files[0]!), 'utf-8').trim().split('\n')[0]!;
      const event = JSON.parse(eventLine);
      expect(event.category).toBe('security');
      expect(event.event).toBe('redaction_detected');
      expect(event.severity).toBe('info');
      expect(event.metadata.match_count).toBe(1);
    });
  });

  describe('mode: live', () => {
    beforeEach(() => {
      process.env.CORTEXTOS_REDACTION_MODE = 'live';
    });

    it('archives REDACTED text, preserves original under restricted dir, emits warning event', () => {
      const paths = makePaths(testDir, 'bot1');
      const result = logInboundMessage(
        testDir,
        'bot1',
        { message_id: 311, from: 1536425742, text: SECRET_TEXT },
        { paths, org: 'aunnix' },
      );
      expect(result.mode).toBe('live');
      expect(result.matches.length).toBe(1);
      expect(result.redactedArchive).toBe(true);

      // Archive should NOT contain the raw secret
      const archive = readFileSync(
        join(testDir, 'logs', 'bot1', 'inbound-messages.jsonl'),
        'utf-8',
      );
      expect(archive).not.toContain('ghp_1234567890abcdefABCDEF1234567890XX');
      expect(archive).toContain('[REDACTED-GH-CLASSIC]');

      // Original preserved
      const originalsDir = join(testDir, 'state', 'bot1', '.redaction-originals');
      expect(existsSync(originalsDir)).toBe(true);
      const originals = readdirSync(originalsDir);
      expect(originals.length).toBe(1);
      const preserved = JSON.parse(readFileSync(join(originalsDir, originals[0]!), 'utf-8'));
      expect(preserved.message_id).toBe(311);
      expect(preserved.original.text).toBe(SECRET_TEXT);

      // Audit log says 'redacted'
      const audit = JSON.parse(
        readFileSync(join(testDir, 'logs', 'bot1', 'redaction-audit.jsonl'), 'utf-8').trim(),
      );
      expect(audit.action).toBe('redacted');
      expect(audit.mode).toBe('live');

      // Event was emitted as warning
      const eventsDir = join(paths.analyticsDir, 'events', 'bot1');
      const files = readdirSync(eventsDir);
      const event = JSON.parse(
        readFileSync(join(eventsDir, files[0]!), 'utf-8').trim().split('\n')[0]!,
      );
      expect(event.event).toBe('redaction_applied');
      expect(event.severity).toBe('warning');
    });
  });

  describe('clean message path', () => {
    it('emits no event and writes no audit file in any mode', () => {
      for (const mode of ['disabled', 'audit-only', 'live'] as const) {
        process.env.CORTEXTOS_REDACTION_MODE = mode;
        clearPatternCache();
        const paths = makePaths(testDir, `clean-${mode}`);
        const result = logInboundMessage(
          testDir,
          `clean-${mode}`,
          { message_id: 1, text: CLEAN_TEXT },
          { paths, org: 'aunnix' },
        );
        expect(result.matches.length).toBe(0);
        expect(result.redactedArchive).toBe(false);
        expect(
          existsSync(join(testDir, 'logs', `clean-${mode}`, 'redaction-audit.jsonl')),
        ).toBe(false);
        // No security events folder for clean traffic
        const eventsDir = join(paths.analyticsDir, 'events', `clean-${mode}`);
        if (existsSync(eventsDir)) {
          const files = readdirSync(eventsDir);
          for (const f of files) {
            const lines = readFileSync(join(eventsDir, f), 'utf-8').trim().split('\n');
            for (const line of lines) {
              if (!line) continue;
              const event = JSON.parse(line);
              expect(event.category).not.toBe('security');
            }
          }
        }
      }
    });
  });
});
