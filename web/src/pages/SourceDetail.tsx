import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, type NoteRow, type Topic, mediaUrl, fmtDate, fmtNum } from '../api';
import { Card, SectionTitle, StatusBadge, Spinner, Empty, Stat } from '../components';
import { toast } from '../store';

interface Detail {
  source: {
    id: number;
    nickname: string | null;
    profile_url: string;
    note_count: number;
    last_scraped_at: string | null;
  };
  stats: { total: number; styled: number };
  notes: NoteRow[];
  styleProfile: StyleProfile | null;
  cardSpec: Record<string, unknown>;
}

interface StyleProfile {
  persona: { one_liner: string; audience: string; content_categories: string[] };
  language: {
    title_formulas: string[];
    avg_title_chars: number;
    body_chars_range: string;
    emoji_per_100_chars: number;
    signature_phrases: string[];
  };
  visual: {
    dominant_layouts: string[];
    cover_patterns: string[];
    palette_summary: string;
  };
  card_template_spec: {
    palette: string[];
    background: string;
    accent: string;
    title_size: number;
  };
  do_list: string[];
  dont_list: string[];
  topic_map: Array<{ topic: string; note_count: number; avg_liked: number }>;
}

interface NoteDetail {
  note: { id: number; title: string; desc: string; tags: string; liked_count: number };
  images: Array<{ id: number; local_path: string | null; palette: string | null }>;
  style: unknown;
}

export function SourceDetail() {
  const { id } = useParams<{ id: string }>();
  const [data, setData] = useState<Detail | null>(null);
  const [topics, setTopics] = useState<Topic[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [noteDetail, setNoteDetail] = useState<NoteDetail | null>(null);
  const [running, setRunning] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);

  async function load() {
    if (!id) return;
    try {
      const [d, t] = await Promise.all([
        api.get<Detail>(`/api/sources/${id}`),
        api.get<Topic[]>(`/api/sources/${id}/topics`),
      ]);
      setData(d);
      setTopics(t);
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'err');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    const t = setInterval(load, 12000);
    return () => clearInterval(t);
  }, [id]);

  async function act(name: string, fn: () => Promise<unknown>, msg: string) {
    setBusy(name);
    try {
      await fn();
      toast(msg);
      // 后台任务要跑一会儿，给个可见的进行中状态，
      // 否则「点了没反应」和「正在跑」在界面上长得一模一样
      setRunning(name);
      setTimeout(() => void load(), 2000);
    } catch (err) {
      const e = err as { message?: string; hint?: string };
      toast(e.message ?? String(err), 'err');
      if (e.hint) setHint(e.hint);
    } finally {
      setBusy('');
    }
  }

  /** 轮询任务状态，完成或失败后停止 */
  useEffect(() => {
    if (!running) return;
    const t = setInterval(async () => {
      try {
        const j = await api.get<{ type: string; status: string; last_error: string | null }[]>(
          '/api/jobs',
        );
        const hit = j.find((x) => x.type === running && x.status === 'running');
        if (!hit) {
          setRunning(null);
          setHint(null);
          void load();
        }
      } catch {
        /* 忽略 */
      }
    }, 4000);
    return () => clearInterval(t);
  }, [running, id]);

  async function openNote(pk: number) {
    try {
      setNoteDetail(await api.get<NoteDetail>(`/api/sources/${id}/notes/${pk}`));
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'err');
    }
  }


  if (loading) return <Spinner />;
  if (!data) return <Empty>加载失败</Empty>;

  const p = data.styleProfile;

  return (
    <div>
      <div className="mb-4">
        <Link to="/sources" className="text-sm text-ink-500 hover:text-accent-500">
          ← 语料库
        </Link>
      </div>

      <SectionTitle
        title={data.source.nickname ?? '未命名作者'}
        desc={`${data.source.profile_url} · 最近抓取 ${data.source.last_scraped_at ?? '从未'}`}
        action={
          <div className="flex gap-2">
            <button
              className="btn-ghost"
              disabled={busy === 'distill' || running === 'distill'}
              onClick={() => void act('distill', () => api.post(`/api/sources/${id}/distill`), '蒸馏已开始')}
            >
              {busy === 'distill' ? '提交中…' : '蒸馏语料'}
            </button>
            <Link to="/studio" className="btn-ghost">
              去创作台 →
            </Link>
          </div>
        }
      />

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-5">
        <Stat label="笔记总数" value={data.stats.total} />
        <Stat label="已蒸馏" value={data.stats.styled} hint={data.stats.total ? `${Math.round((data.stats.styled / data.stats.total) * 100)}%` : ''} />
        <Stat label="风格档案" value={p ? '已生成' : '未生成'} />
      </div>

      {/* 风格画像 */}
      {p ? (
        <Card className="mb-5">
          <SectionTitle title="风格画像" desc={p.persona.one_liner} />

          <div className="grid md:grid-cols-3 gap-5 mb-5">
            <div>
              <h4 className="text-xs font-semibold text-ink-500 mb-2">配色规格</h4>
              <div className="flex gap-1.5 mb-2">
                {p.card_template_spec.palette.map((c) => (
                  <div
                    key={c}
                    className="w-9 h-9 rounded-md border border-ink-200"
                    style={{ background: c }}
                    title={c}
                  />
                ))}
              </div>
              <div className="text-[11px] text-ink-500">
                背景 {p.card_template_spec.background} · 强调 {p.card_template_spec.accent} · 标题{' '}
                {p.card_template_spec.title_size}px
              </div>
              <h4 className="text-xs font-semibold text-ink-500 mt-4 mb-1.5">图片版式</h4>
              <div className="text-xs text-ink-600">{p.visual.dominant_layouts.join(' / ')}</div>
            </div>

            <div>
              <h4 className="text-xs font-semibold text-ink-500 mb-2">标题公式</h4>
              <ul className="text-xs text-ink-600 space-y-1">
                {p.language.title_formulas.map((f) => (
                  <li key={f}>· {f}</li>
                ))}
              </ul>
              <div className="text-[11px] text-ink-400 mt-2">
                均长 {p.language.avg_title_chars} 字 · 正文 {p.language.body_chars_range} · 每百字{' '}
                {p.language.emoji_per_100_chars} 个 emoji
              </div>
              {p.language.signature_phrases.length > 0 && (
                <>
                  <h4 className="text-xs font-semibold text-ink-500 mt-4 mb-1.5">口头禅</h4>
                  <div className="flex flex-wrap gap-1">
                    {p.language.signature_phrases.slice(0, 6).map((s) => (
                      <span key={s} className="badge bg-ink-100 text-ink-600">
                        {s}
                      </span>
                    ))}
                  </div>
                </>
              )}
            </div>

            <div>
              <h4 className="text-xs font-semibold text-ink-500 mb-2">模仿准则</h4>
              <ul className="text-xs text-emerald-700 space-y-1">
                {p.do_list.map((d) => (
                  <li key={d}>✓ {d}</li>
                ))}
              </ul>
              <ul className="text-xs text-rose-600 space-y-1 mt-2">
                {p.dont_list.map((d) => (
                  <li key={d}>✗ {d}</li>
                ))}
              </ul>
            </div>
          </div>

          {p.topic_map.length > 0 && (
            <>
              <h4 className="text-xs font-semibold text-ink-500 mb-2">选题分布</h4>
              <div className="flex flex-wrap gap-1.5">
                {p.topic_map.slice(0, 14).map((t) => (
                  <span
                    key={t.topic}
                    className="badge bg-accent-500/10 text-accent-600"
                    title={`${t.note_count} 篇 / 均赞 ${t.avg_liked}`}
                  >
                    {t.topic} · {t.note_count}
                  </span>
                ))}
              </div>
            </>
          )}
        </Card>
      ) : (
        <Card className="mb-5">
          <Empty>
            风格画像尚未生成 —— 至少需要 3 篇完成蒸馏的笔记。
            <button className="btn-ghost ml-2" onClick={() => void act('distill', () => api.post(`/api/sources/${id}/distill`), '蒸馏任务已入队')}>
              立即蒸馏
            </button>
          </Empty>
        </Card>
      )}
      <Card>
        <SectionTitle title="原始语料" desc={`${data.notes.length} 篇笔记`} />
        {data.notes.length === 0 ? (
          <Empty>还没有抓取到笔记</Empty>
        ) : (
          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-2">
            {data.notes.map((n) => (
              <button
                key={n.id}
                onClick={() => void openNote(n.id)}
                className="text-left p-3 rounded-lg border border-ink-200 hover:border-accent-400 hover:bg-ink-50 transition-colors"
              >
                <div className="flex items-start gap-2 mb-1">
                  <span className="text-sm font-medium text-ink-800 line-clamp-2 flex-1">
                    {n.title || '（无标题）'}
                  </span>
                  {n.styled ? (
                    <span className="badge bg-emerald-100 text-emerald-600 shrink-0">已蒸馏</span>
                  ) : null}
                </div>
                <div className="flex items-center gap-3 text-[11px] text-ink-400">
                  <span>{fmtDate(n.published_at)}</span>
                  <span>♥ {fmtNum(n.liked_count)}</span>
                  <span>☆ {fmtNum(n.collected_count)}</span>
                  <span>{n.image_count} 图</span>
                </div>
              </button>
            ))}
          </div>
        )}
      </Card>

      {/* 笔记详情弹层 */}
      {noteDetail && (
        <div
          className="fixed inset-0 bg-ink-900/40 flex items-center justify-center p-8 z-40"
          onClick={() => setNoteDetail(null)}
        >
          <div
            className="bg-white rounded-xl max-w-3xl w-full max-h-[85vh] overflow-y-auto p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex justify-between items-start mb-4">
              <h3 className="font-semibold text-lg">{noteDetail.note.title || '（无标题）'}</h3>
              <button className="btn-ghost" onClick={() => setNoteDetail(null)}>
                关闭
              </button>
            </div>

            <div className="flex flex-wrap gap-1.5 mb-4">
              {JSON.parse(noteDetail.note.tags || '[]').map((t: string) => (
                <span key={t} className="badge bg-ink-100 text-ink-600">
                  #{t}
                </span>
              ))}
            </div>

            <p className="text-sm text-ink-700 whitespace-pre-wrap mb-5 leading-relaxed">
              {noteDetail.note.desc}
            </p>

            <div className="grid grid-cols-4 gap-2 mb-5">
              {noteDetail.images.map((img) => {
                const u = mediaUrl(img.local_path);
                return u ? (
                  <img key={img.id} src={u} className="w-full rounded-lg border border-ink-200" alt="" />
                ) : (
                  <div key={img.id} className="aspect-[3/4] rounded-lg bg-ink-100 grid place-items-center text-xs text-ink-400">
                    未下载
                  </div>
                );
              })}
            </div>

            {noteDetail.style ? (
              <pre className="text-[11px] bg-ink-50 p-3 rounded-lg overflow-x-auto whitespace-pre-wrap">
                {JSON.stringify(noteDetail.style, null, 2)}
              </pre>
            ) : (
              <Empty>尚未蒸馏</Empty>
            )}
          </div>
        </div>
      )}
    </div>
  );
}