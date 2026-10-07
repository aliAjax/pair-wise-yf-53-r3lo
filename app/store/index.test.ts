import { beforeEach, describe, expect, it } from 'vitest';
import {
  activateTrain, clearConflict, confirmGate, deliverBatch, reorderGates, remoteFailure,
  remoteRecovered, replaceState, replaceStateMigrated, resolveBlocker, saveGateChange,
  store, type TrainState
} from './index';

function snapshot(): TrainState {
  return structuredClone(store.getState().train);
}
function resetToTrain() {
  const base = snapshot();
  return () => store.dispatch(replaceState(structuredClone(base)));
}
function train() {
  return store.getState().train.trains.find((t) => t.id === store.getState().train.activeId)!;
}
function gate(repo: string) {
  return train().gates.find((g) => g.repository === repo)!;
}
function batchRepoLists() {
  return train().batches.map((b) => b.gateIds.map((id) => train().gates.find((g) => g.id === id)!.repository));
}

describe('发布列车排程 store', () => {
  let restore: () => void;
  beforeEach(() => { restore = resetToTrain(); store.dispatch(activateTrain('train-101')); return () => restore(); });

  it('初始状态按依赖图自动分批：shared-ui/auth-sdk -> gateway -> web-console/data-sync', () => {
    expect(batchRepoLists()).toEqual([
      ['shared-ui', 'auth-sdk'],
      ['gateway'],
      ['web-console', 'data-sync']
    ]);
  });

  it('依赖变化时重算未交付批次：web-console 去掉对 gateway 的依赖后提前一批', () => {
    const rev = gate('web-console').rev;
    store.dispatch(saveGateChange({
      gateId: gate('web-console').id,
      expectedRev: rev,
      editor: '陈珂',
      patch: { dependsOn: ['shared-ui'] }
    }));
    expect(batchRepoLists()).toEqual([
      ['shared-ui', 'auth-sdk'],
      ['gateway', 'web-console'],
      ['data-sync']
    ]);
  });

  it('手动排序只在当前批内生效，且之后重算保留该顺序', () => {
    // 试图把 gateway（第 2 批）拖进第 1 批：被忽略
    store.dispatch(reorderGates({ activeId: gate('gateway').id, overId: gate('shared-ui').id }));
    expect(batchRepoLists()[0]).toEqual(['shared-ui', 'auth-sdk']);

    store.dispatch(reorderGates({ activeId: gate('auth-sdk').id, overId: gate('shared-ui').id }));
    expect(batchRepoLists()[0]).toEqual(['auth-sdk', 'shared-ui']);
    // 触发一次不改变拓扑的重算（确认某仓库），顺序仍保留
    store.dispatch(confirmGate({ gateId: gate('gateway').id, editor: '周扬' }));
    expect(batchRepoLists()[0]).toEqual(['auth-sdk', 'shared-ui']);
  });

  it('已交付批次锁定不倒回；后续修改只重算未处理仓库', () => {
    store.dispatch(resolveBlocker('b1'));
    expect(batchRepoLists()[0]).toEqual(['shared-ui', 'auth-sdk']);
    store.dispatch(deliverBatch({}));
    expect(train().batches[0]).toMatchObject({ state: 'delivered' });
    const lockedAt = train().batches[0].deliveredAt;

    // 关键阻断未关闭时放行被拦截
    expect(train().batches[1].state).toBe('planned');

    store.dispatch(confirmGate({ gateId: gate('gateway').id, editor: '周扬' }));
    store.dispatch(deliverBatch({}));
    expect(train().batches[1]).toMatchObject({ state: 'delivered' });

    // 修改已交付仓库与未处理仓库，已交付两批成员/时间均不变
    store.dispatch(saveGateChange({
      gateId: gate('auth-sdk').id, expectedRev: gate('auth-sdk').rev,
      editor: '林禾', patch: { dependsOn: ['shared-ui'] }
    }));
    store.dispatch(saveGateChange({
      gateId: gate('data-sync').id, expectedRev: gate('data-sync').rev,
      editor: '罗雨', patch: { dependsOn: ['gateway', 'web-console'] }
    }));
    expect(train().batches[0]).toMatchObject({ state: 'delivered', deliveredAt: lockedAt });
    expect(batchRepoLists()[0]).toEqual(['shared-ui', 'auth-sdk']);
    expect(batchRepoLists()[1]).toEqual(['gateway']);
    expect(batchRepoLists().slice(2)).toEqual([['web-console'], ['data-sync']]);
  });

  it('两人同改一个仓库：先写入者生效，后到者被拒并看到受影响仓库', () => {
    const id = gate('gateway').id;
    store.dispatch(saveGateChange({ gateId: id, expectedRev: 0, editor: '周扬', patch: { owner: '周扬(主)' } }));
    expect(gate('gateway').rev).toBe(1);
    expect(gate('gateway').owner).toBe('周扬(主)');

    // 罗雨基于旧版本 r0 写入
    store.dispatch(saveGateChange({ gateId: id, expectedRev: 0, editor: '罗雨', patch: { owner: '罗雨' } }));
    const conflict = train().conflict!;
    expect(conflict).toBeTruthy();
    expect(conflict.winner).toBe('周扬');
    expect(conflict.loser).toBe('罗雨');
    expect(conflict.currentRev).toBe(1);
    expect(gate('gateway').owner).toBe('周扬(主)'); // 后到者未覆盖
    expect(conflict.affected).toEqual(['web-console', 'data-sync']);

    // 拉取最新版本后重试成功
    store.dispatch(clearConflict());
    store.dispatch(saveGateChange({ gateId: id, expectedRev: 1, editor: '罗雨', patch: { owner: '罗雨' } }));
    expect(gate('gateway').owner).toBe('罗雨');
    expect(train().conflict).toBeNull();
  });

  it('远端故障期间保留上一次可发布批次，恢复后只重算未处理仓库', () => {
    const before = batchRepoLists();
    store.dispatch(remoteFailure());
    expect(train().remoteReady).toBe(false);
    expect(train().scheduleSnapshot).toBeTruthy();

    // 故障期间编辑依赖：不触发重算，只标记 dirty，可发布批次原样保留
    store.dispatch(saveGateChange({
      gateId: gate('web-console').id, expectedRev: 0,
      editor: '陈珂', patch: { dependsOn: ['shared-ui'] }
    }));
    expect(train().scheduleDirty).toBe(true);
    expect(batchRepoLists()).toEqual(before);

    // 放行在故障期间被拦截（UI 层），状态本身允许恢复前冻结不变
    store.dispatch(remoteRecovered({ checkedAt: '2026-10-07T10:00:00Z' }));
    expect(train().remoteReady).toBe(true);
    expect(train().scheduleSnapshot).toBeNull();
    expect(train().scheduleDirty).toBe(false);
    // 故障期间的变更已并入：web-console 提前到 gateway 同批，未处理仓库完成重算
    expect(batchRepoLists()).toEqual([
      ['shared-ui', 'auth-sdk'],
      ['gateway', 'web-console'],
      ['data-sync']
    ]);
  });

  it('旧版本 localStorage 数据（dependency 字符串 + 无 batches）可迁移并自动补算分批', () => {
    const legacy = {
      activeId: 'old-train',
      trains: [{
        id: 'old-train',
        name: '旧列车',
        freezeAt: '2026-09-30 18:00',
        status: 'preparing',
        gates: [
          { id: 'g1', repository: 'auth-sdk', owner: '林禾', dependency: 'lodash@4.0', status: 'confirmed', version: '2.1.0' },
          { id: 'g2', repository: 'gateway', owner: '周扬', dependency: 'auth-sdk@2.1', status: 'pending', version: '2.12.0' }
        ],
        blockers: [],
        audit: []
      }]
    };
    store.dispatch(replaceStateMigrated(legacy));
    const t = train();
    expect(t.gates[0].dependsOn).toEqual([]);
    expect(t.gates[0].externalDependency).toBe('lodash@4.0');
    expect(t.gates[1].dependsOn).toEqual(['auth-sdk']);
    expect(t.remoteReady).toBe(true);
    expect(t.batches.map((b) => b.gateIds)).toEqual([['g1'], ['g2']]);
  });
});
