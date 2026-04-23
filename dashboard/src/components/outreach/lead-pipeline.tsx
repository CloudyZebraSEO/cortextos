'use client';

import { useState } from 'react';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { cn } from '@/lib/utils';
import { IconSearch, IconChevronDown, IconChevronRight, IconExternalLink } from '@tabler/icons-react';
import type { CrmLead } from '@/lib/data/outreach';

// --- Status config ---

const STATUS_CFG: Record<string, { dot: string; text: string; bg: string; label: string }> = {
  new:       { dot: 'bg-muted-foreground/30', text: 'text-muted-foreground',           bg: '',                        label: 'New'       },
  enriched:  { dot: 'bg-amber-400',           text: 'text-amber-500',                  bg: 'bg-amber-500/5',          label: 'Enriched'  },
  approved:  { dot: 'bg-blue-400',            text: 'text-blue-500',                   bg: 'bg-blue-500/5',           label: 'Approved'  },
  loaded:    { dot: 'bg-primary',             text: 'text-primary',                    bg: 'bg-primary/5',            label: 'In SmartLead' },
  sent:      { dot: 'bg-sky-400',             text: 'text-sky-500',                    bg: 'bg-sky-500/5',            label: 'Sent'      },
  replied:   { dot: 'bg-emerald-500',         text: 'text-emerald-500',                bg: 'bg-emerald-500/5',        label: 'Replied'   },
  converted: { dot: 'bg-emerald-600',         text: 'text-emerald-600',                bg: 'bg-emerald-600/5',        label: 'Converted' },
};

function getStatusCfg(status: string) {
  return STATUS_CFG[status] ?? STATUS_CFG['new'];
}

// --- Tab config ---

type Tab = 'All' | 'Not Sent' | 'In SmartLead' | 'Replied' | 'Converted';

const TABS: Tab[] = ['All', 'Not Sent', 'In SmartLead', 'Replied', 'Converted'];

function tabMatch(tab: Tab, status: string): boolean {
  if (tab === 'All') return true;
  if (tab === 'Not Sent') return ['new', 'enriched', 'approved'].includes(status);
  if (tab === 'In SmartLead') return ['loaded', 'sent'].includes(status);
  if (tab === 'Replied') return status === 'replied';
  if (tab === 'Converted') return status === 'converted';
  return false;
}

function tabCount(leads: CrmLead[], tab: Tab): number {
  return tab === 'All' ? leads.length : leads.filter((l) => tabMatch(tab, l.status)).length;
}

// --- Helpers ---

function LeadAvatar({ name }: { name: string }) {
  const initials = !name || name === '—'
    ? '?'
    : name.split(' ').map((w) => w[0]).filter(Boolean).slice(0, 2).join('').toUpperCase();
  return (
    <div className="h-7 w-7 rounded-full bg-primary/10 text-primary text-[10px] font-bold flex items-center justify-center shrink-0 ring-1 ring-primary/15">
      {initials}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const cfg = getStatusCfg(status);
  return (
    <div className="flex items-center gap-1.5">
      <div className={cn('h-1.5 w-1.5 rounded-full shrink-0', cfg.dot)} />
      <span className={cn('text-xs font-medium', cfg.text)}>{cfg.label}</span>
    </div>
  );
}

// --- Main component ---

export function LeadPipeline({ leads }: { leads: CrmLead[] }) {
  const [activeTab, setActiveTab] = useState<Tab>('All');
  const [search, setSearch] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const filtered = leads.filter((l) => {
    if (!tabMatch(activeTab, l.status)) return false;
    if (search) {
      const q = search.toLowerCase();
      return (
        (l.firstName ?? '').toLowerCase().includes(q) ||
        (l.lastName ?? '').toLowerCase().includes(q) ||
        l.email.toLowerCase().includes(q) ||
        (l.firm ?? '').toLowerCase().includes(q) ||
        (l.city ?? '').toLowerCase().includes(q) ||
        (l.state ?? '').toLowerCase().includes(q) ||
        (l.source ?? '').toLowerCase().includes(q)
      );
    }
    return true;
  });

  // Sort: replied first, then by enrichedAt desc
  const sorted = [...filtered].sort((a, b) => {
    const order = ['replied', 'converted', 'sent', 'loaded', 'approved', 'enriched', 'new'];
    const ai = order.indexOf(a.status);
    const bi = order.indexOf(b.status);
    if (ai !== bi) return ai - bi;
    const at = a.enrichedAt ?? a.loadedAt ?? '';
    const bt = b.enrichedAt ?? b.loadedAt ?? '';
    return bt.localeCompare(at);
  });

  return (
    <div className="space-y-3">
      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-1.5">
        {TABS.map((tab) => {
          const count = tabCount(leads, tab);
          const active = activeTab === tab;
          return (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-all',
                active
                  ? 'bg-primary/10 text-primary shadow-sm ring-1 ring-primary/20'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground'
              )}
            >
              {tab}
              <span className={cn(
                'rounded-md px-1.5 py-0.5 text-[10px] tabular-nums font-semibold',
                active ? 'bg-primary/20 text-primary' : 'bg-muted text-muted-foreground'
              )}>
                {count}
              </span>
            </button>
          );
        })}
        <div className="ml-auto">
          <div className="relative">
            <IconSearch size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search name, firm, email, city..."
              className="h-8 pl-8 text-xs w-60 bg-muted/30 border-muted focus-visible:bg-background"
            />
          </div>
        </div>
      </div>

      {/* Table */}
      <div className="rounded-xl border overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent border-b bg-muted/20">
              <TableHead className="w-8 pl-3" />
              <TableHead className="font-semibold text-xs uppercase tracking-wide">Name</TableHead>
              <TableHead className="font-semibold text-xs uppercase tracking-wide">Firm</TableHead>
              <TableHead className="font-semibold text-xs uppercase tracking-wide">Location</TableHead>
              <TableHead className="font-semibold text-xs uppercase tracking-wide">Email</TableHead>
              <TableHead className="font-semibold text-xs uppercase tracking-wide">Source</TableHead>
              <TableHead className="font-semibold text-xs uppercase tracking-wide">Status</TableHead>
              <TableHead className="text-right font-semibold text-xs uppercase tracking-wide pr-3">Added</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sorted.length === 0 && (
              <TableRow>
                <TableCell colSpan={8} className="py-12 text-center">
                  <p className="text-sm text-muted-foreground">No leads found</p>
                </TableCell>
              </TableRow>
            )}
            {sorted.map((l) => {
              const isExpanded = expandedId === l.id;
              const name = [l.firstName, l.lastName].filter(Boolean).join(' ') || '—';
              const location = [l.city, l.state].filter(Boolean).join(', ') || '—';
              const added = l.enrichedAt ?? l.loadedAt;
              const addedStr = added
                ? new Date(added).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
                : '—';
              const cfg = getStatusCfg(l.status);

              return (
                <>
                  <TableRow
                    key={l.id}
                    className={cn(
                      'cursor-pointer transition-colors',
                      isExpanded ? 'bg-muted/30' : 'hover:bg-muted/20',
                      cfg.bg && !isExpanded ? cfg.bg : ''
                    )}
                    onClick={() => setExpandedId(isExpanded ? null : l.id)}
                  >
                    <TableCell className="pl-3 text-muted-foreground/50">
                      {isExpanded
                        ? <IconChevronDown size={13} />
                        : <IconChevronRight size={13} />
                      }
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2.5">
                        <LeadAvatar name={name} />
                        <span className="font-medium text-sm">{name}</span>
                      </div>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground max-w-[160px] truncate">
                      {l.firm || '—'}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                      {location}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {l.email}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground max-w-[140px] truncate">
                      {l.source || '—'}
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={l.status} />
                    </TableCell>
                    <TableCell className="text-right text-xs text-muted-foreground tabular-nums pr-3">
                      {addedStr}
                    </TableCell>
                  </TableRow>

                  {isExpanded && (
                    <TableRow key={`${l.id}-exp`} className="bg-muted/10 hover:bg-muted/10">
                      <TableCell className="pl-3" />
                      <TableCell colSpan={7} className="py-3 pr-3">
                        <div className="space-y-2.5">
                          {l.sourceDetail && (
                            <div className="rounded-lg bg-muted/40 border px-3 py-2.5">
                              <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground mb-1.5">Personalized opener</p>
                              <p className="text-xs text-foreground/80 leading-relaxed">{l.sourceDetail}</p>
                            </div>
                          )}
                          <div className="flex items-center gap-4 flex-wrap">
                            {l.website && (
                              <a
                                href={l.website}
                                target="_blank"
                                rel="noopener noreferrer"
                                onClick={(e) => e.stopPropagation()}
                                className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                              >
                                <IconExternalLink size={11} />
                                {l.website.replace(/^https?:\/\//, '')}
                              </a>
                            )}
                            {l.phone && (
                              <span className="text-xs text-muted-foreground">{l.phone}</span>
                            )}
                            {l.loadedAt && (
                              <span className="text-xs text-muted-foreground">
                                Loaded to SmartLead: {new Date(l.loadedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                              </span>
                            )}
                            {l.smartleadCampaignId && (
                              <span className="text-xs text-muted-foreground">Campaign #{l.smartleadCampaignId}</span>
                            )}
                            {l.tags?.length > 0 && (
                              <div className="flex gap-1">
                                {l.tags.map((t) => (
                                  <span key={t} className="text-[10px] bg-muted rounded px-1.5 py-0.5 text-muted-foreground">{t}</span>
                                ))}
                              </div>
                            )}
                          </div>
                        </div>
                      </TableCell>
                    </TableRow>
                  )}
                </>
              );
            })}
          </TableBody>
        </Table>
      </div>
      <p className="text-xs text-muted-foreground text-right">
        Showing {sorted.length} of {leads.length} leads
      </p>
    </div>
  );
}
