import { configureStore, createSlice, nanoid, type PayloadAction } from '@reduxjs/toolkit';
import { createApi, fakeBaseQuery } from '@reduxjs/toolkit/query/react';

export type GateStatus = 'pending' | 'confirmed' | 'blocked';
export interface RepositoryGate {
  id: string;
  repository: string;
  owner: string;
  dependency: string;
  status: GateStatus;
  version: string;
  /** 并发版本号：每次写入 +1，后写入者携带旧版本时被拒绝 */
  revision: number;
}

export type BatchState = 'delivered' | 'current' | 'queued';
export interface ReleaseBatch {
  id: string;
  index: number;
  gateIds: string[];
  state: BatchState;
  publishedAt?: string;
}

export interface GateConflict {
  id: string;
  at: string;
  gateId: string;
  repository: string;
  baseRevision: number;
  currentRevision: number;
}

export interface ReleaseTrain {
  id: string;
  name: string;
  freezeAt: string;
  status: 'preparing' | 'frozen' | 'rolled-back';
  gates: RepositoryGate[];
  /** 可重算分批计划：delivered 不再倒回，current 保留本批确认，queued 按依赖重算 */
  batches: ReleaseBatch[];
  /** 远端依赖查询失败时保留的上一次可发布批次 */
  lastGoodBatches: ReleaseBatch[];
  remoteHealth: 'unknown' | 'ok' | 'failed';
  conflicts: GateConflict[];
  blockers: Array<{ id: string; title: string; severity: 'warning' | 'critical'; resolved: boolean }>;
  audit: Array<{ id: string; at: string; text: string }>;
}

interface TrainState {
  activeId: string;
  trains: ReleaseTrain[];
}

/** 从依赖字符串取包名：'gateway@2.12' -> 'gateway' */
export function packageOf(dependency: string): string {
  return dependency.split('@')[0].trim();
}

/** a 是否依赖 b：a 的依赖包名与 b 的仓库名一致 */
export function dependsOn(a: RepositoryGate, b: RepositoryGate): boolean {
  return a.id !== b.id && packageOf(a.dependency) === b.repository.trim();
}

/**
 * 拓扑分层（Kahn 式波次）：
 * 同波仓库互不依赖；后一波依赖前一波。成环时把剩余仓库并入同一波，保证不冻结。
 */
export function scheduleWaves(gates: RepositoryGate[]): RepositoryGate[][] {
  const waves: RepositoryGate[][] = [];
  const placed = new Set<string>();
  let guard = 0;
  while (placed.size < gates.length && guard <= gates.length) {
    guard += 1;
    const wave = gates.filter((g) => {
      if (placed.has(g.id)) return false;
      return gates.every((d) => d.id === g.id || placed.has(d.id) || !dependsOn(g, d));
    });
    if (wave.length === 0) {
      const rest = gates.filter((g) => !placed.has(g.id));
      if (rest.length) waves.push(rest);
      rest.forEach((g) => placed.add(g.id));
      break;
    }
    waves.push(wave);
    wave.forEach((g) => placed.add(g.id));
  }
  return waves;
}

/**
 * 重算分批计划（直接修改 draft）：
 * - delivered 批次原样保留，不回退；
 * - 未交付仓库按依赖重排为波次，第一波为 current，其余 queued；
 * - 原 current 批中已确认的仓库若仍落在新 current 批，确认保留；
 *   若被依赖变化挤出 current 批（落入 queued），确认失效回到 pending。
 */
function recomputeTrainBatches(train: ReleaseTrain): void {
  const delivered = train.batches.filter((b) => b.state === 'delivered');
  const deliveredIds = new Set(delivered.flatMap((b) => b.gateIds));
  const oldCurrentIds = new Set(train.batches.find((b) => b.state === 'current')?.gateIds ?? []);
  const remaining = train.gates.filter((g) => !deliveredIds.has(g.id));
  const waves = scheduleWaves(remaining);

  const batches: ReleaseBatch[] = delivered.map((b, i) => ({
    ...b,
    index: i,
    gateIds: b.gateIds.filter((id) => train.gates.some((g) => g.id === id))
  }));
  waves.forEach((wave) => {
    batches.push({
      id: `batch-${nanoid(8)}`,
      index: batches.length,
      gateIds: wave.map((g) => g.id),
      state: batches.length === delivered.length ? 'current' : 'queued'
    });
  });

  const newCurrentIds = new Set(batches.find((b) => b.state === 'current')?.gateIds ?? []);
  for (const gate of train.gates) {
    if (deliveredIds.has(gate.id)) continue;
    const wasCurrent = oldCurrentIds.has(gate.id);
    const isCurrent = newCurrentIds.has(gate.id);
    if (wasCurrent && !isCurrent && gate.status === 'confirmed') gate.status = 'pending';
  }

  train.batches = batches;
  train.lastGoodBatches = batches.map((b) => ({ ...b, gateIds: [...b.gateIds] }));
}

function nowText(): string {
  return new Date().toLocaleTimeString();
}

const initialTrain: ReleaseTrain = {
  id: 'train-101',
  name: 'Sept 2026 发布列车',
  freezeAt: '2026-09-30 18:00',
  status: 'preparing',
  gates: [
    { id: 'g1', repository: 'web-console', owner: '陈珂', dependency: 'shared-ui@4.2', status: 'confirmed', version: '4.8.0', revision: 0 },
    { id: 'g2', repository: 'gateway', owner: '周扬', dependency: 'auth-sdk@2.1', status: 'pending', version: '2.12.0', revision: 0 },
    { id: 'g3', repository: 'data-sync', owner: '罗雨', dependency: 'gateway@2.12', status: 'blocked', version: '1.9.4', revision: 0 }
  ],
  batches: [],
  lastGoodBatches: [],
  remoteHealth: 'ok',
  conflicts: [],
  blockers: [
    { id: 'b1', title: 'data-sync 依赖的网关版本尚未确认', severity: 'critical', resolved: false },
    { id: 'b2', title: '移动端发布说明缺少回滚章节', severity: 'warning', resolved: false }
  ],
  audit: [{ id: 'a1', at: '09:20', text: '创建发布列车并关联 3 个仓库' }]
};
recomputeTrainBatches(initialTrain);

const initial: TrainState = {
  activeId: 'train-101',
  trains: [initialTrain]
};

const trainSlice = createSlice({
  name: 'train',
  initialState: initial,
  reducers: {
    createTrain(state, action: PayloadAction<{ name: string; freezeAt: string }>) {
      const train: ReleaseTrain = {
        id: `train-${Date.now()}`,
        name: action.payload.name,
        freezeAt: action.payload.freezeAt,
        status: 'preparing',
        gates: [],
        batches: [],
        lastGoodBatches: [],
        remoteHealth: 'ok',
        conflicts: [],
        blockers: [],
        audit: [{ id: `a-${Date.now()}`, at: nowText(), text: '创建发布列车' }]
      };
      recomputeTrainBatches(train);
      state.trains.push(train);
      state.activeId = train.id;
    },
    activateTrain(state, action: PayloadAction<string>) { state.activeId = action.payload; },
    confirmGate(state, action: PayloadAction<string>) {
      const train = state.trains.find((item) => item.id === state.activeId);
      const gate = train?.gates.find((item) => item.id === action.payload);
      if (!train || !gate) return;
      gate.status = 'confirmed';
      gate.revision += 1;
      train.audit.unshift({ id: `a-${Date.now()}`, at: nowText(), text: `${gate.repository} 门禁由发布负责人确认，重算分批计划` });
      if (train.remoteHealth !== 'failed') recomputeTrainBatches(train);
    },
    setFreeze(state, action: PayloadAction<ReleaseTrain['status']>) {
      const train = state.trains.find((item) => item.id === state.activeId);
      if (!train) return;
      train.status = action.payload;
      train.audit.unshift({ id: `a-${Date.now()}`, at: nowText(), text: `状态调整为 ${action.payload}` });
    },
    resolveBlocker(state, action: PayloadAction<string>) {
      const train = state.trains.find((item) => item.id === state.activeId);
      const blocker = train?.blockers.find((item) => item.id === action.payload);
      if (!train || !blocker) return;
      blocker.resolved = true;
      train.audit.unshift({ id: `a-${Date.now()}`, at: nowText(), text: `阻断项已关闭：${blocker.title}` });
    },
    /** 手动拖拽仅调整 current 批内顺序；依赖变化重算时以拓扑顺序为准 */
    reorderGates(state, action: PayloadAction<{ activeId: string; overId: string }>) {
      const train = state.trains.find((item) => item.id === state.activeId);
      const current = train?.batches.find((b) => b.state === 'current');
      if (!train || !current) return;
      const from = current.gateIds.indexOf(action.payload.activeId);
      const to = current.gateIds.indexOf(action.payload.overId);
      if (from < 0 || to < 0) return;
      const [moved] = current.gateIds.splice(from, 1);
      current.gateIds.splice(to, 0, moved);
      const gate = train.gates.find((g) => g.id === moved);
      train.audit.unshift({ id: `a-${Date.now()}`, at: nowText(), text: `手动调整本批顺序：${gate?.repository ?? moved}` });
    },
    /**
     * 并发写入：先写入（版本匹配）的排列生效；
     * 后写入者携带旧 revision，记录冲突并展示受影响仓库，不覆盖先写入的结果。
     */
    updateGate(state, action: PayloadAction<{
      id: string;
      baseRevision: number;
      changes: Partial<Pick<RepositoryGate, 'repository' | 'owner' | 'dependency' | 'version'>>;
    }>) {
      const train = state.trains.find((item) => item.id === state.activeId);
      const gate = train?.gates.find((item) => item.id === action.payload.id);
      if (!train || !gate) return;
      if (gate.revision !== action.payload.baseRevision) {
        train.conflicts.unshift({
          id: `c-${Date.now()}`,
          at: nowText(),
          gateId: gate.id,
          repository: gate.repository,
          baseRevision: action.payload.baseRevision,
          currentRevision: gate.revision
        });
        train.audit.unshift({ id: `a-${Date.now()}`, at: nowText(), text: `并发写入冲突：${gate.repository} 已被他人先修改（排列生效），后写入未生效` });
        return;
      }
      Object.assign(gate, action.payload.changes);
      gate.revision += 1;
      train.audit.unshift({ id: `a-${Date.now()}`, at: nowText(), text: `更新 ${gate.repository} 门禁信息（负责人/依赖变化），重算分批计划` });
      if (train.remoteHealth !== 'failed') recomputeTrainBatches(train);
    },
    clearConflicts(state) {
      const train = state.trains.find((item) => item.id === state.activeId);
      if (train) train.conflicts = [];
    },
    /**
     * 远端依赖查询恢复后重算：
     * - remoteOk=false：保留上一次可发布批次（lastGoodBatches），只标记失败，不重算；
     * - remoteOk=true：未交付仓库按依赖重算，已交付批次不回退，本批确认按新顺序保留。
     */
    recomputeBatches(state, action: PayloadAction<{ remoteOk: boolean }>) {
      const train = state.trains.find((item) => item.id === state.activeId);
      if (!train) return;
      if (!action.payload.remoteOk) {
        train.remoteHealth = 'failed';
        train.audit.unshift({ id: `a-${Date.now()}`, at: nowText(), text: '远端依赖查询失败：保留上一次可发布批次计划，仅重算未处理仓库' });
        return;
      }
      train.remoteHealth = 'ok';
      recomputeTrainBatches(train);
      train.audit.unshift({ id: `a-${Date.now()}`, at: nowText(), text: '远端依赖恢复：重算分批计划，已交付批次不回退，本批确认按新顺序保留' });
    },
    /** 交付当前批次：全部门禁确认且无未关闭严重阻断时才允许；交付后重算未处理仓库 */
    deliverBatch(state, action: PayloadAction<string>) {
      const train = state.trains.find((item) => item.id === state.activeId);
      const batch = train?.batches.find((b) => b.id === action.payload);
      if (!train || !batch || batch.state !== 'current') return;
      const gates = batch.gateIds.map((id) => train.gates.find((g) => g.id === id)).filter((g): g is RepositoryGate => Boolean(g));
      const unconfirmed = gates.some((g) => g.status !== 'confirmed');
      const criticalOpen = train.blockers.some((b) => !b.resolved && b.severity === 'critical');
      if (unconfirmed || criticalOpen) return;
      batch.state = 'delivered';
      batch.publishedAt = nowText();
      train.audit.unshift({ id: `a-${Date.now()}`, at: nowText(), text: `批次已交付：${gates.map((g) => g.repository).join('、')}` });
      if (train.remoteHealth !== 'failed') recomputeTrainBatches(train);
    },
    replaceState(_state, action: PayloadAction<TrainState>) { return action.payload; }
  }
});

export const releaseApi = createApi({
  reducerPath: 'releaseApi',
  baseQuery: fakeBaseQuery(),
  endpoints: (builder) => ({
    getTrainHealth: builder.query<{ ready: boolean; checkedAt: string }, string>({
      queryFn: (id) => {
        if (id === 'offline') return { error: { status: 'FETCH_ERROR', error: '远端依赖查询失败' } };
        return { data: { ready: true, checkedAt: new Date().toISOString() } };
      }
    })
  })
});

export const { useGetTrainHealthQuery } = releaseApi;
export const {
  activateTrain,
  clearConflicts,
  confirmGate,
  createTrain,
  deliverBatch,
  reorderGates,
  recomputeBatches,
  replaceState,
  resolveBlocker,
  setFreeze,
  updateGate
} = trainSlice.actions;

export const store = configureStore({
  reducer: { train: trainSlice.reducer, [releaseApi.reducerPath]: releaseApi.reducer },
  middleware: (getDefault) => getDefault().concat(releaseApi.middleware)
});

if (typeof window !== 'undefined') {
  const saved = localStorage.getItem('yf53-release-state');
  if (saved) store.dispatch(replaceState(JSON.parse(saved) as TrainState));
  store.subscribe(() => localStorage.setItem('yf53-release-state', JSON.stringify(store.getState().train)));
}

export type RootState = ReturnType<typeof store.getState>;
