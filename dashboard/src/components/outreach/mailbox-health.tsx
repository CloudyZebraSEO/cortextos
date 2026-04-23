import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { EmailAccount } from '@/lib/data/outreach';

function MailboxCard({ account }: { account: EmailAccount }) {
  const warmupStatus = account.warmup_details?.status ?? 'UNKNOWN';
  const reputation = account.warmup_details?.warmup_reputation ?? '—';
  const warmupSent = account.warmup_details?.total_sent_count ?? 0;
  const dailySent = account.daily_sent_count ?? 0;
  const limit = account.message_per_day ?? 1;
  const sendPct = Math.min((dailySent / limit) * 100, 100);
  const smtpOk = account.is_smtp_success;
  const imapOk = account.is_imap_success;
  const warmupActive = warmupStatus === 'ACTIVE';
  const fullyHealthy = smtpOk && imapOk && warmupActive;

  return (
    <div className={cn(
      'rounded-xl border bg-card p-4 space-y-4 transition-colors',
      !smtpOk || !imapOk ? 'border-destructive/40 bg-destructive/[0.03]' : ''
    )}>
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold truncate">{account.from_name}</p>
          <p className="text-xs text-muted-foreground truncate mt-0.5">{account.from_email}</p>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <div className={cn('h-2 w-2 rounded-full ring-2 ring-card', warmupActive ? 'bg-emerald-500' : 'bg-muted-foreground/40')} />
          <Badge
            variant="outline"
            className={cn(
              'text-[10px] h-5',
              warmupActive
                ? 'border-emerald-500/30 text-emerald-500 bg-emerald-500/5'
                : 'border-muted-foreground/20 text-muted-foreground'
            )}
          >
            warmup {warmupStatus.toLowerCase()}
          </Badge>
        </div>
      </div>

      {/* Send capacity */}
      <div className="space-y-2">
        <div className="flex justify-between items-baseline gap-2">
          <span className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Daily sends</span>
          <div className="tabular-nums">
            <span className="text-sm font-bold">{dailySent}</span>
            <span className="text-xs text-muted-foreground"> / {limit}</span>
          </div>
        </div>
        <div className="h-2 rounded-full bg-muted overflow-hidden">
          <div
            className={cn(
              'h-full rounded-full transition-all duration-500',
              dailySent === 0 ? 'w-0' : sendPct >= 80 ? 'bg-emerald-500' : 'bg-primary'
            )}
            style={{ width: `${sendPct}%` }}
          />
        </div>
        {dailySent === 0 && (
          <p className="text-[10px] font-medium text-amber-500">No sends recorded today</p>
        )}
      </div>

      {/* Connection status + reputation */}
      <div className="flex items-center justify-between gap-3 pt-0.5">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-1.5">
            <div className={cn('h-2 w-2 rounded-full', smtpOk ? 'bg-emerald-500' : 'bg-destructive')} />
            <span className={cn('text-[11px] font-medium', smtpOk ? 'text-foreground/70' : 'text-destructive')}>SMTP</span>
          </div>
          <div className="flex items-center gap-1.5">
            <div className={cn('h-2 w-2 rounded-full', imapOk ? 'bg-emerald-500' : 'bg-destructive')} />
            <span className={cn('text-[11px] font-medium', imapOk ? 'text-foreground/70' : 'text-destructive')}>IMAP</span>
          </div>
        </div>
        <div className="text-right">
          <p className="text-[10px] text-muted-foreground">Reputation</p>
          <p className="text-xs font-bold">{reputation}</p>
        </div>
      </div>

      {/* Warmup total */}
      {warmupSent > 0 && (
        <div className="rounded-lg bg-muted/40 px-3 py-2 flex justify-between items-center">
          <span className="text-[10px] text-muted-foreground uppercase tracking-wide font-medium">Warmup sends total</span>
          <span className="text-xs font-bold tabular-nums">{warmupSent.toLocaleString()}</span>
        </div>
      )}
    </div>
  );
}

export function MailboxHealth({ accounts }: { accounts: EmailAccount[] }) {
  if (!accounts.length) {
    return <p className="text-sm text-muted-foreground text-center py-4">No mailboxes found</p>;
  }
  return (
    <div className="space-y-3">
      {accounts.map((a) => (
        <MailboxCard key={a.id} account={a} />
      ))}
    </div>
  );
}
