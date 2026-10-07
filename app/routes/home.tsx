import { DndContext, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { zodResolver } from '@hookform/resolvers/zod';
import { Alert, Badge, Button, Card, Group, Modal, Progress, SimpleGrid, Stack, Text, TextInput, Title } from '@mantine/core';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { useDispatch, useSelector } from 'react-redux';
import { z } from 'zod';
import {
  activateTrain,
  clearConflicts,
  confirmGate,
  createTrain,
  deliverBatch,
  reorderGates,
  recomputeBatches,
  resolveBlocker,
  setFreeze,
  updateGate,
  useGetTrainHealthQuery,
  type ReleaseBatch,
  type RepositoryGate
} from '../store';

const schema = z.object({
  name: z.string().min(3, '发布列车名称至少3个字符'),
  freezeAt: z.string().min(5, '请填写冻结时间')
});

const editSchema = z.object({
  repository: z.string().min(1, '请填写仓库名'),
  owner: z.string().min(1, '请填写负责人'),
  dependency: z.string().min(1, '请填写依赖，如 gateway@2.12'),
  version: z.string().min(1, '请填写版本')
});

function SortableGate({ gate, conflicted, onConfirm, onEdit }: {
  gate: RepositoryGate;
  conflicted: boolean;
  onConfirm: () => void;
  onEdit: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id: gate.id });
  return (
    <Card
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        borderColor: conflicted ? 'var(--mantine-color-red-6)' : undefined,
        borderWidth: conflicted ? 2 : undefined
      }}
      withBorder
    >
      <Group justify="space-between" align="flex-start">
        <div>
          <Group gap="xs">
            <Text fw={700}>{gate.repository}</Text>
            {conflicted && <Badge color="red" variant="filled">已被他人修改</Badge>}
          </Group>
          <Text size="sm" c="dimmed">负责人 {gate.owner} · 依赖 {gate.dependency} · 版本 {gate.version} · rev {gate.revision}</Text>
        </div>
        <Group>
          <Badge color={gate.status === 'confirmed' ? 'green' : gate.status === 'blocked' ? 'red' : 'yellow'}>{gate.status}</Badge>
          <Button size="xs" variant="light" onClick={onConfirm} disabled={gate.status === 'confirmed'}>确认门禁</Button>
          <Button size="xs" variant="subtle" onClick={onEdit}>编辑</Button>
          <Button size="xs" variant="subtle" {...attributes} {...listeners}>拖拽排序</Button>
        </Group>
      </Group>
    </Card>
  );
}

function StaticGate({ gate, state }: { gate: RepositoryGate; state: BatchState }) {
  return (
    <Card withBorder opacity={state === 'queued' ? 0.75 : 1}>
      <Group justify="space-between" align="flex-start">
        <div>
          <Text fw={700} td={state === 'delivered' ? 'line-through' : undefined}>{gate.repository}</Text>
          <Text size="sm" c="dimmed">负责人 {gate.owner} · 依赖 {gate.dependency} · 版本 {gate.version} · rev {gate.revision}</Text>
        </div>
        <Badge color={state === 'delivered' ? 'green' : 'gray'}>{state === 'delivered' ? '已交付' : '待发布'}</Badge>
      </Group>
    </Card>
  );
}

type BatchState = ReleaseBatch['state'];

export default function Home() {
  const dispatch = useDispatch();
  const state = useSelector((root: { train: ReturnType<typeof import('../store').store.getState>['train'] }) => root.train);
  const train = state.trains.find((item) => item.id === state.activeId) ?? state.trains[0];
  const [offline, setOffline] = useState(false);
  const { data: health, isError } = useGetTrainHealthQuery(offline ? 'offline' : (train?.id ?? 'offline'));
  const sensors = useSensors(useSensor(PointerSensor));
  const form = useForm<z.infer<typeof schema>>({ resolver: zodResolver(schema), defaultValues: { name: '', freezeAt: '2026-10-02 18:00' } });
  const editForm = useForm<z.infer<typeof editSchema>>({ resolver: zodResolver(editSchema) });
  const [editing, setEditing] = useState<RepositoryGate | null>(null);

  useEffect(() => {
    if (!train) return;
    if (isError) dispatch(recomputeBatches({ remoteOk: false }));
    else if (health?.ready) dispatch(recomputeBatches({ remoteOk: true }));
  }, [isError, health?.ready, train?.id, dispatch]);

  if (!train) return null;

  const unresolved = train.blockers.filter((item) => !item.resolved).length;
  const confirmed = train.gates.filter((item) => item.status === 'confirmed').length;
  const currentBatch = train.batches.find((b) => b.state === 'current');
  const plan = train.remoteHealth === 'failed' && train.lastGoodBatches.length ? train.lastGoodBatches : train.batches;
  const conflict = train.conflicts[0];

  function gateInBatch(batch: ReleaseBatch) {
    return batch.gateIds
      .map((id) => train.gates.find((g) => g.id === id))
      .filter((g): g is RepositoryGate => Boolean(g));
  }

  function onDragEnd(event: DragEndEvent) {
    if (event.over && event.active.id !== event.over.id) {
      dispatch(reorderGates({ activeId: String(event.active.id), overId: String(event.over.id) }));
    }
  }

  function openEdit(gate: RepositoryGate) {
    setEditing(gate);
    editForm.reset({ repository: gate.repository, owner: gate.owner, dependency: gate.dependency, version: gate.version });
  }

  function submitEdit(values: z.infer<typeof editSchema>) {
    if (!editing) return;
    dispatch(updateGate({ id: editing.id, baseRevision: editing.revision, changes: values }));
    setEditing(null);
  }

  const currentGates = currentBatch ? gateInBatch(currentBatch) : [];
  const currentUnconfirmed = currentGates.filter((g) => g.status !== 'confirmed').length;
  const criticalOpen = train.blockers.some((b) => !b.resolved && b.severity === 'critical');
  const canDeliver = currentBatch && currentUnconfirmed === 0 && !criticalOpen;

  return (
    <main className="shell">
      <header className="hero">
        <div><Text className="eyebrow">RELEASE TRAIN / PORT 62018</Text><Title order={1}>开源项目发布列车准备台</Title><Text>发布列车、仓库门禁与分批计划接成可重算排程：依赖或确认变化即重算，已交付批次不回退。</Text></div>
        <Badge size="xl" color={train.status === 'frozen' ? 'blue' : train.status === 'rolled-back' ? 'red' : 'yellow'}>{train.status}</Badge>
      </header>

      <SimpleGrid cols={{ base: 1, md: 4 }} mb="xl">
        <Card withBorder><Text size="xs">冻结时间</Text><Title order={3}>{train.freezeAt}</Title></Card>
        <Card withBorder><Text size="xs">门禁通过</Text><Title order={3}>{confirmed}/{train.gates.length}</Title><Progress mt="sm" value={confirmed / Math.max(train.gates.length, 1) * 100} /></Card>
        <Card withBorder><Text size="xs">未关闭阻断项</Text><Title order={3} c={unresolved ? 'red' : 'green'}>{unresolved}</Title></Card>
        <Card withBorder>
          <Text size="xs">远端依赖检查</Text>
          <Group gap="xs"><Title order={3} c={isError || train.remoteHealth === 'failed' ? 'red' : 'green'}>{isError || train.remoteHealth === 'failed' ? '失败' : '可达'}</Title></Group>
        </Card>
      </SimpleGrid>

      <Stack gap="md" mb="md">
        {(isError || train.remoteHealth === 'failed') && (
          <Alert color="red" title="远端依赖查询失败">
            已保留上一次可发布批次计划（{train.lastGoodBatches.length} 批），仅重算未处理仓库；远端恢复后自动重算。
          </Alert>
        )}
        {conflict && (
          <Alert color="orange" title="并发写入冲突" onClose={() => dispatch(clearConflicts())} withCloseButton>
            仓库 <b>{conflict.repository}</b> 已被他人先修改（rev {conflict.baseRevision} → {conflict.currentRevision}），先写入的排列生效，你的后写入未生效。请查看该仓库最新状态后重试。
          </Alert>
        )}
      </Stack>

      <div className="layout">
        <Stack>
          <Card withBorder>
            <Group justify="space-between" mb="md">
              <Title order={3}>分批发布计划</Title>
              <Group>
                <Button size="xs" variant="light" onClick={() => dispatch(recomputeBatches({ remoteOk: !offline }))}>重算排程</Button>
                <Button size="xs" variant={offline ? 'filled' : 'default'} color={offline ? 'red' : undefined} onClick={() => setOffline((v) => !v)}>
                  {offline ? '恢复远端查询' : '模拟远端故障'}
                </Button>
              </Group>
            </Group>
            <Stack gap="lg">
              {plan.map((batch) => {
                const gates = gateInBatch(batch);
                if (batch.state === 'delivered') {
                  return (
                    <div key={batch.id}>
                      <Group mb="xs"><Badge color="green">已交付</Badge><Text size="sm" c="dimmed">{batch.publishedAt} 交付 · {gates.length} 个仓库</Text></Group>
                      <Stack gap="xs">{gates.map((g) => <StaticGate key={g.id} gate={g} state="delivered" /> )}</Stack>
                    </div>
                  );
                }
                if (batch.state === 'current') {
                  return (
                    <div key={batch.id}>
                      <Group mb="xs">
                        <Badge color="blue">本批 · 进行中</Badge>
                        <Text size="sm" c="dimmed">{gates.length} 个仓库 · {currentUnconfirmed} 个未确认</Text>
                        <Button size="xs" color="green" ml="auto" disabled={!canDeliver} onClick={() => dispatch(deliverBatch(batch.id))}>交付本批</Button>
                      </Group>
                      {!canDeliver && <Text size="xs" c="dimmed" mb="xs">本批全部门禁确认且无未关闭严重阻断项时才可交付。</Text>}
                      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
                        <SortableContext items={gates.map((g) => g.id)} strategy={verticalListSortingStrategy}>
                          <Stack gap="xs">
                            {gates.map((gate) => (
                              <SortableGate
                                key={gate.id}
                                gate={gate}
                                conflicted={train.conflicts.some((c) => c.gateId === gate.id)}
                                onConfirm={() => dispatch(confirmGate(gate.id))}
                                onEdit={() => openEdit(gate)}
                              />
                            ))}
                          </Stack>
                        </SortableContext>
                      </DndContext>
                    </div>
                  );
                }
                return (
                  <div key={batch.id}>
                    <Group mb="xs"><Badge color="gray">待发布</Badge><Text size="sm" c="dimmed">{gates.length} 个仓库 · 依赖重算后可能并入本批</Text></Group>
                    <Stack gap="xs">{gates.map((g) => <StaticGate key={g.id} gate={g} state="queued" />)}</Stack>
                  </div>
                );
              })}
              {plan.length === 0 && <Text size="sm" c="dimmed">暂无分批计划。</Text>}
            </Stack>
          </Card>

          <Card withBorder>
            <Title order={3} mb="md">阻断问题</Title>
            {train.blockers.map((item) => (
              <Group key={item.id} justify="space-between" className="row">
                <div><Badge color={item.severity === 'critical' ? 'red' : 'yellow'}>{item.severity}</Badge><Text component="span" ml="sm" td={item.resolved ? 'line-through' : undefined}>{item.title}</Text></div>
                <Button variant="subtle" disabled={item.resolved} onClick={() => dispatch(resolveBlocker(item.id))}>关闭</Button>
              </Group>
            ))}
          </Card>
        </Stack>

        <Stack>
          <Card withBorder>
            <Title order={3}>发布控制</Title>
            <Text size="sm" c="dimmed" mb="md">门禁未全部确认时仍可模拟冻结，审计会记录强制决定。</Text>
            <Group><Button onClick={() => dispatch(setFreeze('frozen'))}>冻结列车</Button><Button color="red" variant="light" onClick={() => dispatch(setFreeze('rolled-back'))}>标记回滚</Button><Button variant="default" onClick={() => dispatch(setFreeze('preparing'))}>回到准备</Button></Group>
          </Card>

          <Card withBorder>
            <Title order={3} mb="md">新建发布列车</Title>
            <form onSubmit={form.handleSubmit((values) => { dispatch(createTrain(values)); form.reset(); })}>
              <Stack>
                <TextInput label="列车名称" {...form.register('name')} error={form.formState.errors.name?.message} />
                <TextInput label="冻结时间" {...form.register('freezeAt')} error={form.formState.errors.freezeAt?.message} />
                <Button type="submit">创建并切换</Button>
              </Stack>
            </form>
          </Card>

          <Card withBorder>
            <Title order={3} mb="md">审计历史</Title>
            <Stack gap="xs">{train.audit.slice(0, 8).map((item) => <Text key={item.id} size="sm"><b>{item.at}</b> · {item.text}</Text>)}</Stack>
          </Card>

          <Card withBorder>
            <Title order={3} mb="md">其他列车</Title>
            {state.trains.map((item) => <Button key={item.id} fullWidth variant={item.id === train.id ? 'filled' : 'subtle'} mb="xs" onClick={() => dispatch(activateTrain(item.id))}>{item.name}</Button>)}
          </Card>
        </Stack>
      </div>

      <Modal opened={Boolean(editing)} onClose={() => setEditing(null)} title="编辑仓库门禁" centered>
        <form onSubmit={editForm.handleSubmit(submitEdit)}>
          <Stack>
            <TextInput label="仓库名" {...editForm.register('repository')} error={editForm.formState.errors.repository?.message} />
            <TextInput label="负责人" {...editForm.register('owner')} error={editForm.formState.errors.owner?.message} />
            <TextInput label="依赖（如 gateway@2.12）" {...editForm.register('dependency')} error={editForm.formState.errors.dependency?.message} />
            <TextInput label="版本" {...editForm.register('version')} error={editForm.formState.errors.version?.message} />
            <Text size="xs" c="dimmed">当前 rev {editing?.revision}：先写入的排列生效，后写入若版本不符将被拒绝。</Text>
            <Group justify="flex-end"><Button variant="default" onClick={() => setEditing(null)}>取消</Button><Button type="submit">保存（重算排程）</Button></Group>
          </Stack>
        </form>
      </Modal>
    </main>
  );
}
