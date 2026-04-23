import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { SequenceStep } from '@/lib/data/outreach';

function calcPct(num: number, denom: number): { str: string; val: number } {
  if (!denom) return { str: '—', val: 0 };
  const v = Math.round((num / denom) * 100);
  return { str: `${v}%`, val: v };
}

interface HeatCellProps {
  value: number;
  denom: number;
  barColor: string;
  goodThreshold?: number;
  warnThreshold?: number;
  invertScale?: boolean;
}

function HeatCell({ value, denom, barColor, goodThreshold = 50, warnThreshold = 20, invertScale = false }: HeatCellProps) {
  const { str, val } = calcPct(value, denom);
  const isEmpty = str === '—';
  const isGood = invertScale ? val <= goodThreshold : val >= goodThreshold;
  const isWarn = !isGood && (invertScale ? val <= warnThreshold : val >= warnThreshold);

  return (
    <TableCell className="text-right relative overflow-hidden">
      {!isEmpty && val > 0 && (
        <div
          className={cn('absolute inset-y-0 left-0 opacity-15 rounded-r', barColor)}
          style={{ width: `${Math.min(val * 1.5, 90)}%` }}
        />
      )}
      <span className={cn(
        'relative text-xs tabular-nums font-medium',
        isEmpty ? 'text-muted-foreground/40' :
        isGood ? 'text-emerald-500' :
        isWarn ? 'text-foreground/80' :
        'text-muted-foreground'
      )}>
        {str}
      </span>
    </TableCell>
  );
}

export function SequenceTable({ steps }: { steps: SequenceStep[] }) {
  if (!steps.length) {
    return (
      <div className="py-10 text-center">
        <p className="text-sm text-muted-foreground">No sequence data available</p>
        <p className="text-xs text-muted-foreground/60 mt-1">Data appears once emails start sending</p>
      </div>
    );
  }

  const bestOpenIdx = steps.reduce(
    (best, s, i) =>
      s.open_count / (s.sent_count || 1) > steps[best].open_count / (steps[best].sent_count || 1) ? i : best,
    0
  );

  return (
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead className="w-20 font-semibold text-xs uppercase tracking-wide">Step</TableHead>
          <TableHead className="text-right font-semibold text-xs uppercase tracking-wide">Sent</TableHead>
          <TableHead className="text-right font-semibold text-xs uppercase tracking-wide">Open %</TableHead>
          <TableHead className="text-right font-semibold text-xs uppercase tracking-wide">Reply %</TableHead>
          <TableHead className="text-right font-semibold text-xs uppercase tracking-wide">Bounce %</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {steps.map((step, i) => {
          const isBest = i === bestOpenIdx && step.sent_count > 0;
          return (
            <TableRow
              key={step.email_campaign_seq_id}
              className={cn('transition-colors', isBest && 'bg-primary/[0.04]')}
            >
              <TableCell>
                <div className="flex items-center gap-2">
                  <span className={cn(
                    'flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-bold',
                    isBest ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'
                  )}>
                    {i + 1}
                  </span>
                  {isBest && step.sent_count > 0 && (
                    <Badge variant="outline" className="text-[9px] px-1.5 py-0 h-4 border-primary/30 text-primary">
                      best
                    </Badge>
                  )}
                </div>
              </TableCell>
              <TableCell className="text-right text-xs tabular-nums font-semibold text-foreground/80">
                {step.sent_count.toLocaleString()}
              </TableCell>
              <HeatCell
                value={step.open_count}
                denom={step.sent_count}
                barColor="bg-sky-500"
                goodThreshold={50}
                warnThreshold={25}
              />
              <HeatCell
                value={step.reply_count}
                denom={step.sent_count}
                barColor="bg-emerald-500"
                goodThreshold={5}
                warnThreshold={2}
              />
              <HeatCell
                value={step.bounce_count}
                denom={step.sent_count}
                barColor="bg-amber-500"
                goodThreshold={2}
                warnThreshold={5}
                invertScale
              />
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
