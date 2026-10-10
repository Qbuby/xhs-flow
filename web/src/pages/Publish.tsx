import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type Draft } from '../api';
import { Card, SectionTitle, Spinner, Empty } from '../components';

interface Settings {
  brand: string;
  schedule: { generate: string; publish: string; autoPublish: boolean };
  nextRun?: { generate: string | null; publish: string | null };
}
import { toast } from '../store';
import { cronToParts, partsToCron, describeSchedule, describeNext } from '../util/schedule';

export function Publish() {
  const [queue, setQueue] = useState<Draft[]>([]);
  const [running, setRunning] = useState(false);
  const [auto, setAuto] = useState(false);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [parts, setParts] = useState(() => cronToParts('0 */2 * * *'));

  async function load() {
    try {
      const [d, s] = await Promise.all([
        api.get<Draft[]>('/api/drafts?status=approved'),
        api.get<{ schedule: { publish: string; autoPublish: boolean } }>('/api/settings'),
      ]);
      setQueue(d);
      setAuto(s.schedule.autoPublish);
      setParts(cronToParts(s.schedule.publish));
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'err');
    }
  }

  useEffect(() => {
    void load();
    const t = setInterval(load, 10000);
    return () => clearInterval(t);
  }, []);

  async function run() {
    if (queue.length === 0) return;
    if (!confirm(`立即发布 ${queue.length} 篇？发布动作会在创作中心真实执行。`)) return;
    setRunning(true);
    try {
      await api.post('/api/publish/run');
      toast('发布任务已启动，完成后刷新查看');
      setTimeout(() => void load(), 20000);
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'err');
    } finally {
      setRunning(false);
    }
  }

  async function toggleAuto() {
    const next = !auto;
    try {
      await api.post('/api/settings', { autoPublish: next, schedulePublish: partsToCron(parts) });
      setAuto(next);
      toast(next ? '已开启自动发布' : '已关闭自动发布');
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'err');
    }
  }

  return (
    <div>
      <SectionTitle
        title="发布"
        desc="通过审核的草稿会在这里排队，走创作中心网页发布"
        action={
          <button className="btn-primary" disabled={running || queue.length === 0} onClick={() => void run()}>
            {running ? '发布中…' : `立即发布（${queue.length}）`}
          </button>
        }
      />

      <Card className="mb-5 flex items-center justify-between">
        <div>
          <div className="text-sm font-medium">自动发布</div>
          <div className="text-xs text-ink-500 mt-0.5">
            {describeSchedule(parts)} 自动发布已通过的草稿
            （下次 {describeNext(settings?.nextRun?.publish ?? null)}）。
            关闭时需要你手动点发布。
          </div>
        </div>
        <button
          className={auto ? 'btn-primary' : 'btn-ghost'}
          onClick={() => void toggleAuto()}
        >
          {auto ? '已开启' : '已关闭'}
        </button>
      </Card>

      <Card className="mb-5">
        <div className="flex items-center gap-3 flex-wrap">
          <span className="text-sm text-ink-600">发布时间</span>
          <select
            className="input w-32"
            value={parts.freq}
            onChange={(e) => {
              const freq = e.target.value as 'daily' | 'weekly' | 'hourly';
              setParts({ ...parts, freq });
              api.post('/api/settings', { schedulePublish: partsToCron({ ...parts, freq }) });
            }}
          >
            <option value="daily">每天</option>
            <option value="weekly">每周</option>
            <option value="hourly">每隔几小时</option>
          </select>
          {parts.freq === 'hourly' ? (
            <div className="flex items-center gap-1.5">
              <span className="text-sm text-ink-500">每</span>
              <input
                type="number" min={1} max={23} className="input w-20"
                value={parts.everyNHours}
                onChange={(e) => {
                  const v = { ...parts, everyNHours: Number(e.target.value) };
                  setParts(v);
                  api.post('/api/settings', { schedulePublish: partsToCron(v) });
                }}
              />
              <span className="text-sm text-ink-500">小时</span>
            </div>
          ) : (
            <input
              type="time" className="input w-32"
              value={parts.time}
              onChange={(e) => {
                const v = { ...parts, time: e.target.value };
                setParts(v);
                api.post('/api/settings', { schedulePublish: partsToCron(v) });
              }}
            />
          )}
          <span className="text-xs text-ink-500">{describeSchedule(parts)}</span>
        </div>
      </Card>

      {queue.length === 0 ? (
        <Empty>
          发布队列为空。到 <Link to="/drafts" className="text-accent-500 hover:underline">草稿审核</Link> 通过几篇。
        </Empty>
      ) : (
        <div className="space-y-2">
          {queue.map((d) => (
            <Card key={d.id} className="py-3 flex items-center gap-3">
              <Link to={`/drafts/${d.id}`} className="flex-1 min-w-0">
                <div className="font-medium text-ink-900 truncate">{d.title}</div>
                <div className="text-[11px] text-ink-400 mt-0.5">
                  {d.nickname ?? '未知来源'} · {d.created_at}
                  {!d.rendered && ' · ⚠ 未渲染'}
                </div>
              </Link>
              {!d.rendered && (
                <span className="badge bg-amber-100 text-amber-700">缺图，无法发布</span>
              )}
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}