import { useEffect, useState } from 'react';
import { api, type Health, type EventRow, type JobRow } from '../api';
import { Card, SectionTitle, Dot, Spinner, StatusBadge, Empty } from '../components';
import { toast } from '../store';

interface Settings {
  brand: string;
  schedule: { generate: string; publish: string; autoPublish: boolean };
}

export function Settings() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [events, setEvents] = useState<EventRow[]>([]);
  const [jobs, setJobs] = useState<JobRow[]>([]);
  const [brand, setBrand] = useState('');
  const [generate, setGenerate] = useState('');
  const [publish, setPublish] = useState('');
  const [checking, setChecking] = useState('');
  const [result, setResult] = useState<string>('');

  async function load() {
    try {
      const [s, h, e, j] = await Promise.all([
        api.get<Settings>('/api/settings'),
        api.get<Health>('/api/health'),
        api.get<EventRow[]>('/api/events'),
        api.get<JobRow[]>('/api/jobs'),
      ]);
      setSettings(s);
      setBrand(s.brand);
      setGenerate(s.schedule.generate);
      setPublish(s.schedule.publish);
      setHealth(h);
      setEvents(e);
      setJobs(j);
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'err');
    }
  }

  useEffect(() => {
    void load();
    const t = setInterval(load, 10000);
    return () => clearInterval(t);
  }, []);

  async function save() {
    try {
      await api.post('/api/settings', {
        brand,
        scheduleGenerate: generate,
        schedulePublish: publish,
      });
      toast('已保存');
      void load();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'err');
    }
  }

  async function check(what: 'cookie' | 'llm') {
    setChecking(what);
    setResult('');
    try {
      const res = await api.post<{
        cookie: { ok: boolean; detail: string };
        llm: { ok: boolean; detail: string };
      }>('/api/health/check');
      const r = what === 'cookie' ? res.cookie : res.llm;
      setResult(`${r.ok ? '✓' : '✗'} ${r.detail}`);
    } catch (err) {
      setResult(`✗ ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setChecking('');
    }
  }

  async function browserAction(action: 'launch' | 'close') {
    try {
      await api.post(`/api/browser/${action}`);
      toast(action === 'launch' ? '浏览器已启动' : '浏览器已关闭');
      void load();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'err');
    }
  }

  if (!settings) return <Spinner />;

  return (
    <div>
      <SectionTitle title="设置" />

      <div className="grid md:grid-cols-2 gap-5">
        <Card>
          <SectionTitle title="内容设置" />
          <label className="label">品牌署名</label>
          <input
            className="input mb-4"
            placeholder="出现在每张卡片页脚，留空则不显示"
            value={brand}
            onChange={(e) => setBrand(e.target.value)}
          />

          <label className="label">定时创作（crontab）</label>
          <input
            className="input mb-1 font-mono"
            placeholder="30 9 * * *"
            value={generate}
            onChange={(e) => setGenerate(e.target.value)}
          />
          <div className="text-[11px] text-ink-400 mb-4">
            默认每天 09:30 从选题池取一篇创作
          </div>

          <label className="label">定时发布（crontab）</label>
          <input
            className="input mb-1 font-mono"
            placeholder="0 */2 * * *"
            value={publish}
            onChange={(e) => setPublish(e.target.value)}
          />
          <div className="text-[11px] text-ink-400 mb-4">
            仅在「发布」页开启自动发布后生效
          </div>

          <button className="btn-primary" onClick={() => void save()}>
            保存
          </button>
        </Card>

        <Card>
          <SectionTitle title="运行状态" desc="点按钮做一次真实探活" />

          <div className="space-y-3 mb-4">
            <div className="flex items-center justify-between">
              <span className="text-sm flex items-center gap-2">
                <Dot ok={Boolean(health?.browser.hasSession)} />
                小红书会话
              </span>
              <button
                className="btn-ghost"
                disabled={checking === 'cookie'}
                onClick={() => void check('cookie')}
              >
                {checking === 'cookie' ? '检测中…' : '检测'}
              </button>
            </div>

            <div className="flex items-center justify-between">
              <span className="text-sm flex items-center gap-2">
                <Dot ok={Boolean(health?.llmConfigured)} />
                文本模型（{health?.llm.model}）
              </span>
              <button
                className="btn-ghost"
                disabled={checking === 'llm'}
                onClick={() => void check('llm')}
              >
                {checking === 'llm' ? '检测中…' : '检测'}
              </button>
            </div>

            <div className="flex items-center justify-between">
              <span className="text-sm flex items-center gap-2">
                <Dot ok={Boolean(health?.signer.ready)} />
                页面签名器
              </span>
              <span className="text-[11px] text-ink-400 truncate max-w-[180px]" title={health?.signer.diagnostic}>
                {health?.signer.ready ? '已就绪' : '待探测'}
              </span>
            </div>
          </div>

          {result && (
            <div className="text-xs bg-ink-50 p-2.5 rounded-lg mb-4 break-words">{result}</div>
          )}

          <div className="flex gap-2 pt-4 border-t border-ink-100">
            <button className="btn-ghost" onClick={() => void browserAction('launch')}>
              启动浏览器
            </button>
            <button className="btn-ghost" onClick={() => void browserAction('close')}>
              关闭浏览器
            </button>
          </div>

          {health?.llmMissing.length ? (
            <div className="mt-4 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg p-3">
              {health.llmMissing.map((m) => (
                <div key={m}>· {m}</div>
              ))}
            </div>
          ) : null}
        </Card>
      </div>

      {/* 任务队列 */}
      <Card className="mt-5">
        <SectionTitle
          title="任务队列"
          desc="所有耗时操作都在这里排队执行"
          action={
            <button
              className="btn-ghost"
              onClick={() => api.post('/api/scheduler/run').then(() => void load())}
            >
              立即执行到期任务
            </button>
          }
        />
        {jobs.length === 0 ? (
          <Empty>队列为空</Empty>
        ) : (
          <div className="max-h-96 overflow-y-auto">
            <table className="w-full">
              <thead className="bg-ink-50 sticky top-0">
                <tr>
                  <th className="th">类型</th>
                  <th className="th">状态</th>
                  <th className="th">尝试</th>
                  <th className="th">时间</th>
                  <th className="th">错误</th>
                </tr>
              </thead>
              <tbody>
                {jobs.slice(0, 40).map((j) => (
                  <tr key={j.id}>
                    <td className="td font-medium">{j.type}</td>
                    <td className="td">
                      <StatusBadge status={j.status} />
                    </td>
                    <td className="td tabular-nums">{j.attempts}</td>
                    <td className="td text-xs text-ink-500">{j.created_at}</td>
                    <td className="td text-xs text-rose-600 max-w-xs truncate" title={j.last_error ?? ''}>
                      {j.last_error ?? '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* 事件 */}
      <Card className="mt-5">
        <SectionTitle title="事件日志" desc="降级链命中、风控、会话异常" />
        {events.length === 0 ? (
          <Empty>暂无事件</Empty>
        ) : (
          <div className="space-y-1.5 max-h-96 overflow-y-auto">
            {events.map((e) => (
              <div key={e.id} className="flex gap-2 text-sm">
                <span
                  className={`mt-1.5 w-1.5 h-1.5 rounded-full shrink-0 ${
                    e.severity === 'error'
                      ? 'bg-rose-500'
                      : e.severity === 'warn'
                        ? 'bg-amber-500'
                        : 'bg-ink-300'
                  }`}
                />
                <div className="min-w-0">
                  <div className="text-ink-700 break-words">{e.message}</div>
                  <div className="text-[11px] text-ink-400">
                    {e.ts} · {e.kind}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}