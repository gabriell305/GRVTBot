// H.6 — Backtest page.
// Pure simulation against historical GRVT candles. No orders are placed.
// Form on the left, result on the right (or stacked on mobile).
//
// "Apply to wizard" navigates to / with the inputs in router state, which
// OverviewPage reads to open the create-bot-wizard pre-filled.

import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { Play, ArrowRight, AlertTriangle } from 'lucide-react';
import { api } from '@/lib/api-client';
import { Card } from '@/components/primitives/card';
import { Button } from '@/components/primitives/button';
import { Input } from '@/components/primitives/input';
import { StatCard } from '@/components/primitives/stat-card';
import { EquityCurve, type EquityPoint } from '@/components/charts/equity-curve';
import { formatPercent, formatPnl, formatUsdCompact } from '@/lib/format';
import { useT } from '@/i18n';
import type {
  BacktestInput,
  BacktestResult,
  CandleInterval,
} from '@/lib/api-types';

interface FormState {
  pair: string;
  direction: 'long' | 'short' | 'neutral';
  leverage: string;
  lower: string;
  upper: string;
  grids: string;
  investment: string;
  feePct: string;
  interval: CandleInterval;
  limit: string;
}

const INITIAL: FormState = {
  pair: 'ETH_USDT_Perp',
  direction: 'long',
  leverage: '5',
  lower: '',
  upper: '',
  grids: '40',
  investment: '500',
  feePct: '0.05',
  interval: 'CI_1_H',
  limit: '500',
};

const INTERVAL_KEYS: Array<{ value: CandleInterval; key: string }> = [
  { value: 'CI_15_M', key: 'backtest.interval15m' },
  { value: 'CI_30_M', key: 'backtest.interval30m' },
  { value: 'CI_1_H', key: 'backtest.interval1h' },
  { value: 'CI_4_H', key: 'backtest.interval4h' },
  { value: 'CI_1_D', key: 'backtest.interval1d' },
];

const FALLBACK_PAIRS = [
  { value: 'ETH_USDT_Perp', label: 'ETH-USDT-Perp' },
  { value: 'BTC_USDT_Perp', label: 'BTC-USDT-Perp' },
  { value: 'SOL_USDT_Perp', label: 'SOL-USDT-Perp' },
];

export function BacktestPage() {
  const t = useT();
  const [form, setForm] = useState<FormState>(INITIAL);
  const navigate = useNavigate();

  const instrumentsQuery = useQuery({
    queryKey: ['instruments'],
    queryFn: () => api.getInstruments(),
    staleTime: 60_000,
  });

  const pairs = instrumentsQuery.data?.instruments
    ? (instrumentsQuery.data.instruments as Array<Record<string, unknown>>)
        .map((i) => (i.instrument ?? i.symbol ?? i.name) as string)
        .filter((name) => typeof name === 'string' && name.includes('_Perp'))
        .map((name) => ({ value: name, label: name.replace(/_/g, '-') }))
    : FALLBACK_PAIRS;

  const mutation = useMutation({
    mutationFn: (input: BacktestInput) => api.runBacktest(input),
  });

  const lower = parseFloat(form.lower);
  const upper = parseFloat(form.upper);
  const grids = parseInt(form.grids, 10);
  const investment = parseFloat(form.investment);
  const leverage = parseFloat(form.leverage);
  const feePct = parseFloat(form.feePct);
  const limit = parseInt(form.limit, 10);

  const errors: string[] = [];
  if (!form.pair) errors.push(t('backtest.validation.pairRequired'));
  if (!Number.isFinite(lower) || lower <= 0) errors.push(t('backtest.validation.lowerGt0'));
  if (!Number.isFinite(upper) || upper <= 0) errors.push(t('backtest.validation.upperGt0'));
  if (Number.isFinite(lower) && Number.isFinite(upper) && lower >= upper) errors.push(t('backtest.validation.lowerLtUpper'));
  if (!Number.isInteger(grids) || grids < 2) errors.push(t('backtest.validation.gridsMin'));
  if (!Number.isFinite(investment) || investment <= 0) errors.push(t('backtest.validation.investmentGt0'));
  if (!Number.isFinite(leverage) || leverage < 1) errors.push(t('backtest.validation.leverageMin'));
  if (!Number.isFinite(feePct) || feePct < 0 || feePct > 1) errors.push(t('backtest.validation.feeRange'));
  const isValid = errors.length === 0;

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((s) => ({ ...s, [key]: value }));
  }

  function run() {
    if (!isValid) return;
    mutation.mutate({
      pair: form.pair,
      direction: form.direction,
      leverage,
      lower_price: lower,
      upper_price: upper,
      num_grids: grids,
      investment_usdt: investment,
      fee_pct: feePct,
      interval: form.interval,
      limit,
    });
  }

  function applyToWizard() {
    navigate('/', {
      state: {
        presetWizard: {
          pair: form.pair,
          // "Neutral" backtest = flat observation; the live grid bot must be
          // long or short, so we coerce neutral to Long when applying.
          direction: form.direction === 'neutral' ? 'long' : form.direction,
          leverage,
          lower_price: lower,
          upper_price: upper,
          num_grids: grids,
          investment_usdt: investment,
        },
      },
    });
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          {t('backtest.title')}
        </h1>
        <p className="text-sm text-text-muted mt-1">
          {t('backtest.subtitle')}
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
        <Card className="lg:col-span-2 flex flex-col gap-4">
          <h2 className="text-sm font-semibold text-text-secondary uppercase tracking-wider">
            {t('backtest.parameters')}
          </h2>

          <div className="flex flex-col gap-1.5">
            <label className="text-2xs font-semibold uppercase tracking-wider text-text-muted">
              {t('backtest.pair')}
            </label>
            <select
              value={form.pair}
              onChange={(e) => update('pair', e.target.value)}
              className="h-10 px-3 rounded-md bg-bg-surface border border-border-subtle text-sm text-text-primary"
            >
              {pairs.map((p) => (
                <option key={p.value} value={p.value}>{p.label}</option>
              ))}
            </select>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <label className="text-2xs font-semibold uppercase tracking-wider text-text-muted">
                {t('backtest.direction')}
              </label>
              <select
                value={form.direction}
                onChange={(e) => update('direction', e.target.value as FormState['direction'])}
                className="h-10 px-3 rounded-md bg-bg-surface border border-border-subtle text-sm text-text-primary"
              >
                <option value="long">{t('backtest.directionLong')}</option>
                <option value="short">{t('backtest.directionShort')}</option>
                <option value="neutral">{t('backtest.directionNeutral')}</option>
              </select>
            </div>
            <Input
              label={t('backtest.leverage')}
              numeric
              value={form.leverage}
              onChange={(e) => update('leverage', e.target.value)}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Input
              label={t('backtest.lowerPrice')}
              numeric
              placeholder="e.g. 1800"
              value={form.lower}
              onChange={(e) => update('lower', e.target.value)}
            />
            <Input
              label={t('backtest.upperPrice')}
              numeric
              placeholder="e.g. 2400"
              value={form.upper}
              onChange={(e) => update('upper', e.target.value)}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Input
              label={t('backtest.grids')}
              numeric
              value={form.grids}
              onChange={(e) => update('grids', e.target.value)}
            />
            <Input
              label={t('backtest.investment')}
              numeric
              value={form.investment}
              onChange={(e) => update('investment', e.target.value)}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Input
              label={t('backtest.feePerSide')}
              numeric
              value={form.feePct}
              onChange={(e) => update('feePct', e.target.value)}
              helper={t('backtest.feeHelper')}
            />
            <Input
              label={t('backtest.candles')}
              numeric
              value={form.limit}
              onChange={(e) => update('limit', e.target.value)}
              helper={t('backtest.candlesHelper')}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-2xs font-semibold uppercase tracking-wider text-text-muted">
              {t('backtest.interval')}
            </label>
            <select
              value={form.interval}
              onChange={(e) => update('interval', e.target.value as CandleInterval)}
              className="h-10 px-3 rounded-md bg-bg-surface border border-border-subtle text-sm text-text-primary"
            >
              {INTERVAL_KEYS.map((i) => (
                <option key={i.value} value={i.value}>{t(i.key)}</option>
              ))}
            </select>
          </div>

          {!isValid && (
            <ul className="text-2xs text-danger flex flex-col gap-0.5">
              {errors.map((e) => (
                <li key={e}>· {e}</li>
              ))}
            </ul>
          )}

          <Button
            onClick={run}
            disabled={!isValid || mutation.isPending}
          >
            <Play className="size-4" />
            {mutation.isPending ? t('backtest.running') : t('backtest.runBtn')}
          </Button>
        </Card>

        <div className="lg:col-span-3 flex flex-col gap-4">
          {mutation.isError && (
            <Card className="border-danger/40">
              <p className="text-sm text-danger">
                {t('backtest.failedPrefix')} {(mutation.error as Error).message}
              </p>
            </Card>
          )}

          {!mutation.data && !mutation.isPending && !mutation.isError && (
            <Card>
              <p className="text-sm text-text-muted">
                {t('backtest.placeholder')}
              </p>
            </Card>
          )}

          {mutation.isPending && (
            <Card>
              <p className="text-sm text-text-muted animate-pulse">
                {t('backtest.fetching')}
              </p>
            </Card>
          )}

          {mutation.data && <ResultPanel result={mutation.data} onApply={applyToWizard} />}
        </div>
      </div>
    </div>
  );
}

function ResultPanel({
  result,
  onApply,
}: {
  result: BacktestResult;
  onApply: () => void;
}) {
  const t = useT();
  const points: EquityPoint[] = result.equityCurve.map((p) => ({
    date: new Date(p.time * 1000).toISOString().slice(0, 16).replace('T', ' '),
    equity: p.equity,
  }));

  const warnings: string[] = [];
  if (result.maxDrawdownPct > 30)
    warnings.push(t('backtest.warnHighDrawdown', { pct: result.maxDrawdownPct.toFixed(1) }));
  if (result.roundTrips < 5)
    warnings.push(t('backtest.warnFewTrips', { n: result.roundTrips }));
  if (result.netProfit <= 0) warnings.push(t('backtest.warnNoProfit'));

  return (
    <>
      <div className="grid grid-cols-2 md:grid-cols-3 gap-px bg-border-subtle rounded-lg overflow-hidden">
        <StatCard
          label={t('backtest.netProfit')}
          value={
            <span className={result.netProfit >= 0 ? 'text-success' : 'text-danger'}>
              {formatPnl(result.netProfit)}
            </span>
          }
        />
        <StatCard label={t('backtest.grossProfit')} value={formatPnl(result.totalProfit)} />
        <StatCard label={t('backtest.feesPaid')} value={formatPnl(-result.totalFees)} />
        <StatCard
          label={t('backtest.maxDrawdown')}
          value={
            <span className={result.maxDrawdownPct > 30 ? 'text-danger' : 'text-text-primary'}>
              {formatPercent(-result.maxDrawdownPct)}
            </span>
          }
        />
        <StatCard label={t('backtest.roundTrips')} value={String(result.roundTrips)} />
        <StatCard
          label={t('backtest.avgPerTrip')}
          value={formatPnl(result.avgProfitPerTrip)}
        />
        <StatCard
          label={t('backtest.profitFactor')}
          value={Number.isFinite(result.profitFactor) ? result.profitFactor.toFixed(2) : '∞'}
        />
        <StatCard label={t('backtest.daysInMarket')} value={`${result.daysInMarket}d`} />
        <StatCard label={t('backtest.candlesProcessed')} value={String(result.candlesProcessed)} />
      </div>

      <Card>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-text-secondary uppercase tracking-wider">
            {t('backtest.equityCurve')}
          </h2>
          <span className="text-2xs text-text-muted">
            {t('backtest.startsAt', { amount: formatUsdCompact(points[0]?.equity ?? 0) })}
          </span>
        </div>
        <EquityCurve points={points} height={260} />
      </Card>

      {warnings.length > 0 && (
        <Card className="border-warning/40">
          <div className="flex items-start gap-2">
            <AlertTriangle className="size-4 text-warning shrink-0 mt-0.5" />
            <ul className="text-xs text-text-secondary flex flex-col gap-1">
              {warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          </div>
        </Card>
      )}

      <div className="flex justify-end">
        <Button variant="secondary" onClick={onApply}>
          {t('backtest.applyToWizard')}
          <ArrowRight className="size-4" />
        </Button>
      </div>
    </>
  );
}
