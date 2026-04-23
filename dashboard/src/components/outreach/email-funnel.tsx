import { cn } from '@/lib/utils';
import type { CampaignOverview } from '@/lib/data/outreach';

const STEPS_CFG = [
  {
    bar: 'bg-gradient-to-r from-violet-500/25 via-violet-500/15 to-violet-500/25 border-violet-500/25',
    num: 'text-violet-400',
    badge: 'bg-violet-500/10 text-violet-400 border border-violet-500/20',
    dot: 'bg-violet-400',
  },
  {
    bar: 'bg-gradient-to-r from-blue-500/25 via-blue-500/15 to-blue-500/25 border-blue-500/25',
    num: 'text-blue-400',
    badge: 'bg-blue-500/10 text-blue-400 border border-blue-500/20',
    dot: 'bg-blue-400',
  },
  {
    bar: 'bg-gradient-to-r from-sky-400/25 via-sky-400/15 to-sky-400/25 border-sky-400/25',
    num: 'text-sky-400',
    badge: 'bg-sky-400/10 text-sky-400 border border-sky-400/20',
    dot: 'bg-sky-400',
  },
  {
    bar: 'bg-gradient-to-r from-emerald-500/25 via-emerald-500/15 to-emerald-500/25 border-emerald-500/25',
    num: 'text-emerald-400',
    badge: 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20',
    dot: 'bg-emerald-400',
  },
  {
    bar: 'bg-gradient-to-r from-green-500/25 via-green-500/15 to-green-500/25 border-green-500/25',
    num: 'text-green-400',
    badge: 'bg-green-500/10 text-green-400 border border-green-500/20',
    dot: 'bg-green-400',
  },
] as const;

export function EmailFunnel({ data }: { data: CampaignOverview }) {
  const { campaign_lead_stats, unique_sent_count, unique_open_count, reply_count } = data;

  const steps = [
    { label: 'Total Leads', sub: 'in database', count: campaign_lead_stats.total },
    { label: 'Contacted', sub: 'unique recipients', count: unique_sent_count },
    { label: 'Opened', sub: 'unique opens', count: unique_open_count },
    { label: 'Replied', sub: 'responses', count: reply_count },
    { label: 'Completed', sub: 'sequence done', count: campaign_lead_stats.completed },
  ];

  const max = steps[0].count || 1;

  return (
    <div className="py-3 select-none">
      {steps.map((step, i) => {
        const cfg = STEPS_CFG[i];
        const prev = i > 0 ? steps[i - 1] : null;
        const convRate = prev && prev.count > 0 ? Math.round((step.count / prev.count) * 100) : null;
        const widthPct = step.count > 0 ? Math.max((step.count / max) * 100, 14) : 5;

        return (
          <div key={step.label}>
            {/* Conversion connector */}
            {i > 0 && (
              <div className="flex flex-col items-center py-1.5 gap-0.5">
                <div className="w-px h-3 bg-border/60" />
                {convRate !== null && (
                  <span className={cn('px-2.5 py-0.5 rounded-full text-[10px] font-semibold tabular-nums', cfg.badge)}>
                    ↓ {convRate}%
                  </span>
                )}
                <div className="w-px h-3 bg-border/60" />
              </div>
            )}

            {/* Centered funnel bar */}
            <div
              className={cn(
                'h-12 rounded-xl border flex items-center justify-between px-4 mx-auto transition-all duration-300',
                cfg.bar
              )}
              style={{ width: `${widthPct}%` }}
            >
              <div className="flex items-center gap-2 min-w-0">
                <div className={cn('h-1.5 w-1.5 rounded-full shrink-0', cfg.dot)} />
                <div className="min-w-0">
                  <p className="text-xs font-semibold text-foreground/80 leading-none truncate">{step.label}</p>
                  <p className="text-[10px] text-muted-foreground leading-none mt-0.5 truncate">{step.sub}</p>
                </div>
              </div>
              <span className={cn('text-xl font-bold tabular-nums shrink-0 ml-3', cfg.num)}>
                {step.count.toLocaleString()}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
