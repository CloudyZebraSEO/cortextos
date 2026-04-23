import {
  IconUsers,
  IconMailForward,
  IconEye,
  IconMessageReply,
  IconAlertTriangle,
} from '@tabler/icons-react';
import { cn } from '@/lib/utils';
import type { CampaignOverview } from '@/lib/data/outreach';

type Highlight = 'good' | 'warn' | 'bad' | 'neutral';

interface KpiCardProps {
  label: string;
  value: string | number;
  sublabel: string;
  icon: React.ReactNode;
  highlight?: Highlight;
}

const H: Record<Highlight, { border: string; from: string; icon: string; value: string }> = {
  good: {
    border: 'border-t-emerald-500',
    from: 'from-emerald-500/8',
    icon: 'bg-emerald-500/15 text-emerald-500',
    value: 'text-emerald-500',
  },
  warn: {
    border: 'border-t-amber-500',
    from: 'from-amber-500/8',
    icon: 'bg-amber-500/15 text-amber-500',
    value: 'text-amber-500',
  },
  bad: {
    border: 'border-t-destructive',
    from: 'from-destructive/8',
    icon: 'bg-destructive/15 text-destructive',
    value: 'text-destructive',
  },
  neutral: {
    border: 'border-t-primary/50',
    from: 'from-primary/5',
    icon: 'bg-primary/10 text-primary',
    value: 'text-foreground',
  },
};

function KpiCard({ label, value, sublabel, icon, highlight = 'neutral' }: KpiCardProps) {
  const s = H[highlight];
  return (
    <div className={cn(
      'rounded-xl border border-t-2 bg-gradient-to-b to-transparent p-5 transition-shadow hover:shadow-sm',
      s.border,
      s.from,
    )}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
            {label}
          </p>
          <p className={cn('mt-2.5 text-[2.1rem] font-bold tabular-nums leading-none tracking-tight', s.value)}>
            {value}
          </p>
          <p className="mt-2 text-xs text-muted-foreground truncate">{sublabel}</p>
        </div>
        <div className={cn('rounded-xl p-2.5 shrink-0 mt-0.5', s.icon)}>
          {icon}
        </div>
      </div>
    </div>
  );
}

export function OutreachKpis({ data }: { data: CampaignOverview }) {
  const { sent_count, unique_sent_count, open_count, reply_count, bounce_count, campaign_lead_stats } = data;
  const openRate = sent_count ? Math.round((open_count / sent_count) * 100) : 0;
  const replyRate = sent_count ? Math.round((reply_count / sent_count) * 100) : 0;
  const bounceRate = sent_count ? Math.round((bounce_count / sent_count) * 100) : 0;

  return (
    <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
      <KpiCard
        label="Leads Queued"
        value={campaign_lead_stats.notStarted.toLocaleString()}
        sublabel={`of ${campaign_lead_stats.total.toLocaleString()} total`}
        icon={<IconUsers size={20} />}
        highlight={campaign_lead_stats.notStarted > 0 ? 'warn' : 'good'}
      />
      <KpiCard
        label="Contacted"
        value={unique_sent_count.toLocaleString()}
        sublabel={`${sent_count.toLocaleString()} emails sent`}
        icon={<IconMailForward size={20} />}
        highlight="neutral"
      />
      <KpiCard
        label="Open Rate"
        value={`${openRate}%`}
        sublabel={`${open_count.toLocaleString()} unique opens`}
        icon={<IconEye size={20} />}
        highlight={openRate >= 50 ? 'good' : openRate >= 30 ? 'warn' : sent_count > 0 ? 'bad' : 'neutral'}
      />
      <KpiCard
        label="Reply Rate"
        value={`${replyRate}%`}
        sublabel={`${reply_count} ${reply_count === 1 ? 'reply' : 'replies'}`}
        icon={<IconMessageReply size={20} />}
        highlight={replyRate >= 5 ? 'good' : replyRate >= 1 ? 'warn' : sent_count > 0 ? 'bad' : 'neutral'}
      />
      <KpiCard
        label="Bounce Rate"
        value={`${bounceRate}%`}
        sublabel={`${bounce_count} bounces`}
        icon={<IconAlertTriangle size={20} />}
        highlight={bounceRate === 0 ? 'neutral' : bounceRate <= 5 ? 'warn' : 'bad'}
      />
    </div>
  );
}
