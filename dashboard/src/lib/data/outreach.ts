import fs from 'fs';
import path from 'path';
import os from 'os';

const CAMPAIGN_ID = 3097774;
const BASE_URL = 'https://server.smartlead.ai/api/v1';

function getApiKey(): string {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.smartlead', 'config.json'), 'utf8'));
    return cfg.api_key ?? '';
  } catch {
    return process.env.SMARTLEAD_API_KEY ?? '';
  }
}

async function slFetch<T>(endpoint: string, params: Record<string, string> = {}): Promise<T> {
  const key = getApiKey();
  const url = new URL(`${BASE_URL}${endpoint}`);
  url.searchParams.set('api_key', key);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url.toString(), { cache: 'no-store' });
  if (!res.ok) throw new Error(`SmartLead API error ${res.status}: ${await res.text()}`);
  return res.json() as Promise<T>;
}

// --- Types ---

export interface CampaignOverview {
  id: number;
  name: string;
  status: string;
  sent_count: number;
  unique_sent_count: number;
  open_count: number;
  unique_open_count: number;
  reply_count: number;
  bounce_count: number;
  click_count: number;
  sequence_count: number;
  campaign_lead_stats: {
    total: number;
    notStarted: number;
    inprogress: number;
    completed: number;
    blocked: number;
    paused: number;
    stopped: number;
  };
}

export interface EmailAccount {
  id: number;
  from_name: string;
  from_email: string;
  daily_sent_count: number;
  message_per_day: number;
  is_smtp_success: boolean;
  is_imap_success: boolean;
  warmup_details: {
    status: string;
    warmup_reputation: string;
    total_sent_count: number;
    total_spam_count: number;
  };
}

export interface SequenceStep {
  email_campaign_seq_id: number;
  sent_count: number;
  open_count: number;
  reply_count: number;
  bounce_count: number;
  positive_reply_count: number;
}

export interface CampaignLead {
  campaign_lead_map_id: string;
  status: string;
  created_at: string;
  lead: {
    id: number;
    first_name: string | null;
    last_name: string | null;
    email: string;
    company_name: string | null;
    custom_fields: {
      source_opener?: string;
      email_1_body?: string;
    };
  };
}

// --- Data functions ---

export async function getCampaignOverview(): Promise<CampaignOverview> {
  return slFetch<CampaignOverview>(`/campaigns/${CAMPAIGN_ID}/analytics`);
}

export async function getEmailAccounts(): Promise<EmailAccount[]> {
  return slFetch<EmailAccount[]>(`/campaigns/${CAMPAIGN_ID}/email-accounts`);
}

export async function getSequenceAnalytics(): Promise<SequenceStep[]> {
  const now = new Date();
  const end = now.toISOString().split('T')[0];
  const start = new Date(now.getFullYear(), now.getMonth() - 2, 1).toISOString().split('T')[0];
  const res = await slFetch<{ ok: boolean; data: SequenceStep[] }>(
    `/campaigns/${CAMPAIGN_ID}/sequence-analytics`,
    { start_date: start, end_date: end }
  );
  return res.data ?? [];
}

export async function getCampaignLeads(): Promise<CampaignLead[]> {
  const res = await slFetch<{ total_leads: string; data: CampaignLead[] }>(
    `/campaigns/${CAMPAIGN_ID}/leads`,
    { limit: '200', offset: '0' }
  );
  return res.data ?? [];
}

// --- CRM (local file) ---

export interface CrmLead {
  id: string;
  firstName: string;
  lastName: string;
  firm: string;
  email: string;
  website: string;
  phone?: string;
  city: string;
  state: string;
  source: string;
  sourceDetail: string;
  status: 'new' | 'enriched' | 'approved' | 'loaded' | 'sent' | 'replied' | 'converted';
  tags: string[];
  icp: string;
  enrichedAt: string | null;
  loadedAt: string | null;
  smartleadCampaignId: string | null;
  notes: string[];
}

const CRM_PATH = '/Users/cortextos/cortextos/orgs/cointally/agents/tallybot/deliverables/crm/leads.json';

export function getCrmLeads(): CrmLead[] {
  try {
    const raw = fs.readFileSync(CRM_PATH, 'utf8');
    const data = JSON.parse(raw);
    return Object.values(data.leads ?? {}) as CrmLead[];
  } catch {
    return [];
  }
}

// --- Computed helpers ---

export function pct(num: number, denom: number): string {
  if (!denom) return '—';
  return `${Math.round((num / denom) * 100)}%`;
}
