import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { Card, SectionTitle, StatusBadge, Spinner, Empty, Dot } from '../components';
import { toast } from '../store';
import { useDraftValue } from '../useDraftValue';
import {
  cronToParts,
  partsToCron,
  describeSchedule,
  describeNext,
  type ScheduleParts,
  type Frequency,
} from '../util/schedule';

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
    autoCompose?: boolean;
    autoIdeate?: boolean;
    composePerRun?: number;
    ideatePerRun?: number;
    /** 定时创作 cron 是否真的注册了（设置有值 ≠ 已注册） */
    generateRegistered?: boolean;
    rescrapeRegistered?: boolean;
    /** 上次成功产出草稿的时间 */
    lastCompose?: string | null;
  };
  nextRun?: { generate: string | null };
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

  // 这几个字段都是「从服务器来、用户可能正在改」的输入项。
  // 页面每 12 秒轮询一次，直接 setState 会把用户打了一半的字冲掉，
  // 所以走 useDraftValue：编辑中不被轮询覆盖，失焦才回归服务器值。
  const serverParts = cronToParts(settings?.schedule.generate ?? '30 9 * * *');
  const draftParts = useDraftValue(serverParts);
  const draftAutoCompose = useDraftValue(Boolean(settings?.schedule.autoCompose));
  const draftAutoIdeate = useDraftValue(settings?.schedule.autoIdeate !== false);
  const draftPerRun = useDraftValue(Number(settings?.schedule.composePerRun ?? 1));
  const draftIdeateCount = useDraftValue(Number(settings?.schedule.ideatePerRun ?? 6));
  const draftBrand = useDraftValue(settings?.brand ?? '');

  const load = useCallback(async() => {
    try {
      const [st, se] = await Promise.all([
        api.get<Studio>('/api/studio/topics'),
        api.get<Settings>('/api/settings'),
      ]);
      setStudio(st);
      setSettings(se);
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

  /**
   * 只保存指定字段（其余字段用当前 draft 值补齐）。
   * 给「点击即生效」的开关用 —— 开关不该依赖用户去找保存按钮。
   */
  async function saveNow(partial?: { autoCompose?: boolean; autoIdeate?: boolean }) {
    setBusy('settings');
    try {
      await api.post('/api/settings', {
        brand: draftBrand.value,
        scheduleGenerate: partsToCron(draftParts.value),
        autoCompose: partial?.autoCompose ?? draftAutoCompose.value,
        autoIdeate: partial?.autoIdeate ?? draftAutoIdeate.value,
        composePerRun: draftPerRun.value,
        ideatePerRun: draftIdeateCount.value,
      });
      return true;
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'err');
      return false;
    } finally {
      setBusy('');
    }
  }

  async function saveSettings() {
    setBusy('settings');
    try {
      await api.post('/api/settings', {
        brand: draftBrand.value,
        scheduleGenerate: partsToCron(draftParts.value),
        autoCompose: draftAutoCompose.value,
        autoIdeate: draftAutoIdeate.value,
        composePerRun: draftPerRun.value,
        ideatePerRun: draftIdeateCount.value,
      });
      toast('定时设置已保存');
      // 提交成功后清除 dirty：服务器值已经是刚提交的那个，
      // 不 commit 的话输入框会停在本地值、和服务器不一致（虽然此时恰好相同）
      draftBrand.commit();
      draftParts.commit();
      draftAutoCompose.commit();
      draftAutoIdeate.commit();
      draftPerRun.commit();
      draftIdeateCount.commit();
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
      await api.post(`/api/sources/${sourceId}/ideate`, { count: draftIdeateCount.value });
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
        brand: draftBrand.value,
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
            className={draftAutoCompose.value ? 'btn-primary' : 'btn-ghost'}
            disabled={busy === 'settings'}
            onClick={() => {
              // ⚠️ 开关**点击即保存**，不等「保存定时设置」。
              // 之前只改本地状态：用户点完看到「已关闭」，以为生效了，
              // 实际上保存请求从未发出 —— 刷新又变回「已开启」
              //（实测 2026-10-20：数据库里 auto_compose 一直是 true）。
              // 立即落库 + 乐观更新，失败回滚并提示。
              const next = !draftAutoCompose.value;
              draftAutoCompose.onChange(next);
              void (async () => {
                const ok = await saveNow({ autoCompose: next });
                if (ok) {
                  draftAutoCompose.commit();
                  toast(next ? '定时创作已开启' : '定时创作已关闭');
                } else {
                  draftAutoCompose.onChange(!next); // 失败回滚
                }
              })();
            }}
          >
            {busy === 'settings' ? '保存中…' : draftAutoCompose.value ? '已开启' : '已关闭'}
          </button>
        </div>

        <div className="grid md:grid-cols-2 gap-4 py-4 border-b border-ink-100">
          <div>
            <label className="label">什么时候跑</label>
            <div className="flex flex-wrap items-center gap-2">
              <select
                className="input w-32"
                value={draftParts.value.freq}
                onChange={(e) =>
                  draftParts.onChange({ ...draftParts.value, freq: e.target.value as Frequency })
                }
              >
                <option value="daily">每天</option>
                <option value="weekly">每周</option>
                <option value="hourly">每隔几小时</option>
              </select>

              {draftParts.value.freq === 'hourly' ? (
                <div className="flex items-center gap-1.5">
                  <span className="text-sm text-ink-500">每</span>
                  <input
                    type="number"
                    min={1}
                    max={23}
                    className="input w-20"
                    value={draftParts.value.everyNHours}
                    onChange={(e) =>
                      draftParts.onChange({ ...draftParts.value, everyNHours: Number(e.target.value) })
                    }
                  />
                  <span className="text-sm text-ink-500">小时</span>
                </div>
              ) : (
                <input
                  type="time"
                  className="input w-32"
                  value={draftParts.value.time}
                  onChange={(e) => draftParts.onChange({ ...draftParts.value, time: e.target.value })}
                />
              )}
            </div>

            {draftParts.value.freq === 'weekly' && (
              <div className="flex gap-1 mt-2">
                {[1, 2, 3, 4, 5, 6, 7].map((d) => (
                  <button
                    key={d}
                    onClick={() =>
                      draftParts.onChange({
                        ...draftParts.value,
                        days: draftParts.value.days.includes(d)
                          ? draftParts.value.days.filter((x) => x !== d)
                          : [...draftParts.value.days, d].sort(),
                      })
                    }
                    className={`w-8 h-8 rounded-lg text-xs font-medium transition-colors ${
                      draftParts.value.days.includes(d)
                        ? 'bg-accent-500 text-white'
                        : 'bg-ink-100 text-ink-500 hover:bg-ink-200'
                    }`}
                  >
                    {['一', '二', '三', '四', '五', '六', '日'][d - 1]}
                  </button>
                ))}
              </div>
            )}

            <div className="text-[11px] text-ink-500 mt-2">
              {describeSchedule(draftParts.value)} · 下次：{describeNext(settings?.nextRun?.generate ?? null)}
            </div>
            <details className="text-[11px] text-ink-400 mt-1">
              <summary className="cursor-pointer select-none">crontab 原始表达式</summary>
              <code className="bg-ink-100 px-1.5 py-0.5 rounded ml-1">{partsToCron(draftParts.value)}</code>
            </details>
          </div>
          <div>
            <label className="label">每次产几篇</label>
            <input
              type="number"
              min={1}
              max={5}
              className="input"
              value={draftPerRun.value}
              onChange={(e) => draftPerRun.onChange(Number(e.target.value))}
            />
            <label className="label mt-3">选题池不足时自动补几条选题</label>
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={0}
                max={20}
                className="input w-24"
                value={draftIdeateCount.value}
                onChange={(e) => draftIdeateCount.onChange(Number(e.target.value))}
                disabled={!draftAutoIdeate.value}
              />
              <button
                className={draftAutoIdeate.value ? 'btn-primary' : 'btn-ghost'}
                disabled={busy === 'settings'}
                onClick={() => {
                  // 同主开关：点击即保存，失败回滚（不依赖保存按钮）
                  const next = !draftAutoIdeate.value;
                  draftAutoIdeate.onChange(next);
                  void (async () => {
                    const ok = await saveNow({ autoIdeate: next });
                    if (ok) {
                      draftAutoIdeate.commit();
                      toast(next ? '自动补选题已开启' : '自动补选题已关闭');
                    } else {
                      draftAutoIdeate.onChange(!next);
                    }
                  })();
                }}
              >
                {draftAutoIdeate.value ? '自动补选题：开' : '自动补选题：关'}
              </button>
            </div>
          </div>
        </div>

        <div className="py-4">
          <label className="label">品牌署名（显示在卡片页脚）</label>
          <input
            className="input"
            value={draftBrand.value}
            onChange={(e) => draftBrand.onChange(e.target.value)}
            onBlur={draftBrand.onBlur}
            placeholder="留空则不显示"
          />
        </div>

        <div className="flex items-center gap-3">
          <button className="btn-primary" disabled={busy === 'settings'} onClick={() => void saveSettings()}>
            保存定时设置
          </button>
          <span className="text-xs text-ink-400 flex items-center gap-1.5">
            {/* 三种状态，不能只看开关：开关开着但 cron 没注册过的情况真实发生过，
                界面却一直显示「运行中」。现在以服务端的注册状态为准。 */}
            {!draftAutoCompose.value ? (
              <>
                <Dot ok={false} />
                定时创作未开启
              </>
            ) : settings?.schedule.generateRegistered ? (
              <>
                <Dot ok />
                定时创作运行中
                {settings.schedule.lastCompose
                  ? ` · 上次 ${settings.schedule.lastCompose}`
                  : ' · 尚未产出过'}
              </>
            ) : (
              <>
                <Dot ok={false} />
                开关已开但定时任务未注册 —— 需重启服务
              </>
            )}
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
            {draftAutoCompose.value && ' 定时任务也会在池子空时自动补。'}
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
