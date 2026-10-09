import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { Card, SectionTitle, StatusBadge, Spinner, Empty, Dot } from '../components';
import { toast } from '../store';

interface Source {
  id: number;
  nickname: string | null;
  note_count: number;
}

interface Topic {
  id: number;
  source_id: number;
  title: string;
  angle: string;
  brief: string;
  status: string;
  origin: string;
  nickname: string | null;
}

interface Studio {
  sources: Source[];
  topics: Topic[];
  counts: { source_id: number; open: number; used: number }[];
}

interface Settings {
  brand: string;
  schedule: {
    generate: string;
    publish: string;
    autoPublish: boolean;
    autoCompose?: boolean;
    autoIdeate?: boolean;
    composePerRun?: number;
    ideatePerRun?: number;
  };
  nextRun?: { generate: string | null; publish: string | null };
}

function fmtNext(iso: string | null): string {
  if (!iso) return '未排期';
  const d = new Date(iso);
  const now = new Date();
  const diff = d.getTime() - now.getTime();
  if (diff < 0) return '即将执行';
  const h = Math.floor(diff / 3_600_000);
  const m = Math.round((diff % 3_600_000) / 60_000);
  const rel = h > 0 ? `${h} 小时 ${m} 分后` : `${m} 分钟后`;
  return `${d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}（${rel}）`;
}

export function Studio() {
  const [studio, setStudio] = useState<Studio | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [sourceId, setSourceId] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [running, setRunning] = useState<string | null>(null);

  const [topic, setTopic] = useState('');
  const [angle, setAngle] = useState('');
  const [newTopic, setNewTopic] = useState('');

  const [cron, setCron] = useState('');
  const [autoCompose, setAutoCompose] = useState(false);
  const [autoIdeate, setAutoIdeate] = useState(true);
  const [perRun, setPerRun] = useState(1);
  const [ideateCount, setIdeateCount] = useState(6);
  const [brand, setBrand] = useState('');

  const load = useCallback(async () => {
    try {
      const [st, se] = await Promise.all([
        api.get<Studio>('/api/studio/topics'),
        api.get<Settings>('/api/settings'),
      ]);
      setStudio(st);
      setSettings(se);
      setCron(se.schedule.generate);
      setAutoCompose(Boolean(se.schedule.autoCompose));
      setAutoIdeate(se.schedule.autoIdeate !== false);
      setPerRun(se.schedule.composePerRun ?? 1);
      setIdeateCount(se.schedule.ideatePerRun ?? 6);
      setBrand(se.brand);
      setSourceId((cur) => cur ?? st.sources[0]?.id ?? null);
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'err');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(load, 12000);
    return () => clearInterval(t);
  }, [load]);

  async function saveSettings() {
    setBusy('settings');
    try {
      await api.post('/api/settings', {
        brand,
        scheduleGenerate: cron,
        autoCompose,
        autoIdeate,
        composePerRun: perRun,
        ideatePerRun: ideateCount,
      });
      toast('定时设置已保存');
      void load();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'err');
    } finally {
      setBusy('');
    }
  }

  async function ideate() {
    if (!sourceId) return;
    setBusy('ideate');
    setRunning('ideate');
    try {
      await api.post(`/api/sources/${sourceId}/ideate`, { count: ideateCount });
      toast('选题生成中，完成后自动刷新');
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'err');
      setRunning(null);
    } finally {
      setBusy('');
    }
  }

  async function compose(t: string, a = '') {
    if (!sourceId) return;
    setBusy('compose');
    setRunning('compose');
    try {
      const r = await api.post<{ draftId: number; title: string }>('/api/compose', {
        sourceId,
        topic: t,
        angle: a,
        brand,
      });
      toast(`已生成：${r.title}（去「草稿审核」查看）`);
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'err');
      setRunning(null);
    } finally {
      setBusy('');
    }
  }

  async function addTopic() {
    if (!sourceId || !newTopic.trim()) return;
    try {
      await api.post(`/api/sources/${sourceId}/topics`, { title: newTopic.trim() });
      setNewTopic('');
      toast('已加入选题池');
      void load();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'err');
    }
  }

  async function dropTopic(id: number) {
    try {
      await api.post(`/api/topics/${id}/remove`);
      void load();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'err');
    }
  }

  if (loading) return <Spinner />;

  const openTopics = (studio?.topics ?? []).filter((t) => t.status === 'open');
  const cur = studio?.sources.find((s) => s.id === sourceId);

  return (
    <div>
      <SectionTitle
        title="创作台"
        desc="选题与创作独立于语料库，按自己的节奏产出内容"
      />

      {/* 语料源选择 */}
      <Card className="mb-5">
        <label className="label">以哪个作者的语料为底稿</label>
        {studio && studio.sources.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {studio.sources.map((s) => (
              <button
                key={s.id}
                onClick={() => setSourceId(s.id)}
                className={`px-3 py-2 rounded-lg text-sm border transition-colors ${
                  s.id === sourceId
                    ? 'border-accent-400 bg-accent-500/10 text-accent-600 font-medium'
                    : 'border-ink-200 text-ink-600 hover:bg-ink-50'
                }`}
              >
                {s.nickname ?? `源 #${s.id}`}
                <span className="text-ink-400 ml-1.5 text-xs">{s.note_count} 篇</span>
              </button>
            ))}
          </div>
        ) : (
          <p className="text-sm text-ink-500">
            还没有可用的语料。先去
            <Link to="/sources" className="text-accent-500 hover:underline mx-1">
              语料库
            </Link>
            抓一个作者，并完成蒸馏。
          </p>
        )}
      </Card>

      {/* 定时任务 */}
      <Card className="mb-5">
        <SectionTitle
          title="定时任务"
          desc="到点自动选题 + 创作，产出后进入草稿审核等你过目"
        />

        <div className="flex items-center justify-between py-3 border-b border-ink-100">
          <div>
            <div className="text-sm font-medium">启用定时创作</div>
            <div className="text-xs text-ink-500 mt-0.5">
              关闭后所有创作都只能手动触发
            </div>
          </div>
          <button
            className={autoCompose ? 'btn-primary' : 'btn-ghost'}
            onClick={() => setAutoCompose((v) => !v)}
          >
            {autoCompose ? '已开启' : '已关闭'}
          </button>
        </div>

        <div className="grid md:grid-cols-2 gap-4 py-4 border-b border-ink-100">
          <div>
            <label className="label">执行时间（crontab）</label>
            <input
              className="input font-mono"
              value={cron}
              onChange={(e) => setCron(e.target.value)}
              placeholder="30 9 * * *"
            />
            <div className="text-[11px] text-ink-400 mt-1">
              下次运行：{fmtNext(settings?.nextRun?.generate ?? null)}
            </div>
          </div>
          <div>
            <label className="label">每次产几篇</label>
            <input
              type="number"
              min={1}
              max={5}
              className="input"
              value={perRun}
              onChange={(e) => setPerRun(Number(e.target.value))}
            />
            <label className="label mt-3">选题池不足时自动补几条选题</label>
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={0}
                max={20}
                className="input w-24"
                value={ideateCount}
                onChange={(e) => setIdeateCount(Number(e.target.value))}
                disabled={!autoIdeate}
              />
              <button
                className={autoIdeate ? 'btn-primary' : 'btn-ghost'}
                onClick={() => setAutoIdeate((v) => !v)}
              >
                {autoIdeate ? '自动补选题：开' : '自动补选题：关'}
              </button>
            </div>
          </div>
        </div>

        <div className="py-4">
          <label className="label">品牌署名（显示在卡片页脚）</label>
          <input
            className="input"
            value={brand}
            onChange={(e) => setBrand(e.target.value)}
            placeholder="留空则不显示"
          />
        </div>

        <div className="flex items-center gap-3">
          <button className="btn-primary" disabled={busy === 'settings'} onClick={() => void saveSettings()}>
            保存定时设置
          </button>
          <span className="text-xs text-ink-400 flex items-center gap-1.5">
            <Dot ok={autoCompose} />
            {autoCompose ? '定时创作运行中' : '定时创作未开启'}
          </span>
        </div>
      </Card>

      {/* 选题 */}
      <Card className="mb-5">
        <SectionTitle
          title="选题"
          desc={`待创作 ${openTopics.length} 条`}
          action={
            <button
              className="btn-ghost"
              disabled={!sourceId || busy === 'ideate'}
              onClick={() => void ideate()}
            >
              {busy === 'ideate' || running === 'ideate' ? '生成中…' : 'AI 生成选题'}
            </button>
          }
        />

        {running === 'ideate' && (
          <div className="rounded-lg bg-violet-50 border border-violet-200 px-3 py-2 mb-3 text-sm text-violet-800">
            正在生成选题，通常 1-2 分钟…
          </div>
        )}

        <div className="flex gap-2 mb-4">
          <input
            className="input flex-1"
            placeholder="手动添加选题…"
            value={newTopic}
            onChange={(e) => setNewTopic(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void addTopic()}
          />
          <button className="btn-ghost" disabled={!newTopic.trim()} onClick={() => void addTopic()}>
            添加
          </button>
        </div>

        {openTopics.length === 0 ? (
          <Empty>
            选题池是空的。点右上「AI 生成选题」，或手动添加。
            {autoCompose && ' 定时任务也会在池子空时自动补。'}
          </Empty>
        ) : (
          <div className="space-y-1.5 max-h-96 overflow-y-auto">
            {openTopics.map((t) => (
              <div
                key={t.id}
                className="flex items-center gap-3 p-2.5 rounded-lg border border-ink-100 hover:border-accent-300"
              >
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-ink-800 truncate">{t.title}</div>
                  <div className="text-[11px] text-ink-400 mt-0.5 truncate">
                    {t.nickname ?? '未知来源'}
                    {t.angle ? ` · ${t.angle}` : ''}
                  </div>
                </div>
                {t.origin === 'ai' && <span className="badge bg-violet-100 text-violet-600">AI</span>}
                <button
                  className="btn-primary text-xs px-2.5 py-1"
                  disabled={busy === 'compose'}
                  onClick={() => void compose(t.title, t.angle)}
                >
                  创作
                </button>
                <button
                  className="text-xs text-ink-400 hover:text-rose-600 px-1"
                  onClick={() => void dropTopic(t.id)}
                >
                  删
                </button>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* 立即创作 */}
      <Card>
        <SectionTitle title="立即创作" desc="不走选题池，直接指定题目产一篇" />
        {running === 'compose' && (
          <div className="rounded-lg bg-violet-50 border border-violet-200 px-3 py-2 mb-3 text-sm text-violet-800">
            正在创作并渲染卡片，通常 1-2 分钟…
          </div>
        )}
        <label className="label">题目</label>
        <input
          className="input mb-3"
          placeholder="例如：为什么你的品牌总是有产品没品牌"
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
        />
        <label className="label">切入角度（可选）</label>
        <input
          className="input mb-4"
          placeholder="例如：从记忆系统切入，强调可执行"
          value={angle}
          onChange={(e) => setAngle(e.target.value)}
        />
        <button
          className="btn-primary"
          disabled={!sourceId || !topic.trim() || busy === 'compose'}
          onClick={() => void compose(topic.trim(), angle.trim())}
        >
          {busy === 'compose' ? '创作中…' : `用「${cur?.nickname ?? '所选'}」的语料创作`}
        </button>
      </Card>
    </div>
  );
}
