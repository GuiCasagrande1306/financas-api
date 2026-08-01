import cron from 'node-cron';
import { refreshIndicators } from '../modules/indicators/indicators.service';

/**
 * Robô das taxas: atualiza SELIC/CDI a partir do BCB.
 * - Roda uma vez no boot (best-effort) — importante no free tier do Render, que
 *   hiberna e pode perder o horário agendado.
 * - Agenda para todo dia às 03:00 (America/Sao_Paulo).
 * Nunca derruba o servidor: falhas do BCB só geram um warning.
 */
export function startIndicatorsScheduler() {
  const run = () =>
    refreshIndicators()
      .then((r) => console.log(`📈 Indicadores atualizados (BCB): SELIC ${r.SELIC}% · CDI ${r.CDI}%`))
      .catch((e) => console.warn('⚠️  Falha ao atualizar indicadores do BCB:', (e as Error).message));

  run();
  cron.schedule('0 3 * * *', run, { timezone: 'America/Sao_Paulo' });
  console.log('⏰ Cron de indicadores agendado (03:00 America/Sao_Paulo)');
}
