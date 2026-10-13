import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, type Draft, type DraftCard, mediaUrl } from '../api';
import { Card, SectionTitle, StatusBadge, Spinner, Empty } from '../components';
import { useDraftValue } from '../useDraftValue';
import { toast } from '../store';

export function DraftDetail() {
  const { id } = useParams<{ id: string }>();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [cards, setCards] = useState<DraftCard[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [editing, setEditing] = useState(false);

  // 标题/正文/标签都是大段文字，编辑时不能被任何自动 load 冲掉。
  // 本页虽然没有轮询，但 rerender() 之后 8 秒会自动 load 一次，
  // 那时用户可能正在改文案 —— 同一类问题，同样用 useDraftValue 兜住。
  const draftTitle = useDraftValue(draft?.title ?? '');
  const draftBody = useDraftValue(draft?.body ?? '');
  const draftTags = useDraftValue(
    JSON.parse(draft?.tags || '[]').join(' '),
  );

  async function load() {
    if (!id) return;
    try {
      const res = await api.get<{ draft: Draft; cards: DraftCard[] }>(`/api/drafts/${id}`);
      setDraft(res.draft);
      setCards(res.cards);
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'err');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, [id]);

  async function setStatus(status: string) {
    setBusy(status);
    try {
      await api.post(`/api/drafts/${id}/status`, { status });
      toast(`已标记为「${status}」`);
      void load();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'err');
    } finally {
      setBusy('');
    }
  }

  async function save() {
    setBusy('save');
    try {
      await api.post(`/api/drafts/${id}/edit`, {
        title: draftTitle.value,
        body: draftBody.value,
        tags: draftTags.value.split(/\s+/).filter(Boolean),
      });
      toast('已保存');
      setEditing(false);
      draftTitle.commit();
      draftBody.commit();
      draftTags.commit();
      void load();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'err');
    } finally {
      setBusy('');
    }
  }

  async function rerender() {
    setBusy('render');
    try {
      await api.post(`/api/drafts/${id}/rerender`);
      toast('重新渲染中，稍后刷新查看');
      setTimeout(() => void load(), 8000);
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'err');
    } finally {
      setBusy('');
    }
  }

  if (loading) return <Spinner />;
  if (!draft) return <Empty>草稿不存在</Empty>;

  const tagList: string[] = JSON.parse(draft.tags || '[]');
  const isFinal = draft.status === 'published';

  return (
    <div>
      <div className="mb-4">
        <Link to="/drafts" className="text-sm text-ink-500 hover:text-accent-500">
          ← 草稿审核
        </Link>
      </div>

      <SectionTitle
        title={draft.title}
        desc={`来源：${draft.nickname ?? '未知'} · 创建于 ${draft.created_at}`}
        action={
          <div className="flex items-center gap-2">
            <StatusBadge status={draft.status} />
            {!isFinal && (
              <>
                <button
                  className="btn-ghost"
                  onClick={() => {
                    // 取消编辑 = 放弃改动。必须显式 reset：onBlur 现在不再
                    // 把值擦回服务器（那会吃掉「保存」），所以改过的字会
                    // 一直留在 draft 里，不 reset 的话下次点「编辑文案」
                    // 看到的还是上一次的脏值。
                    draftTitle.reset();
                    draftBody.reset();
                    draftTags.reset();
                    setEditing(false);
                  }}
                >
                  {editing ? '取消编辑' : '编辑文案'}
                </button>
                <button className="btn-ghost" disabled={busy === 'render'} onClick={() => void rerender()}>
                  {busy === 'render' ? '渲染中…' : '重新渲染'}
                </button>
                {draft.status !== 'approved' && (
                  <button className="btn-primary" disabled={busy === 'approved'} onClick={() => void setStatus('approved')}>
                    通过
                  </button>
                )}
                {draft.status !== 'rejected' && (
                  <button className="btn-danger" onClick={() => void setStatus('rejected')}>
                    拒绝
                  </button>
                )}
              </>
            )}
          </div>
        }
      />

      {draft.publish_error && (
        <div className="rounded-lg bg-rose-50 border border-rose-200 px-4 py-3 text-sm text-rose-700 mb-4">
          上次发布失败：{draft.publish_error}
        </div>
      )}
      {draft.published_url && (
        <div className="rounded-lg bg-emerald-50 border border-emerald-200 px-4 py-3 text-sm text-emerald-700 mb-4 flex items-center gap-3">
          <span>已发布于 {draft.published_at}</span>
          <a
            href={draft.published_url}
            target="_blank"
            rel="noreferrer"
            className="underline hover:no-underline"
          >
            打开笔记 ↗
          </a>
        </div>
      )}

      {editing ? (
        <Card className="mb-5">
          <label className="label">标题（20 字以内）</label>
          <input className="input mb-3" value={draftTitle.value} maxLength={40} onChange={(e) => draftTitle.onChange(e.target.value)} />
          <label className="label">正文</label>
          <textarea className="input h-64 mb-3" value={draftBody.value} onChange={(e) => draftBody.onChange(e.target.value)} />
          <label className="label">话题标签（空格分隔）</label>
          <input className="input mb-4" value={draftTags.value} onChange={(e) => draftTags.onChange(e.target.value)} />
          <div className="flex gap-2">
            <button className="btn-primary" disabled={busy === 'save'} onClick={() => void save()}>
              {busy === 'save' ? '保存中…' : '保存'}
            </button>
            <p className="text-xs text-ink-400 self-center">
              改完文案后点「重新渲染」可让卡片内容同步更新。
            </p>
          </div>
        </Card>
      ) : (
        <Card className="mb-5">
          <p className="text-sm text-ink-700 whitespace-pre-wrap leading-relaxed">{draft.body}</p>
          {tagList.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mt-4 pt-4 border-t border-ink-100">
              {tagList.map((t) => (
                <span key={t} className="badge bg-accent-500/10 text-accent-600">
                  #{t}
                </span>
              ))}
            </div>
          )}
        </Card>
      )}

      <Card>
        <SectionTitle title="配图预览" desc={`${cards.length} 张 · 1080×1440 (3:4)`} />
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {cards.map((c) => {
            const u = mediaUrl(c.image_path);
            return (
              <div key={c.id}>
                {u ? (
                  <img src={u} className="w-full rounded-lg border border-ink-200" alt={`卡片 ${c.idx + 1}`} />
                ) : (
                  <div className="aspect-[3/4] rounded-lg bg-ink-100 grid place-items-center text-xs text-ink-400">
                    未渲染
                  </div>
                )}
                <div className="text-[11px] text-ink-400 mt-1 text-center">
                  {c.idx + 1}. {c.layout}
                </div>
              </div>
            );
          })}
        </div>
      </Card>
    </div>
  );
}