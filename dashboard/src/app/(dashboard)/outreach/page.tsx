import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { OutreachKpis } from '@/components/outreach/outreach-kpis';
import { EmailFunnel } from '@/components/outreach/email-funnel';
import { SequenceTable } from '@/components/outreach/sequence-table';
import { MailboxHealth } from '@/components/outreach/mailbox-health';
import { LeadPipeline } from '@/components/outreach/lead-pipeline';
import {
  IconMailForward,
  IconAlertTriangle,
  IconCircleCheck,
  IconRefresh,
} from '@tabler/icons-react';
import {
  getCampaignOverview,
  getEmailAccounts,
  getSequenceAnalytics,
  getCrmLeads,
} from '@/lib/data/outreach';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default async function OutreachPage() {
  const [overview, accounts, sequences] = await Promise.all([
    getCampaignOverview().catch(() => null),
    getEmailAccounts().catch(() => []),
    getSequenceAnalytics().catch(() => []),
  ]);
  const leads = getCrmLeads();

  const updatedAt = new Date().toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  });

  const hasMailboxIssue = accounts.length > 0 && accounts.some((a) => !a.is_smtp_success || !a.is_imap_success);
  const noSends = overview && overview.sent_count === 0 && (overview.campaign_lead_stats.notStarted > 0);

  return (
    <div className="space-y-6 p-6 max-w-[1400px] mx-auto">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 pb-1">
        <div className="space-y-1.5">
          <div className="flex items-center gap-2.5">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary/10 text-primary">
              <IconMailForward size={20} />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-2xl font-bold tracking-tight">Cold Email Outreach</h1>
                {overview && (
                  <Badge
                    variant="outline"
                    className={
                      overview.status === 'ACTIVE'
                        ? 'border-emerald-500/30 text-emerald-500 bg-emerald-500/5 font-semibold'
                        : 'border-amber-500/30 text-amber-500 bg-amber-500/5 font-semibold'
                    }
                  >
                    {overview.status === 'ACTIVE' && <span className="mr-1 inline-block h-1.5 w-1.5 rounded-full bg-emerald-500" />}
                    {overview.status.toLowerCase()}
                  </Badge>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                {overview?.name ?? 'CPA Outreach Production'} · {overview?.campaign_lead_stats.total ?? 0} leads · Updated {updatedAt}
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Alert banners */}
      {(hasMailboxIssue || noSends) && (
        <div className="space-y-2">
          {hasMailboxIssue && (
            <div className="rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 flex items-start gap-3">
              <IconAlertTriangle size={15} className="text-destructive shrink-0 mt-0.5" />
              <div>
                <p className="text-sm font-semibold text-destructive">Mailbox connection issue detected</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  One or more senders failed SMTP/IMAP checks. Emails cannot be delivered until connections are restored in SmartLead.
                </p>
              </div>
            </div>
          )}
          {noSends && !hasMailboxIssue && (
            <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 px-4 py-3 flex items-start gap-3">
              <IconAlertTriangle size={15} className="text-amber-500 shrink-0 mt-0.5" />
              <div>
                <p className="text-sm font-semibold text-amber-600 dark:text-amber-400">No emails sent yet</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {overview?.campaign_lead_stats.notStarted} leads are queued and ready. Check your sending window and mailbox warm-up status in SmartLead.
                </p>
              </div>
            </div>
          )}
        </div>
      )}

      {!overview ? (
        <Card>
          <CardContent className="py-16 text-center text-muted-foreground">
            <div className="flex flex-col items-center gap-3">
              <div className="h-10 w-10 rounded-full bg-muted flex items-center justify-center">
                <IconRefresh size={18} className="text-muted-foreground" />
              </div>
              <p className="text-sm font-medium">Unable to connect to SmartLead</p>
              <p className="text-xs text-muted-foreground/70">Check your API key configuration</p>
            </div>
          </CardContent>
        </Card>
      ) : (
        <>
          {/* KPIs */}
          <OutreachKpis data={overview} />

          {/* Funnel */}
          <Card className="overflow-hidden">
            <CardHeader className="border-b bg-muted/20 pb-3">
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="text-sm font-semibold">Email Funnel</CardTitle>
                  <CardDescription className="text-xs mt-0.5">Lead progression through the outreach sequence</CardDescription>
                </div>
                {overview.sent_count > 0 && (
                  <div className="flex items-center gap-1.5 text-xs text-emerald-500 font-medium">
                    <IconCircleCheck size={13} />
                    Sending active
                  </div>
                )}
              </div>
            </CardHeader>
            <CardContent className="pt-4">
              <EmailFunnel data={overview} />
            </CardContent>
          </Card>

          {/* Sequences + Mailbox Health */}
          <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
            <Card className="lg:col-span-3 overflow-hidden">
              <CardHeader className="border-b bg-muted/20 pb-3">
                <CardTitle className="text-sm font-semibold">Sequence Performance</CardTitle>
                <CardDescription className="text-xs mt-0.5">Per-step open, reply, and bounce rates</CardDescription>
              </CardHeader>
              <CardContent className="p-0">
                <SequenceTable steps={sequences} />
              </CardContent>
            </Card>

            <Card className="lg:col-span-2 overflow-hidden">
              <CardHeader className="border-b bg-muted/20 pb-3">
                <CardTitle className="text-sm font-semibold">Mailbox Health</CardTitle>
                <CardDescription className="text-xs mt-0.5">Sender status and daily send capacity</CardDescription>
              </CardHeader>
              <CardContent className="pt-4">
                <MailboxHealth accounts={accounts} />
              </CardContent>
            </Card>
          </div>

          {/* Lead Pipeline */}
          <Card className="overflow-hidden">
            <CardHeader className="border-b bg-muted/20 pb-3">
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="text-sm font-semibold">Lead Pipeline</CardTitle>
                  <CardDescription className="text-xs mt-0.5">
                    {leads.length} leads total — full CRM including pre-SmartLead pipeline
                  </CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent className="pt-4">
              <LeadPipeline leads={leads} />
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
