import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type Draft } from '../api';
import { Card, SectionTitle, Spinner, Empty } from '../components';
import { toast } from '../store';

interface Prep {
  draft: {
    id: number;
    title: string;
    body: string;
    tags: string[];
    rendered: boolean;
    imageCount: number;
  };
  images: Array<{ idx: number; layout: string; image_path: string }>;
  creatorUrl: string;
}

/**
 * 发布准备台。
 *
 * 2026-10-12 起不再有自动化发布。账号此前因「AI 模拟浏览」被处置一周，
 * 而发布这条链路（打开创作中心 → 传图 → 填表 → 点发布 → 回管理页核对）
 * 是全部功能里最重的机器行为，全程没有真人在回路。拟人节奏降低得了
 * 抓取的风险，压不住这个量级的暴露面。
 *
 * 所以这里只做「把素材备齐」：
 *   - 文案：标题 / 正文 / 话题分开，各自一键复制（正文按小红书能吃的
 *     纯文本给，已去掉 [[强调]] 标记和话题标签）
 *   - 图片：按发布顺序打成 zip 下载（条目名 01.jpg / 02.jpg …，
 *     解压后按文件名全选上传就是对的顺序 —— 小红书的图片框按文件名排序）
 *   - 创作中心：一键打开图文发布页
 *   - 登记：发完把笔记链接贴回来，草稿归档成「已发布」，记录可查
 */
export function Publish() {
  const [queue, setQueue] = useState<Draft[]>([]);
  const [history, setHistory] = useState<Draft[]>([]);
  const [prep, setPrep] = useState<Prep | null>(null);
  const [prepLoading, setPrepLoading] = useState(false);
  const [markUrl, setMarkUrl] = useState<Record<number, string>>({});

  async function load() {
    try {
      const [d, h] = await Promise.all([
        api.get<Draft[]>('/api/drafts?status=approved'),
        api.get<Draft[]>('/api/drafts?status=published'),
      ]);
      setQueue(d);
      setHistory(h);
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'err');
    }
  }

  useEffect(() => {
    void load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, []);

  async function openPrep(id: number) {
    setPrepLoading(true);
    setPrep(null);
    try {
      const p = await api.get<Prep>(`/api/publish/prep/${id}`);
      setPrep(p);
      setMarkUrl((m) => ({ ...m, [id]: '' }));
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'err');
    } finally {
      setPrepLoading(false);
    }
  }

  /** 下载图片 zip（按发布顺序 01.jpg/02.jpg…）。 */
  async function downloadImages(id: number) {
    try {
      const res = await fetch(`/api/publish/images/${id}`);
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      try {
        const a = document.createElement('a');
        a.href = url;
        a.download = `xhsflow-draft-${id}-images.zip`;
        document.body.appendChild(a);
        a.click();
        a.remove();
      } finally {
        setTimeout(() => URL.revokeObjectURL(url), 30_000);
      }
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'err');
    }
  }

  async function copy(label: string, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast(`${label}已复制（${text.length} 字）`);
    } catch {
      // 剪贴板 API 在非 https/localhost 下不可用；退回选中复制
      toast(`${label}复制失败，请手动选中复制`, 'err');
    }
  }

  async function markPublished(id: number) {
    const url = markUrl[id] ?? '';
    if (url && !confirm(`确认这篇已经在小红书发布完成？\n链接：${url}`)) return;
    try {
      const r = await api.post<{ ok: boolean; note?: string }>(`/api/publish/mark/${id}`, { url });
      toast(r.note ?? '已归档为发布完成');
      setPrep((p) => (p && p.draft.id === id ? null : p));
      void load();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'err');
    }
  }

  return (
    <div>
      <SectionTitle
        title="发布"
        desc="素材在这里备齐，最后一步由你在小红书写真身的浏览器里完成"
      />

      <Card className="mb-5 bg-amber-50 border-amber-200">
        <div className="text-sm text-amber-900 font-medium mb-1">为什么改成手动</div>
        <div className="text-xs text-amber-800 leading-relaxed">
          账号此前因「AI 模拟浏览」被小红书限制曝光一周。发布是全部功能里最重的自动化行为
          —— 打开创作中心、传图、逐字填表、点发布、回管理页核对，全程没有真人在回路里，
          拟人节奏压不住这个暴露面。所以发布链路已整体停用：
          <span className="font-medium">自动发布、定时发布、一键发布都取消了</span>
          （创作台的定时创作仍然保留，只产草稿不发布）。
          <br />
          这里改成「发布准备台」：文案一键复制、图片按顺序打包、创作中心一键打开，
          最后粘贴、传图、点发布由你自己完成 —— 那一步是真人行为，平台认这个。
        </div>
      </Card>

      {prepLoading && <Spinner text="正在准备发布素材…" />}

      {prep && (
        <Card className="mb-5 border-accent-200">
          <SectionTitle
            title={`发布素材 · ${prep.draft.title}`}
            desc={`草稿 ${prep.draft.id} · ${prep.draft.imageCount} 张图`}
            action={
              <button className="text-xs text-ink-400 hover:text-ink-700" onClick={() => setPrep(null)}>
                收起
              </button>
            }
          />

          {!prep.draft.rendered && (
            <div className="mb-3 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
              这篇还没渲染图片。到 <Link to={`/drafts/${prep.draft.id}`} className="underline">草稿详情</Link> 点「重新渲染」后再来。
            </div>
          )}

          {/* 文案 */}
          <div className="space-y-2 mb-4">
            <CopyRow
              label="标题"
              hint={`${prep.draft.title.length}/20 字`}
              text={prep.draft.title}
              onCopy={() => void copy('标题', prep.draft.title)}
            />
            <CopyRow
              label="正文"
              hint="已按小红书能吃的纯文本给（无标记、无话题）"
              text={prep.draft.body}
              multiline
              onCopy={() => void copy('正文', prep.draft.body)}
            />
            {prep.draft.tags.length > 0 && (
              <CopyRow
                label="话题标签"
                hint="正文末尾另起一段粘贴，再在编辑器里逐个输入并选中联想项"
                text={prep.draft.tags.map((t) => `#${t}`).join(' ')}
                onCopy={() => void copy('话题标签', prep.draft.tags.map((t) => `#${t}`).join(' '))}
              />
            )}
          </div>

          {/* 图片 + 入口 */}
          <div className="flex flex-wrap items-center gap-2 pt-3 border-t border-ink-100">
            <button
              className="btn-ghost"
              disabled={prep.draft.imageCount === 0}
              onClick={() => void downloadImages(prep.draft.id)}
            >
              下载图片 zip（{prep.draft.imageCount} 张，01.jpg 起）
            </button>
            <a className="btn-primary" href={prep.creatorUrl} target="_blank" rel="noreferrer">
              打开创作中心图文发布页 ↗
            </a>
            <span className="text-[11px] text-ink-400">
              图片框按文件名排序，解压后全选 01.jpg…上传即是发布顺序
            </span>
          </div>

          {/* 登记 */}
          <div className="mt-4 pt-3 border-t border-ink-100">
            <div className="text-xs text-ink-500 mb-2">
              发布完成后，把笔记链接贴回来归档（不填也能归档，只是记录里没有直达链接）：
            </div>
            <div className="flex gap-2">
              <input
                className="input flex-1 font-mono text-xs"
                placeholder="https://www.xiaohongshu.com/explore/…"
                value={markUrl[prep.draft.id] ?? ''}
                onChange={(e) => setMarkUrl((m) => ({ ...m, [prep.draft.id]: e.target.value }))}
              />
              <button className="btn-ghost shrink-0" onClick={() => void markPublished(prep.draft.id)}>
                标记为已发布
              </button>
            </div>
          </div>
        </Card>
      )}

      <div className="mb-3 flex items-baseline justify-between">
        <div className="text-sm font-medium text-ink-700">待发布队列</div>
        <div className="text-xs text-ink-400">{queue.length} 篇已通过审核</div>
      </div>

      {queue.length === 0 ? (
        <Empty>
          队列为空。到 <Link to="/drafts" className="text-accent-500 hover:underline">草稿审核</Link> 通过几篇。
        </Empty>
      ) : (
        <div className="space-y-2">
          {queue.map((d) => (
            <Card key={d.id} className="py-3 flex items-center gap-3">
              <div className="flex-1 min-w-0">
                <div className="font-medium text-ink-900 truncate">{d.title}</div>
                <div className="text-[11px] text-ink-400 mt-0.5">
                  {d.nickname ?? '未知来源'} · {d.created_at}
                  {!d.rendered && ' · ⚠ 未渲染（去详情页重新渲染）'}
                </div>
              </div>
              <button
                className="btn-primary shrink-0"
                disabled={!d.rendered}
                onClick={() => void openPrep(d.id)}
                title={d.rendered ? '备齐文案与图片' : '还没有渲染好的图片'}
              >
                准备发布
              </button>
              <Link to={`/drafts/${d.id}`} className="btn-ghost shrink-0">
                详情
              </Link>
            </Card>
          ))}
        </div>
      )}

      <div className="mt-8">
        <SectionTitle title="发布记录" desc={`已发布 ${history.length} 篇`} />
        {history.length === 0 ? (
          <Empty>还没有发布记录</Empty>
        ) : (
          <div className="space-y-2">
            {history.map((d) => (
              <Card key={d.id} className="py-3 flex items-center gap-3">
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-ink-900 truncate">{d.title}</div>
                  <div className="text-[11px] text-ink-400 mt-0.5">
                    发布于 {d.published_at ?? '—'}
                    {d.nickname ? ` · ${d.nickname}` : ''}
                  </div>
                </div>
                {d.published_url ? (
                  <a href={d.published_url} target="_blank" rel="noreferrer" className="btn-ghost shrink-0">
                    打开笔记
                  </a>
                ) : (
                  <span className="badge bg-ink-100 text-ink-500 shrink-0">无链接</span>
                )}
                <Link to={`/drafts/${d.id}`} className="btn-ghost shrink-0">
                  详情
                </Link>
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function CopyRow({
  label,
  hint,
  text,
  onCopy,
  multiline,
}: {
  label: string;
  hint: string;
  text: string;
  onCopy: () => void;
  multiline?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-lg border border-ink-200 bg-ink-50/60">
      <div className="flex items-center gap-2 px-3 py-2">
        <span className="text-sm font-medium text-ink-700 w-16 shrink-0">{label}</span>
        <span className="text-[11px] text-ink-400 flex-1 truncate">{hint}</span>
        <button className="text-xs text-ink-500 hover:text-ink-800" onClick={() => setOpen((o) => !o)}>
          {open ? '收起' : '展开'}
        </button>
        <button className="btn-primary text-xs py-1 px-3 shrink-0" onClick={onCopy}>
          复制
        </button>
      </div>
      {open && (
        <pre
          className={`px-3 pb-3 text-xs text-ink-700 whitespace-pre-wrap break-words font-sans ${
            multiline ? 'max-h-64 overflow-y-auto' : ''
          }`}
        >
          {text || '（空）'}
        </pre>
      )}
    </div>
  );
}
