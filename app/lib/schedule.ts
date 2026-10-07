import type { Batch, ReleaseTrain, RepositoryGate } from '../store';

export interface RecomputeResult {
  batches: Batch[];
  /** 依赖环中的仓库名（按环分组），无法分层时会落到最后一批 */
  cycles: string[][];
}

/**
 * 依据当前依赖图对「未交付」的仓库重新分层分批。
 *
 * 不变量：
 * - state === 'delivered' 的批次整体冻结，顺序、成员、确认状态一律不动（已交付不倒回）；
 * - 未交付仓库按依赖边做 Kahn 分层：依赖已交付或已入更早层的仓库才能进入当前层；
 * - 同一层内沿用上一次计划的相对顺序，其次采用 gates 数组顺序——
 *   因此手动排定、且新依赖图仍允许同批的确认会按新顺序保留；
 * - 依赖指向已删除仓库或外部组件（图中不存在）时视为外部已可用，不阻塞分层；
 * - 出现依赖环时，环上仓库整体沉到最后一批并通过 cycles 上报，不冻结整列车。
 */
export function recomputeBatches(gates: RepositoryGate[], prevBatches: Batch[]): RecomputeResult {
  const byRepo = new Map(gates.map((g) => [g.repository, g]));
  const delivered = prevBatches.filter((b) => b.state === 'delivered');
  const lockedGateIds = new Set(delivered.flatMap((b) => b.gateIds));

  const candidates = gates.filter((g) => !lockedGateIds.has(g.id));
  const candidateIds = new Set(candidates.map((g) => g.id));

  // 上一次未交付计划的平铺顺序，作为同层稳定排序的首选依据
  const orderRank = new Map<string, number>();
  let rank = 0;
  for (const b of prevBatches) {
    if (b.state === 'delivered') continue;
    for (const id of b.gateIds) {
      if (candidateIds.has(id) && !orderRank.has(id)) orderRank.set(id, rank++);
    }
  }
  gates.forEach((g, i) => {
    if (!orderRank.has(g.id)) orderRank.set(g.id, 1_000_000 + i);
  });

  // 仅统计候选集合内部的依赖边（指向已交付批次 = 已可用）
  const depsOf = new Map<string, Set<string>>();
  for (const g of candidates) {
    const set = new Set<string>();
    for (const dep of g.dependsOn) {
      const depGate = byRepo.get(dep);
      if (depGate && candidateIds.has(depGate.id)) set.add(depGate.id);
    }
    depsOf.set(g.id, set);
  }

  const layers: string[][] = [];
  const placed = new Set<string>();
  let remaining = candidates.map((g) => g.id);

  while (remaining.length > 0) {
    const ready = remaining.filter((id) => [...(depsOf.get(id) ?? [])].every((d) => placed.has(d)));
    if (ready.length === 0) break; // 剩余节点成环
    ready.sort((a, b) => (orderRank.get(a) ?? 0) - (orderRank.get(b) ?? 0));
    layers.push(ready);
    ready.forEach((id) => placed.add(id));
    remaining = remaining.filter((id) => !placed.has(id));
  }

  const cycles: string[][] = [];
  if (remaining.length > 0) {
    cycles.push(remaining.map((id) => gates.find((g) => g.id === id)?.repository ?? id));
    remaining.sort((a, b) => (orderRank.get(a) ?? 0) - (orderRank.get(b) ?? 0));
    layers.push(remaining);
  }

  const planned: Batch[] = layers.map((gateIds, i) => ({
    id: `planned-${delivered.length + i}`,
    index: delivered.length + i,
    gateIds,
    state: 'planned'
  }));

  return { batches: [...delivered.map((b) => ({ ...b })), ...planned], cycles };
}

/**
 * 反向追溯：目标仓库发生变更后，哪些「未交付」仓库会被它牵动（含传递依赖）。
 * 已交付批次里的仓库不受影响，也不再向下游传播。
 */
export function affectedRepositories(gates: RepositoryGate[], targetGateId: string, deliveredBatches: Batch[]): string[] {
  const target = gates.find((g) => g.id === targetGateId);
  if (!target) return [];
  const locked = new Set(deliveredBatches.flatMap((b) => b.gateIds));
  const result = new Set<string>();
  const queue = [target.repository];
  const seen = new Set(queue);

  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const g of gates) {
      if (locked.has(g.id) || seen.has(g.repository)) continue;
      if (g.dependsOn.includes(current)) {
        seen.add(g.repository);
        result.add(g.repository);
        queue.push(g.repository);
      }
    }
  }
  return [...result];
}

export interface ReleaseCheck {
  ok: boolean;
  reasons: string[];
  cycle: boolean;
}

/** 一批是否可发布：本批门禁全部确认、无未关闭的关键阻断、远端依赖服务可达。 */
export function checkBatchReleasable(
  train: ReleaseTrain,
  batch: Batch,
  remoteReady: boolean
): ReleaseCheck {
  const reasons: string[] = [];
  const inBatch = batch.gateIds
    .map((id) => train.gates.find((g) => g.id === id))
    .filter((g): g is RepositoryGate => Boolean(g));

  const unconfirmed = inBatch.filter((g) => g.status !== 'confirmed');
  if (unconfirmed.length > 0) reasons.push(`门禁未确认：${unconfirmed.map((g) => g.repository).join('、')}`);
  if (train.blockers.some((b) => !b.resolved && b.severity === 'critical')) {
    reasons.push('存在未关闭的关键阻断项');
  }
  if (!remoteReady) reasons.push('远端依赖查询失败，无法获取放行确认');
  if (train.status !== 'preparing') reasons.push(`列车当前为 ${train.status} 状态`);

  const cycleRepos = new Set(recomputeBatches(train.gates, train.batches).cycles.flat());
  const cycle = inBatch.some((g) => cycleRepos.has(g.repository));
  if (cycle) reasons.push('批次内存在依赖环，需先破除循环依赖');
  return { ok: reasons.length === 0, reasons, cycle };
}

/** 当前可操作批次（第一个未交付批次）。 */
export function activeBatch(train: ReleaseTrain): Batch | undefined {
  return train.batches.find((b) => b.state === 'planned');
}

export function deliveredBatches(train: ReleaseTrain): Batch[] {
  return train.batches.filter((b) => b.state === 'delivered');
}
