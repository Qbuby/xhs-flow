import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type Draft } from '../api';
import { Card, SectionTitle, Spinner, Empty } from '../components';
import { toast } from '../store';

export function Publish() {
  const [queue, setQueue] = useState<Draft[]>([]);
  const [running, setRunning] = useState(false);
  const [auto, setAuto] = useState(false);
  const [schedule, setSchedule] = useState('');

  async function load() {
    try {
      const [d, s] = await Promise.all([
        api.get<Draft[]>('/api/drafts?status=approved'),
        api.get<{ schedule: { publish: string; autoPublish: boolean } }>('/api/settings'),
      ]);
      setQueue(d);
      setAuto(s.schedule.autoPublish);
      setSchedule(s.schedule.publish);
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
      await api.post('/api/settings', { autoPublish: next });
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
            定时任务 <code className="bg-ink-100 px-1 rounded">{schedule || '0 */2 * * *'}</code> 自动发布已通过的草稿。
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