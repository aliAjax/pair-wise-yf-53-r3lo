import { configureStore, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { createApi, fakeBaseQuery } from '@reduxjs/toolkit/query/react';
import { affectedRepositories, recomputeBatches, type RecomputeResult } from '../lib/schedule';

export type GateStatus = 'pending' | 'confirmed' | 'blocked';

export interface RepositoryGate {
  id: string;
  repository: string;
  owner: string;
  /** 仓库所依赖的其它仓库名（必须在本列车依赖图中的才参与分批） */
  dependsOn: string[];
  /** 旧版本数据中的外部依赖描述，仅用于展示，不参与拓扑分层 */
  externalDependency?: string;
  status: GateStatus;
  version: string;
  /** 乐观锁版本：任何写入 +1，后到者必须带上自己读取时的 rev */
  rev: number;
  /** 最近一次成功写入者，用于并发冲突时指明先到者 */
  lastWriter?: string;
}

export type BatchState = 'planned' | 'delivered';

export interface Batch {
  id: string;
  index: number;
  gateIds: string[];
  state: BatchState;
  deliveredAt?: string;
}

export interface ConflictInfo {
  gateId: string;
  repository: string;
  /** 先写入者 */
  winner: string;
  /** 被拒绝的后到者 */
  loser: string;
  /** 目标仓库变更后会被牵动的未交付下游仓库 */
  affected: string[];
  at: string;
  staleRev: number;
  currentRev: number;
}

export interface ReleaseTrain {
  id: string;
  name: string;
  freezeAt: string;
  status: 'preparing' | 'frozen' | 'rolled-back';
  gates: RepositoryGate[];
  batches: Batch[];
  blockers: Array<{ id: string; title: string; severity: 'warning' | 'critical'; resolved: boolean }>;
  audit: Array<{ id: string; at: string; text: string }>;
  remoteReady: boolean;
  remoteCheckedAt: string | null;
  /** 远端查询失败期间保留的上一次可发布批次快照 */
  scheduleSnapshot: Batch[] | null;
  /** 故障期间有编辑待重算，恢复后只重算未处理仓库 */
  scheduleDirty: boolean;
  conflict: ConflictInfo | null;
  lastRecompute: { cycles: string[][]; at: string; reason: string } | null;
}

export interface TrainState {
  activeId: string;
  trains: ReleaseTrain[];
}

let auditSeq = 0;
function audit(text: string) {
  auditSeq += 1;
  return { id: `a-${Date.now()}-${auditSeq}`, at: new Date().toLocaleTimeString(), text };
}

function initialBatches(gates: RepositoryGate[]): Batch[] {
  return recomputeBatches(gates, []).batches;
}

const initial: TrainState = {
  activeId: 'train-101',
  trains: [{
    id: 'train-101',
    name: 'Sept 2026 发布列车',
    freezeAt: '2026-09-30 18:00',
    status: 'preparing',
    gates: [
      { id: 'g1', repository: 'shared-ui', owner: '陈珂', dependsOn: [], status: 'confirmed', version: '4.2.0', rev: 0 },
      { id: 'g2', repository: 'auth-sdk', owner: '林禾', dependsOn: [], status: 'confirmed', version: '2.1.0', rev: 0 },
      { id: 'g3', repository: 'gateway', owner: '周扬', dependsOn: ['auth-sdk'], status: 'pending', version: '2.12.0', rev: 0 },
      { id: 'g4', repository: 'web-console', owner: '陈珂', dependsOn: ['shared-ui', 'gateway'], status: 'pending', version: '4.8.0', rev: 0 },
      { id: 'g5', repository: 'data-sync', owner: '罗雨', dependsOn: ['gateway'], status: 'blocked', version: '1.9.4', rev: 0 }
    ],
    batches: [],
    blockers: [
      { id: 'b1', title: 'data-sync 依赖的网关版本尚未确认', severity: 'critical', resolved: false },
      { id: 'b2', title: '移动端发布说明缺少回滚章节', severity: 'warning', resolved: false }
    ],
    audit: [audit('创建发布列车并关联 5 个仓库，按依赖图自动分批')],
    remoteReady: true,
    remoteCheckedAt: null,
    scheduleSnapshot: null,
    scheduleDirty: false,
    conflict: null,
    lastRecompute: null
  }]
};
initial.trains[0].batches = initialBatches(initial.trains[0].gates);

/** 旧版本（手动拖拽时代）持久化数据迁移：dependency 字符串 -> dependsOn，并补算批次。 */
function migrateTrain(raw: any): ReleaseTrain {
  const gates: RepositoryGate[] = (raw.gates ?? []).map((g: any, i: number) => {
    let dependsOn: string[] = Array.isArray(g.dependsOn) ? g.dependsOn : [];
    let externalDependency: string | undefined;
    if (typeof g.dependency === 'string') {
      const depName = g.dependency.split('@')[0];
      const repoNames = new Set((raw.gates ?? []).map((x: any) => x.repository));
      if (repoNames.has(depName)) dependsOn = [depName];
      else externalDependency = g.dependency;
    }
    return { ...g, dependsOn, externalDependency, rev: typeof g.rev === 'number' ? g.rev : i };
  });
  const train: ReleaseTrain = {
    ...raw,
    gates,
    batches: Array.isArray(raw.batches) && raw.batches.length > 0 ? raw.batches : recomputeBatches(gates, []).batches,
    remoteReady: raw.remoteReady ?? true,
    remoteCheckedAt: raw.remoteCheckedAt ?? null,
    scheduleSnapshot: raw.scheduleSnapshot ?? null,
    scheduleDirty: raw.scheduleDirty ?? false,
    conflict: raw.conflict ?? null,
    lastRecompute: raw.lastRecompute ?? null
  };
  return train;
}

function migrateState(raw: any): TrainState {
  return {
    activeId: raw.activeId,
    trains: (raw.trains ?? []).map(migrateTrain)
  };
}

/**
 * 重算当前列车的未处理仓库。
 * 已交付批次永远原样保留；远端故障期间只标记 dirty，批次快照保持不变。
 */
function reschedule(train: ReleaseTrain, reason: string): RecomputeResult | null {
  if (!train.remoteReady) {
    train.scheduleDirty = true;
    return null;
  }
  const result = recomputeBatches(train.gates, train.batches);
  train.batches = result.batches;
  train.lastRecompute = { cycles: result.cycles, at: new Date().toLocaleTimeString(), reason };
  if (result.cycles.length > 0) {
    train.audit.unshift(audit(`重算发现依赖环：${result.cycles.flat().join('、')}，环上仓库归入末批待人工破除`));
  }
  return result;
}

const trainSlice = createSlice({
  name: 'train',
  initialState: initial,
  reducers: {
    createTrain(state, action: PayloadAction<{ name: string; freezeAt: string }>) {
      const id = `train-${Date.now()}`;
      const train: ReleaseTrain = {
        id, ...action.payload, status: 'preparing', gates: [], batches: [], blockers: [],
        audit: [audit('创建发布列车')],
        remoteReady: true, remoteCheckedAt: null, scheduleSnapshot: null, scheduleDirty: false,
        conflict: null, lastRecompute: null
      };
      state.trains.push(train);
      state.activeId = id;
    },
    activateTrain(state, action: PayloadAction<string>) { state.activeId = action.payload; },

    confirmGate(state, action: PayloadAction<{ gateId: string; editor: string }>) {
      const train = state.trains.find((t) => t.id === state.activeId);
      const gate = train?.gates.find((g) => g.id === action.payload.gateId);
      if (!train || !gate) return;
      const firstPlanned = train.batches.find((b) => b.state === 'planned');
      if (firstPlanned && !firstPlanned.gateIds.includes(gate.id)) {
        train.audit.unshift(audit(`${gate.repository} 不在当前批次，确认被忽略（按批次顺序放行）`));
        return;
      }
      gate.status = 'confirmed';
      gate.rev += 1;
      gate.lastWriter = action.payload.editor;
      train.audit.unshift(audit(`${gate.repository} 门禁由 ${action.payload.editor} 确认`));
      // 确认不改变拓扑，但需求要求确认变化同样重算（本批确认顺序会被保留）
      reschedule(train, `负责人确认：${gate.repository}`);
    },

    /**
     * 两人同时改同一仓库：调用方必须带上读取时的 expectedRev。
     * 先写入者 rev+1 生效；后到者 expectedRev 落后，写入被拒并返回受影响下游。
     */
    saveGateChange(state, action: PayloadAction<{
      gateId: string;
      expectedRev: number;
      editor: string;
      patch: Partial<Pick<RepositoryGate, 'owner' | 'dependsOn' | 'version' | 'status'>>;
    }>) {
      const train = state.trains.find((t) => t.id === state.activeId);
      const gate = train?.gates.find((g) => g.id === action.payload.gateId);
      if (!train || !gate) return;
      const { expectedRev, editor, patch } = action.payload;

      if (gate.rev !== expectedRev) {
        train.conflict = {
          gateId: gate.id,
          repository: gate.repository,
          winner: gate.lastWriter ?? '另一位维护者',
          loser: editor,
          affected: affectedRepositories(train.gates, gate.id, train.batches.filter((b) => b.state === 'delivered')),
          at: new Date().toLocaleTimeString(),
          staleRev: expectedRev,
          currentRev: gate.rev
        };
        train.audit.unshift(audit(`并发冲突：${editor} 对 ${gate.repository} 的写入被拒（版本 r${expectedRev} 已过期，当前 r${gate.rev}），请刷新后基于受影响仓库重排`));
        return;
      }

      train.conflict = null;
      const changed: string[] = [];
      if (patch.owner !== undefined && patch.owner !== gate.owner) { gate.owner = patch.owner; changed.push('负责人'); }
      if (patch.version !== undefined && patch.version !== gate.version) { gate.version = patch.version; changed.push('版本'); }
      if (patch.status !== undefined && patch.status !== gate.status) { gate.status = patch.status; changed.push('确认状态'); }
      if (patch.dependsOn) {
        const before = gate.dependsOn.slice().sort().join(',');
        const next = Array.from(new Set(patch.dependsOn.map((s) => s.trim()).filter(Boolean)));
        if (next.sort().join(',') !== before) { gate.dependsOn = next; changed.push('依赖'); }
      }
      gate.rev += 1;
      gate.lastWriter = editor;
      if (changed.length > 0) {
        train.audit.unshift(audit(`${editor} 保存 ${gate.repository}（r${gate.rev}）：变更 ${changed.join('、')}`));
        reschedule(train, `依赖/确认变更：${gate.repository}（${editor}）`);
      }
    },

    clearConflict(state) {
      const train = state.trains.find((t) => t.id === state.activeId);
      if (train) train.conflict = null;
    },

    addGate(state, action: PayloadAction<{ repository: string; owner: string; version: string; dependsOn: string[] }>) {
      const train = state.trains.find((t) => t.id === state.activeId);
      if (!train) return;
      if (train.gates.some((g) => g.repository === action.payload.repository)) return;
      train.gates.push({ id: `g-${Date.now()}`, status: 'pending', rev: 0, ...action.payload });
      train.audit.unshift(audit(`新增仓库 ${action.payload.repository} 并重算分批`));
      reschedule(train, `新增仓库：${action.payload.repository}`);
    },

    /** 手动排序只允许在当前批次内部进行；重算后该顺序仍会被保留（稳定分层）。 */
    reorderGates(state, action: PayloadAction<{ activeId: string; overId: string }>) {
      const train = state.trains.find((t) => t.id === state.activeId);
      if (!train) return;
      const batch = train.batches.find((b) => b.state === 'planned');
      if (!batch || !batch.gateIds.includes(action.payload.activeId) || !batch.gateIds.includes(action.payload.overId)) {
        train.audit.unshift(audit('拖拽排序仅限当前批次内部，跨批顺序由依赖关系决定'));
        return;
      }
      const from = batch.gateIds.indexOf(action.payload.activeId);
      const to = batch.gateIds.indexOf(action.payload.overId);
      const [moved] = batch.gateIds.splice(from, 1);
      batch.gateIds.splice(to, 0, moved);
      // 同步 gates 的相对顺序，使 orderRank 下次重算时保留该排列
      const gFrom = train.gates.findIndex((g) => g.id === moved);
      const overGate = train.gates.find((g) => g.id === action.payload.overId)!;
      const gTo = train.gates.findIndex((g) => g.id === overGate.id);
      const [gm] = train.gates.splice(gFrom, 1);
      train.gates.splice(gTo, 0, gm);
      reschedule(train, '当前批次内手动调整顺序');
      train.audit.unshift(audit(`当前批次内调整顺序：${gm.repository}`));
    },

    /** 放行当前批次：已交付后永不倒回，随后只重算未处理仓库。 */
    deliverBatch(state, action: PayloadAction<{ reasons?: string[] }>) {
      const train = state.trains.find((t) => t.id === state.activeId);
      if (!train) return;
      const idx = train.batches.findIndex((b) => b.state === 'planned');
      if (idx < 0) return;
      if (action.payload.reasons && action.payload.reasons.length > 0) {
        train.audit.unshift(audit(`批次 ${idx + 1} 放行被拦截：${action.payload.reasons.join('；')}`));
        return;
      }
      const batch = train.batches[idx];
      batch.state = 'delivered';
      batch.deliveredAt = new Date().toLocaleTimeString();
      const names = batch.gateIds.map((id) => train.gates.find((g) => g.id === id)?.repository).join('、');
      train.audit.unshift(audit(`批次 ${batch.index + 1} 已交付并锁定：${names}，后续仓库自动重算`));
      reschedule(train, `批次 ${batch.index + 1} 交付，重算未处理仓库`);
    },

    setFreeze(state, action: PayloadAction<ReleaseTrain['status']>) {
      const train = state.trains.find((t) => t.id === state.activeId);
      if (!train) return;
      train.status = action.payload;
      train.audit.unshift(audit(`状态调整为 ${action.payload}`));
    },
    resolveBlocker(state, action: PayloadAction<string>) {
      const train = state.trains.find((t) => t.id === state.activeId);
      const blocker = train?.blockers.find((item) => item.id === action.payload);
      if (!train || !blocker) return;
      blocker.resolved = true;
      train.audit.unshift(audit(`阻断项已关闭：${blocker.title}`));
    },

    /** 远端依赖查询失败：冻结当前可发布计划快照，不再重算。 */
    remoteFailure(state, _action: PayloadAction<void>) {
      const train = state.trains.find((t) => t.id === state.activeId);
      if (!train || !train.remoteReady) return;
      train.remoteReady = false;
      train.scheduleSnapshot = train.batches.map((b) => ({ ...b, gateIds: [...b.gateIds] }));
      train.audit.unshift(audit('远端依赖查询失败：保留上一次可发布批次，未处理仓库暂停重算'));
    },

    /** 远端恢复：沿用快照中的已交付/本批结构，只对未处理仓库重算一次。 */
    remoteRecovered(state, action: PayloadAction<{ checkedAt: string }>) {
      const train = state.trains.find((t) => t.id === state.activeId);
      if (!train || train.remoteReady) return;
      train.remoteReady = true;
      train.remoteCheckedAt = action.payload.checkedAt;
      if (train.scheduleSnapshot) train.batches = train.scheduleSnapshot;
      train.scheduleSnapshot = null;
      reschedule(train, '远端依赖查询恢复，重算未处理仓库');
      train.audit.unshift(audit(train.scheduleDirty
        ? '远端依赖查询恢复：已交付批次保持不变，故障期间的变更已并入，未处理仓库重算完成'
        : '远端依赖查询恢复：上一次可发布批次继续有效，未处理仓库重算完成'));
      train.scheduleDirty = false;
    },

    replaceState(_state, action: PayloadAction<TrainState>) { return action.payload; },
    replaceStateMigrated(_state, action: PayloadAction<any>) { return migrateState(action.payload); }
  }
});

/** 远端依赖服务的模拟开关：UI 可切换“故障/恢复”。 */
let remoteUp = true;
export function setRemoteSimulation(up: boolean) { remoteUp = up; }

export const releaseApi = createApi({
  reducerPath: 'releaseApi',
  baseQuery: fakeBaseQuery(),
  tagTypes: ['health'],
  endpoints: (builder) => ({
    getTrainHealth: builder.query<{ ready: boolean; checkedAt: string }, string>({
      queryFn: async (id) => {
        await new Promise((resolve) => setTimeout(resolve, 250));
        if (!remoteUp || id === 'offline') {
          return { error: { status: 'FETCH_ERROR' as const, data: '远端依赖查询失败' } };
        }
        return { data: { ready: true, checkedAt: new Date().toISOString() } };
      },
      providesTags: ['health']
    })
  })
});

export const { useGetTrainHealthQuery } = releaseApi;
export const {
  activateTrain, addGate, clearConflict, confirmGate, createTrain, deliverBatch,
  reorderGates, remoteFailure, remoteRecovered, replaceState, replaceStateMigrated,
  resolveBlocker, saveGateChange, setFreeze
} = trainSlice.actions;

export const store = configureStore({
  reducer: { train: trainSlice.reducer, [releaseApi.reducerPath]: releaseApi.reducer },
  middleware: (getDefault) => getDefault().concat(releaseApi.middleware)
});

if (typeof window !== 'undefined') {
  const saved = localStorage.getItem('yf53-release-state');
  if (saved) {
    try {
      const parsed = JSON.parse(saved);
      store.dispatch(replaceStateMigrated(parsed));
    } catch {
      /* 持久化数据损坏时退回初始示例 */
    }
  }
  store.subscribe(() => localStorage.setItem('yf53-release-state', JSON.stringify(store.getState().train)));
}

export type RootState = ReturnType<typeof store.getState>;
