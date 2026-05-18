/**
 * Bundled default secret patterns — fallback when no
 * `state/cortextos/secret-patterns.json` file is present on disk.
 *
 * The canonical authoring file lives at:
 *   state/cortextos/secret-patterns.json
 * and the framework-installed copy is synced from
 *   orgs/aunnix/agents/oracle/proposals/cycle-11-h1/secret-patterns.json
 *
 * KEEP IN SYNC with the JSON. Tests assert that both sources agree.
 *
 * Pattern ordering matters: see `ordering_note` on individual entries.
 * `anthropic_api_key` MUST precede `openai_api_key_legacy`.
 */

import type { SecretPattern } from './redact-secrets.js';

export const DEFAULT_SECRET_PATTERNS: SecretPattern[] = [
  {
    name: 'github_pat_fine_grained',
    regex: 'github_pat_[A-Za-z0-9_]{4,}',
    category: 'vcs_token',
    severity: 'critical',
    replacement: '[REDACTED-GH-PAT]',
    examples_match: [
      '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',
      'GH_TOKEN=github_pat_abcd1234EFGH',
    ],
    examples_skip: [
      'github_pat_',
      'the github_pat prefix is documented at',
      'github_pat_[A-Za-z0-9_]{20,}',
    ],
  },
  {
    name: 'github_pat_classic',
    regex: 'ghp_[A-Za-z0-9]{20,}',
    category: 'vcs_token',
    severity: 'critical',
    replacement: '[REDACTED-GH-CLASSIC]',
    examples_match: ['ghp_1234567890abcdefABCDEF1234567890XX'],
    examples_skip: ['ghp_', 'ghp_short'],
  },
  {
    name: 'github_app_secret',
    regex: 'ghs_[A-Za-z0-9]{20,}',
    category: 'vcs_token',
    severity: 'critical',
    replacement: '[REDACTED-GH-APP-SECRET]',
    examples_match: ['ghs_AbCdEf1234567890ABCDEFG1234'],
    examples_skip: ['ghs_'],
  },
  {
    name: 'anthropic_api_key',
    regex: 'sk-ant-[a-zA-Z0-9_-]{20,}',
    category: 'llm_api_key',
    severity: 'critical',
    replacement: '[REDACTED-ANTHROPIC-KEY]',
    examples_match: [
      'sk-ant-api03-AbCd1234EfGh5678IjKl9012MnOp',
      'ANTHROPIC_API_KEY=sk-ant-api01-XyZ_abcdefghijklmnopqrstuvwxyz1234',
    ],
    examples_skip: ['sk-ant-', 'sk-ant-{REPLACE_ME}'],
  },
  {
    name: 'openai_api_key_legacy',
    regex: 'sk-[A-Za-z0-9]{32,}',
    category: 'llm_api_key',
    severity: 'critical',
    replacement: '[REDACTED-OPENAI-KEY]',
    examples_match: ['sk-abcdef1234567890ABCDEF1234567890XYZ'],
    examples_skip: [
      'sk-',
      'sk-test_short',
      'sk-ant-api03-AbCd1234EfGh5678IjKl9012MnOp',
    ],
    ordering_note:
      'MUST run AFTER anthropic_api_key pattern — sk-ant- starts with sk- and is a subset match. Pattern engine applies patterns in declared order; first match wins per position.',
  },
  {
    name: 'openai_project_key',
    regex: 'sk-proj-[A-Za-z0-9_-]{20,}',
    category: 'llm_api_key',
    severity: 'critical',
    replacement: '[REDACTED-OPENAI-PROJ-KEY]',
    examples_match: ['sk-proj-AbCdEf1234567890_-AbCdEf12'],
    examples_skip: ['sk-proj-'],
  },
  {
    name: 'gemini_api_key',
    regex: 'AIza[A-Za-z0-9_-]{35}',
    category: 'llm_api_key',
    severity: 'critical',
    replacement: '[REDACTED-GEMINI-KEY]',
    examples_match: ['AIzaSyB_abcdef1234567890ABCDEFGHIJKLMN1234'],
    examples_skip: ['AIzaShort', 'AIza'],
  },
  {
    name: 'aws_access_key',
    regex: '(?:AKIA|ASIA)[A-Z0-9]{16}',
    category: 'cloud_credential',
    severity: 'critical',
    replacement: '[REDACTED-AWS-AK]',
    examples_match: ['AKIAIOSFODNN7EXAMPLE', 'ASIAIOSFODNN7EXAMPLE'],
    examples_skip: ['AKIA', 'AKIA-short', 'AKIA invalid format here'],
  },
  {
    name: 'stripe_live_secret',
    regex: 'sk_live_[A-Za-z0-9]{20,}',
    category: 'payment_credential',
    severity: 'critical',
    replacement: '[REDACTED-STRIPE-LIVE]',
    examples_match: ['sk_live_AbCdEf1234567890ABCDEFGH'],
    examples_skip: ['sk_live_', 'sk_test_AbCdEf1234567890ABCDEFGH'],
  },
  {
    name: 'stripe_test_secret',
    regex: 'sk_test_[A-Za-z0-9]{20,}',
    category: 'payment_credential',
    severity: 'warning',
    replacement: '[REDACTED-STRIPE-TEST]',
    examples_match: ['sk_test_AbCdEf1234567890ABCDEFGH'],
    examples_skip: ['sk_test_'],
  },
  {
    name: 'slack_bot_token',
    regex: 'xox[baprs]-[A-Za-z0-9-]{20,}',
    category: 'platform_token',
    severity: 'critical',
    replacement: '[REDACTED-SLACK-TOKEN]',
    examples_match: [
      'xoxb-1234567890-AbCdEfGh1234567890',
      'xoxp-1234567890-9876543210-abcdef',
    ],
    examples_skip: ['xox', 'xoxb-'],
  },
  {
    name: 'telegram_bot_token',
    regex: '[0-9]{8,12}:[A-Za-z0-9_-]{30,}',
    category: 'platform_token',
    severity: 'critical',
    replacement: '[REDACTED-TG-BOT-TOKEN]',
    examples_match: [
      '1234567890:AAH_abcdef1234567890ABCDEFGHIJKLMN1234567',
    ],
    examples_skip: [
      '1234567890:short',
      'msg_id: 1779056924724_98071983',
      '2026-05-18:05:00:00Z',
      'task_1779056924724_98071983',
      'chat_id:1779056924724_98071983',
      'timeout:12345678901234567890',
    ],
    fp_risk:
      'MEDIUM — colons in timestamps and IDs. Mitigated by requiring 30+ char base64-ish suffix. Watch the audit log on day 1 for legitimate matches in chat IDs.',
  },
];
