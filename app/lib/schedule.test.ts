import { describe, expect, it } from 'vitest';
import type { Batch, RepositoryGate } from '../store';
import { affectedRepositories, checkBatchReleasable, recomputeBatches } from './schedule';
import type { ReleaseTrain } from '../store';

function gate(id: string, repository: string, dependsOn: string[] = [], status: RepositoryGate['status'] = 'confirmed'): RepositoryGate {
  return { id, repository, owner: `owner-${id}`, dependsOn, status, version: '1.0.0', rev: 0 };
}

function delivered(ids: string[], index = 0): Batch {
  return { id: `d-${index}`, index, gateIds: ids, state: 'delivered', deliveredAt: '10:00' };
}
function planned(ids: string[], index: number): Batch {
  return { id: `p-${index}`, index, gateIds: ids, state: 'planned' };
}

describe('recomputeBatches', () => {
  it('按依赖边做拓扑分层：无依赖仓库第一批，依赖者进入后续批次', () => {
    const gates = [
      gate('g1', 'web', ['shared', 'api']),
      gate('g2', 'shared'),
      gate('g3', 'api', ['shared'])
    ];
    const { batches, cycles } = recomputeBatches(gates, []);
    expect(cycles).toEqual([]);
    expect(batches.map((b) => b.gateIds)).toEqual([
      ['g2'],
      ['g3'],
      ['g1']
    ]);
  });

  it('已交付批次整体冻结，重算不会把已交付仓库倒回未处理批次', () => {
    const gates = [gate('g1', 'shared'), gate('g2', 'api', ['shared']), gate('g3', 'web', ['api'])];
    const prev = [delivered(['g1'], 0), planned(['g2', 'g3'], 1)];
    const { batches } = recomputeBatches(gates, prev);
    expect(batches[0]).toMatchObject({ state: 'delivered', gateIds: ['g1'], deliveredAt: '10:00' });
    expect(batches.slice(1).map((b) => b.gateIds)).toEqual([['g2'], ['g3']]);
  });

  it('依赖变更后同层仓库沿用上一次的相对顺序（本批确认的排列被保留）', () => {
    const gates = [gate('a', 'alpha'), gate('b', 'beta'), gate('c', 'gamma'), gate('d', 'delta')];
    const prev = [planned(['b', 'a', 'd', 'c'], 0)];
    const { batches } = recomputeBatches(gates, prev);
    expect(batches[0].gateIds).toEqual(['b', 'a', 'd', 'c']);
  });

  it('新增依赖把仓库压到后一批，且不影响其在同层内的稳定排序', () => {
    const gates = [
      gate('a', 'alpha'),
      gate('b', 'beta', ['alpha'])
    ];
    const { batches } = recomputeBatches(gates, [planned(['a', 'b'], 0)]);
    expect(batches.map((b) => b.gateIds)).toEqual([['a'], ['b']]);
  });

  it('依赖环不会冻结整列车：环上仓库沉入最后一批并上报', () => {
    const gates = [
      gate('x', 'x-svc', ['y-svc']),
      gate('y', 'y-svc', ['x-svc']),
      gate('z', 'z-svc')
    ];
    const { batches, cycles } = recomputeBatches(gates, []);
    expect(batches[0].gateIds).toEqual(['z']);
    expect(batches[1].gateIds.sort()).toEqual(['x', 'y']);
    expect(cycles.flat().sort()).toEqual(['x-svc', 'y-svc']);
  });

  it('外部组件（不在依赖图中的仓库名）不阻塞分层', () => {
    const gates = [gate('a', 'alpha', ['lodash@4'])];
    const { batches } = recomputeBatches(gates, []);
    expect(batches).toHaveLength(1);
  });
});

describe('affectedRepositories', () => {
  it('返回目标仓库的未交付传递下游，已交付仓库截断传播', () => {
    const gates = [
      gate('a', 'alpha'),
      gate('b', 'beta', ['alpha']),
      gate('c', 'gamma', ['beta']),
      gate('d', 'delta', ['alpha'])
    ];
    expect(affectedRepositories(gates, 'a', [])).toEqual(['beta', 'delta', 'gamma']);
    expect(affectedRepositories(gates, 'a', [delivered(['b'])])).toEqual(['delta']);
  });
});

describe('checkBatchReleasable', () => {
  const baseTrain = (status: ReleaseTrain['status'], gates: RepositoryGate[]): ReleaseTrain => ({
    id: 't', name: 't', freezeAt: 'now', status, gates,
    batches: recomputeBatches(gates, []).batches,
    blockers: [], audit: [], remoteReady: true, remoteCheckedAt: null,
    scheduleSnapshot: null, scheduleDirty: false, conflict: null, lastRecompute: null
  });

  it('门禁全确认 + 无关键阻断 + 远端可达才允许放行', () => {
    const gates = [gate('a', 'alpha', [], 'pending')];
    const train = baseTrain('preparing', gates);
    expect(checkBatchReleasable(train, train.batches[0], true).ok).toBe(false);
    gates[0].status = 'confirmed';
    expect(checkBatchReleasable(train, train.batches[0], true).ok).toBe(true);
    expect(checkBatchReleasable(train, train.batches[0], false).ok).toBe(false);
    train.blockers = [{ id: 'b', title: '关键问题', severity: 'critical', resolved: false }];
    expect(checkBatchReleasable(train, train.batches[0], true).ok).toBe(false);
  });
});
