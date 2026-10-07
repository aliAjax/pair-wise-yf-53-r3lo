import { DndContext, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  Alert, Badge, Button, Card, Group, Modal, MultiSelect, Progress, Select,
  SimpleGrid, Stack, Text, TextInput, Title
} from '@mantine/core';
import { Controller, useForm } from 'react-hook-form';
import { useEffect, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { z } from 'zod';
import {
  activateTrain, addGate, clearConflict, confirmGate, createTrain, deliverBatch,
  reorderGates, remoteFailure, remoteRecovered, resolveBlocker, saveGateChange,
  setFreeze, setRemoteSimulation, useGetTrainHealthQuery,
  type Batch, type RepositoryGate, type RootState
} from '../store';
import { activeBatch, checkBatchReleasable } from '../lib/schedule';

const EDITORS = ['陈珂', '周扬', '罗雨'];

const createSchema = z.object({
  name: z.string().min(3, '发布列车名称至少3个字符'),
  freezeAt: z.string().min(5, '请填写冻结时间')
});

const gateSchema = z.object({
  owner: z.string().min(1, '请填写负责人'),
  version: z.string().min(1, '请填写版本'),
  dependsOn: z.array(z.string())
});
type GateForm = z.infer<typeof gateSchema>;

function GateRow({
  gate, sortable, locked, waiting, onConfirm, onEdit
}: {
  gate: RepositoryGate;
  sortable: boolean;
  locked: boolean;
  waiting?: boolean;
  onConfirm: () => void;
  onEdit: () => void;
}) {
  const sortableProps = useSortable({ id: gate.id, disabled: !sortable });
  const { attributes, listeners, setNodeRef, transform, transition } = sortableProps;
  const deps = gate.dependsOn.length > 0 ? gate.dependsOn.join('、') : gate.externalDependency ?? '无';
  const card = (
    <Card withBorder p="sm" style={{
      transform: CSS.Transform.toString(transform),
      transition,
      opacity: locked ? 0.72 : 1,
      background: locked ? '#f8fafc' : undefined
    }}>
      <Group justify="space-between" align="flex-start" wrap="nowrap">
        <div>
          <Group gap="xs">
            <Text fw={700}>{gate.repository}</Text>
            <Badge variant="outline" color="gray" size="xs">r{gate.rev}</Badge>
            {locked && <Badge color="gray" size="xs">已锁定</Badge>}
          </Group>
          <Text size="sm" c="dimmed">负责人 {gate.owner} · 依赖 {deps} · 版本 {gate.version}</Text>
        </div>
        <Group gap="xs" wrap="nowrap">
          <Badge color={gate.status === 'confirmed' ? 'green' : gate.status === 'blocked' ? 'red' : 'yellow'}>
            {gate.status === 'confirmed' ? '已确认' : gate.status === 'blocked' ? '阻断中' : '待确认'}
          </Badge>
          <Button size="xs" variant="light" onClick={onConfirm} disabled={locked || waiting || gate.status === 'confirmed'}>确认门禁</Button>
          <Button size="xs" variant="subtle" onClick={onEdit} disabled={locked}>编辑</Button>
          {sortable && <Button size="xs" variant="subtle" color="gray" {...attributes} {...listeners}>⠿</Button>}
        </Group>
      </Group>
    </Card>
  );
  return sortable ? <div ref={setNodeRef}>{card}</div> : card;
}

export default function Home() {
  const dispatch = useDispatch();
  const state = useSelector((root: RootState) => root.train);
  const train = state.trains.find((item) => item.id === state.activeId) ?? state.trains[0];
  const { data: health, error: healthError, isFetching, refetch } = useGetTrainHealthQuery(train?.id ?? 'offline', {
    pollingInterval: 20_000
  });

  // 远端状态机：失败 -> 冻结上一次可发布批次；恢复 -> 只重算未处理仓库（reducer 内部幂等）
  useEffect(() => {
    if (healthError) dispatch(remoteFailure());
  }, [healthError, dispatch]);
  useEffect(() => {
    if (health) dispatch(remoteRecovered({ checkedAt: health.checkedAt }));
  }, [health, dispatch]);

  const [editor, setEditor] = useState<string>(EDITORS[0]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingRev, setEditingRev] = useState<number>(0);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  const createForm = useForm<z.infer<typeof createSchema>>({
    resolver: zodResolver(createSchema),
    defaultValues: { name: '', freezeAt: '2026-10-02 18:00' }
  });
  const gateForm = useForm<GateForm>({ resolver: zodResolver(gateSchema), defaultValues: { owner: '', version: '', dependsOn: [] } });
  const addForm = useForm<{ repository: string; owner: string; version: string }>({
    defaultValues: { repository: '', owner: editor, version: '' }
  });

  if (!train) return null;

  const editingGate = train.gates.find((g) => g.id === editingId) ?? null;
  const current = activeBatch(train);
  const unresolved = train.blockers.filter((item) => !item.resolved).length;
  const confirmed = train.gates.filter((item) => item.status === 'confirmed').length;
  const deliveredCount = train.batches.filter((b) => b.state === 'delivered').length;
  const gateById = new Map(train.gates.map((g) => [g.id, g]));
  const conflictEditing = train.conflict && train.conflict.gateId === editingId ? train.conflict : null;
  const otherConflict = train.conflict && train.conflict.gateId !== editingId ? train.conflict : null;

  function openEditor(gate: RepositoryGate) {
    setEditingId(gate.id);
    setEditingRev(gate.rev); // 记录本次编辑基于的版本，写入时做乐观锁校验
    gateForm.reset({ owner: gate.owner, version: gate.version, dependsOn: gate.dependsOn });
  }

  function onDragEnd(event: DragEndEvent) {
    if (event.over && event.active.id !== event.over.id) {
      dispatch(reorderGates({ activeId: String(event.active.id), overId: String(event.over.id) }));
    }
  }

  function onSaveGate(values: GateForm) {
    if (!editingId) return;
    dispatch(saveGateChange({
      gateId: editingId,
      expectedRev: editingRev,
      editor,
      patch: { owner: values.owner, version: values.version, dependsOn: values.dependsOn }
    }));
  }

  function refreshEditorVersion() {
    if (!editingGate) return;
    setEditingRev(editingGate.rev);
    gateForm.reset({ owner: editingGate.owner, version: editingGate.version, dependsOn: editingGate.dependsOn });
    dispatch(clearConflict());
  }

  function onDeliver() {
    if (!current) return;
    const check = checkBatchReleasable(train, current, train.remoteReady);
    dispatch(deliverBatch(check.ok ? { } : { reasons: check.reasons }));
  }

  return (
    <main className="shell">
      <header className="hero">
        <div>
          <Text className="eyebrow">RELEASE TRAIN / PORT 62018</Text>
          <Title order={1}>开源项目发布列车准备台</Title>
          <Text>依赖图与负责人确认驱动自动分批；已交付批次锁定不倒回，变更只重算未处理仓库。</Text>
        </div>
        <Badge size="xl" color={train.status === 'frozen' ? 'blue' : train.status === 'rolled-back' ? 'red' : 'yellow'}>{train.status}</Badge>
      </header>

      {!train.remoteReady && (
        <Alert color="orange" title="远端依赖查询失败" mb="md">
          已保留上一次可发布批次（<b>{deliveredCount}</b> 批已交付，本批顺序冻结）。期间的依赖/负责人变更{train.scheduleDirty ? '已记录，将在恢复后并入' : '暂无'}，恢复后只重算未处理仓库。
        </Alert>
      )}
      {otherConflict && (
        <Alert color="red" title={`并发写入冲突：${otherConflict.repository}`} mb="md" onClose={() => dispatch(clearConflict())}>
          <Text size="sm">
            <b>{otherConflict.winner}</b> 的排列已先生效（r{otherConflict.currentRev}），<b>{otherConflict.loser}</b> 基于 r{otherConflict.staleRev} 的写入被拒（{otherConflict.at}）。
          </Text>
          <Text size="sm" mt={4}>
            受影响仓库：{otherConflict.affected.length > 0 ? otherConflict.affected.join('、') : '无未交付下游'}
          </Text>
        </Alert>
      )}

      <SimpleGrid cols={{ base: 1, md: 4 }} mb="xl">
        <Card withBorder><Text size="xs">冻结时间</Text><Title order={3}>{train.freezeAt}</Title></Card>
        <Card withBorder>
          <Text size="xs">门禁通过</Text>
          <Title order={3}>{confirmed}/{train.gates.length}</Title>
          <Progress mt="sm" value={confirmed / Math.max(train.gates.length, 1) * 100} />
        </Card>
        <Card withBorder><Text size="xs">已交付批次</Text><Title order={3} c={deliveredCount ? 'green' : undefined}>{deliveredCount}/{train.batches.length}</Title></Card>
        <Card withBorder>
          <Text size="xs">远端依赖服务 · {isFetching ? '查询中' : train.remoteReady ? '可达' : '故障'}</Text>
          <Title order={3} c={train.remoteReady ? 'green' : 'red'}>{train.remoteReady ? '可达' : '降级中'}</Title>
          <Group gap="xs" mt="xs">
            <Button size="compact-xs" variant="default" onClick={() => { setRemoteSimulation(false); void refetch(); }}>模拟故障</Button>
            <Button size="compact-xs" variant="default" onClick={() => { setRemoteSimulation(true); void refetch(); }}>恢复查询</Button>
          </Group>
        </Card>
      </SimpleGrid>

      <div className="layout">
        <Stack>
          <Card withBorder>
            <Group justify="space-between" mb="md">
              <Title order={3}>分批发布计划</Title>
              <Group gap="xs">
                <Text size="sm" c="dimmed">当前操作身份</Text>
                <Select size="xs" w={110} data={EDITORS} value={editor} onChange={(v) => v && setEditor(v)} allowDeselect={false} />
              </Group>
            </Group>
            {train.lastRecompute && (
              <Text size="xs" c="dimmed" mb="sm">
                最近重算 {train.lastRecompute.at} · 原因：{train.lastRecompute.reason}
                {train.lastRecompute.cycles.length > 0 && <> · ⚠ 依赖环：{train.lastRecompute.cycles.flat().join('、')}</>}
              </Text>
            )}
            <Stack gap="md">
              {train.batches.map((batch: Batch, idx: number) => {
                const isActive = batch.state === 'planned' && idx === train.batches.findIndex((b) => b.state === 'planned');
                const depsText = train.gates
                  .filter((g) => batch.gateIds.includes(g.id))
                  .flatMap((g) => g.dependsOn)
                  .filter((dep) => {
                    const depGate = train.gates.find((x) => x.repository === dep);
                    return depGate && !batch.gateIds.includes(depGate.id);
                  });
                return (
                  <Card key={batch.id} withBorder={isActive} style={{ borderColor: isActive ? undefined : '#e5e7eb' }} p="md">
                    <Group justify="space-between" mb="sm">
                      <Group gap="xs">
                        <Title order={4}>批次 {batch.index + 1}</Title>
                        {batch.state === 'delivered'
                          ? <Badge color="green">已交付 {batch.deliveredAt}</Badge>
                          : isActive
                            ? <Badge color="blue">当前批次</Badge>
                            : <Badge color="gray" variant="light">等待前序批次</Badge>}
                      </Group>
                      {depsText.length > 0 && <Text size="xs" c="dimmed">前置：{Array.from(new Set(depsText)).join('、')}</Text>}
                    </Group>
                    {isActive ? (
                      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
                        <SortableContext items={batch.gateIds} strategy={verticalListSortingStrategy}>
                          <Stack gap="xs">
                            {batch.gateIds.map((id) => {
                              const gate = gateById.get(id);
                              if (!gate) return null;
                              return <GateRow key={id} gate={gate} sortable locked={false}
                                onConfirm={() => dispatch(confirmGate({ gateId: id, editor }))}
                                onEdit={() => openEditor(gate)} />;
                            })}
                          </Stack>
                        </SortableContext>
                      </DndContext>
                    ) : (
                      <Stack gap="xs">
                        {batch.gateIds.map((id) => {
                          const gate = gateById.get(id);
                          if (!gate) return null;
                          return <GateRow key={id} gate={gate} sortable={false} locked={batch.state === 'delivered'} waiting={batch.state === 'planned'}
                            onConfirm={() => dispatch(confirmGate({ gateId: id, editor }))}
                            onEdit={() => openEditor(gate)} />;
                        })}
                      </Stack>
                    )}
                    {isActive && (
                      <Group justify="space-between" mt="md">
                        <Text size="xs" c="dimmed">
                          拖动只在本批内生效；修改依赖或确认后自动重算，已交付批次不受影响。
                        </Text>
                        <Button onClick={onDeliver} disabled={!train.remoteReady}>
                          {train.remoteReady ? '确认放行本批并锁定' : '远端故障中，暂不能放行'}
                        </Button>
                      </Group>
                    )}
                  </Card>
                );
              })}
            </Stack>
          </Card>

          <Card withBorder>
            <Title order={3} mb="md">阻断问题</Title>
            {train.blockers.map((item) => (
              <Group key={item.id} justify="space-between" className="row">
                <div>
                  <Badge color={item.severity === 'critical' ? 'red' : 'yellow'}>{item.severity}</Badge>
                  <Text component="span" ml="sm" td={item.resolved ? 'line-through' : undefined}>{item.title}</Text>
                </div>
                <Button variant="subtle" disabled={item.resolved} onClick={() => dispatch(resolveBlocker(item.id))}>关闭</Button>
              </Group>
            ))}
          </Card>
        </Stack>

        <Stack>
          <Card withBorder>
            <Title order={3} mb="md">新增仓库</Title>
            <form onSubmit={addForm.handleSubmit((values) => {
              dispatch(addGate({ ...values, dependsOn: [] }));
              addForm.reset({ repository: '', owner: editor, version: '' });
            })}>
              <Stack gap="xs">
                <TextInput size="xs" label="仓库名" {...addForm.register('repository')} required />
                <TextInput size="xs" label="负责人" {...addForm.register('owner')} required />
                <TextInput size="xs" label="版本" {...addForm.register('version')} required />
                <Button size="xs" type="submit">加入并按依赖重算</Button>
              </Stack>
            </form>
          </Card>

          <Card withBorder>
            <Title order={3} mb="md">发布控制</Title>
            <Text size="sm" c="dimmed" mb="md">门禁未全部确认时仍可模拟冻结，审计会记录强制决定。</Text>
            <Group>
              <Button onClick={() => dispatch(setFreeze('frozen'))}>冻结列车</Button>
              <Button color="red" variant="light" onClick={() => dispatch(setFreeze('rolled-back'))}>标记回滚</Button>
              <Button variant="default" onClick={() => dispatch(setFreeze('preparing'))}>回到准备</Button>
            </Group>
          </Card>

          <Card withBorder>
            <Title order={3} mb="md">新建发布列车</Title>
            <form onSubmit={createForm.handleSubmit((values) => { dispatch(createTrain(values)); createForm.reset(); })}>
              <Stack>
                <TextInput label="列车名称" {...createForm.register('name')} error={createForm.formState.errors.name?.message} />
                <TextInput label="冻结时间" {...createForm.register('freezeAt')} error={createForm.formState.errors.freezeAt?.message} />
                <Button type="submit">创建并切换</Button>
              </Stack>
            </form>
          </Card>

          <Card withBorder>
            <Title order={3} mb="md">审计历史</Title>
            <Stack gap="xs">{train.audit.slice(0, 10).map((item) => <Text key={item.id} size="sm"><b>{item.at}</b> · {item.text}</Text>)}</Stack>
          </Card>

          <Card withBorder>
            <Title order={3} mb="md">其他列车</Title>
            {state.trains.map((item) => (
              <Button key={item.id} fullWidth variant={item.id === train.id ? 'filled' : 'subtle'} mb="xs" onClick={() => dispatch(activateTrain(item.id))}>{item.name}</Button>
            ))}
          </Card>
        </Stack>
      </div>

      <Modal opened={Boolean(editingGate)} onClose={() => { setEditingId(null); dispatch(clearConflict()); }} title={editingGate ? `编辑仓库 ${editingGate.repository}` : ''}>
        {editingGate && (
          <form onSubmit={gateForm.handleSubmit(onSaveGate)}>
            <Stack>
              <Group justify="space-between">
                <Text size="xs" c="dimmed">编辑身份：{editor}</Text>
                <Text size="xs" c="dimmed">
                  编辑基于 r{editingRev}{editingGate.rev !== editingRev && <> · 服务端当前 r{editingGate.rev}</>}
                </Text>
              </Group>
              {conflictEditing && (
                <Alert color="red" title="你的写入被拒：已有更新的排列先生效">
                  <Text size="sm"><b>{conflictEditing.winner}</b> 先写入（r{conflictEditing.currentRev}），你（{conflictEditing.loser}）的 r{conflictEditing.staleRev} 已过期。</Text>
                  <Text size="sm" mt={4}>受影响仓库：{conflictEditing.affected.length > 0 ? conflictEditing.affected.join('、') : '无未交付下游'}</Text>
                  <Group mt="sm">
                    <Button size="xs" variant="light" onClick={refreshEditorVersion}>拉取最新排列后再改</Button>
                    <Button size="xs" variant="subtle" color="gray" onClick={() => dispatch(clearConflict())}>知道了</Button>
                  </Group>
                </Alert>
              )}
              <TextInput label="负责人" {...gateForm.register('owner')} error={gateForm.formState.errors.owner?.message} />
              <TextInput label="版本" {...gateForm.register('version')} error={gateForm.formState.errors.version?.message} />
              <Controller
                control={gateForm.control}
                name="dependsOn"
                render={({ field }) => (
                  <MultiSelect
                    label="依赖仓库（决定分批层级）"
                    data={train.gates.filter((g) => g.id !== editingGate.id).map((g) => ({ value: g.repository, label: `${g.repository} ${g.version}` }))}
                    value={field.value}
                    onChange={field.onChange}
                    searchable
                    clearable
                  />
                )}
              />
              <Group justify="space-between">
                <Text size="xs" c="dimmed">保存后立即重算未交付批次，已交付批次不倒回。</Text>
                <Button type="submit" disabled={Boolean(conflictEditing)}>保存并触发重算</Button>
              </Group>
            </Stack>
          </form>
        )}
      </Modal>
    </main>
  );
}
