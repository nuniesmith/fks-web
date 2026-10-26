/**
 * Everything the spawner runs or can run, as one list for the Tasks page.
 *
 * Three sources, merged by bot id:
 *   - template instances  GET /instances   (recorders, jobs, bots made from a form)
 *   - saved configs       GET /configs     (bots configured by hand, e.g. crypto-regime)
 *   - containers          GET /containers  (anything else Docker has: one-shot
 *                                           backtests, ad-hoc spawns)
 *
 * A saved config or instance with no container is still listed (it can be
 * started); a container with no config is listed so nothing running is
 * invisible. Pure, so the merge is unit-tested (tasks.test.ts).
 */
import { workloadKind, type WorkloadKind } from '$lib/accounts';
import type { BotConfig, ContainerInfo, Instance } from '$lib/types/spawner';

export interface TaskRow {
  key: string;
  name: string;
  botId: string;
  kind: WorkloadKind;
  source: 'instance' | 'config' | 'container';
  template: string | null;
  image: string;
  mode: string;
  account: string | null;
  dataDir: string | null;
  /** The bot's current container: the running one, else the newest. */
  container: ContainerInfo | null;
}

function containerFor(botId: string, containers: ContainerInfo[]): ContainerInfo | null {
  const mine = containers.filter((c) => c.bot_id === botId);
  return (
    mine.find((c) => c.state === 'running') ??
    [...mine].sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''))[0] ??
    null
  );
}

const KIND_ORDER: Record<WorkloadKind, number> = { bot: 0, recorder: 1, job: 2 };

export function buildTasks({
  configs,
  instances,
  containers,
}: {
  configs: BotConfig[];
  instances: Instance[];
  containers: ContainerInfo[];
}): TaskRow[] {
  const rows: TaskRow[] = [];
  const seen = new Set<string>();

  for (const i of instances) {
    seen.add(i.bot_id);
    rows.push({
      key: `instance:${i.name}`,
      name: i.name,
      botId: i.bot_id,
      kind: workloadKind(i.mode, i.kind),
      source: 'instance',
      template: i.template,
      image: i.image,
      mode: i.mode,
      account: null,
      dataDir: i.data_dir,
      container: containerFor(i.bot_id, containers),
    });
  }
  for (const c of configs) {
    if (c.template || c.template_unreadable) continue; // listed as an instance
    const botId = (c.bot_id && c.bot_id.trim()) || c.name;
    if (seen.has(botId)) continue;
    seen.add(botId);
    rows.push({
      key: `config:${c.name}`,
      name: c.name,
      botId,
      kind: workloadKind(c.mode),
      source: 'config',
      template: null,
      image: c.image,
      mode: c.mode,
      account: c.account ?? null,
      dataDir: null,
      container: containerFor(botId, containers),
    });
  }
  for (const k of containers) {
    if (!k.bot_id || seen.has(k.bot_id)) continue;
    seen.add(k.bot_id);
    rows.push({
      key: `container:${k.id}`,
      name: k.name || k.bot_id,
      botId: k.bot_id,
      kind: workloadKind(k.mode),
      source: 'container',
      template: null,
      image: k.image,
      mode: k.mode,
      account: null,
      dataDir: null,
      container: containerFor(k.bot_id, containers),
    });
  }

  const running = (r: TaskRow) => (r.container?.state === 'running' ? 0 : 1);
  return rows.sort(
    (a, b) => running(a) - running(b) || KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.name.localeCompare(b.name),
  );
}
