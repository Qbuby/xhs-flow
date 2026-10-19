import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type Draft } from '../api';
import { Card, SectionTitle, StatusBadge, Spinner, Empty } from '../components';
import { toast } from '../store';

const TABS = [
  { key: 'pending', label: '待审核' },
  { key: 'approved', label: '已通过' },
  { key: 'rejected', label: '已拒绝' },
  { key: 'published', label: '已发布' },
  { key: '', label: '全部' },
];

export function Drafts() {
  const [tab, setTab] = useState('pending');
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Set<number>>(new Set());

  async function load() {
    try {
      const q = tab ? `?status=${tab}` : '';
      setDrafts(await api.get<Draft[]>(`/api/drafts${q}`));
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'err');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    setLoading(true);
    void load();
  }, [tab]);

  function toggle(id: number) {
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }

  /** 全选/取消当前可见的待审核稿。 */
  function toggleAll() {
    const ids = drafts.filter((d) => d.status === 'pending').map((d) => d.id);
    const allSelected = ids.length > 0 && ids.every((id) => selected.has(id));
    setSelected(allSelected ? new Set() : new Set(ids));
  }

  async function bulkApprove() {
    if (selected.size === 0) return;
    if (!confirm(`通过选中的 ${selected.size} 篇草稿？通过后可在「发布」页发出。`)) return;
    try {
      await api.post('/api/drafts/bulk-approve', { ids: [...selected] });
      toast(`已通过 ${selected.size} 篇`);
      setSelected(new Set());
      void load();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'err');
    }
  }

  /**
   * 批量拒绝。
   *
   * 与批量通过对称，但**语气要更谨慎**：拒绝是不可逆的状态流转，
   * 且用户往往是「这批都不行」而非「这几篇不行」，所以单独确认并说清后果
   * （只改状态、不删数据，可到「已拒绝」标签找回）。
   */
  async function bulkReject() {
    if (selected.size === 0) return;
    if (
      !confirm(
        `拒绝选中的 ${selected.size} 篇草稿？\n\n只会把状态改为「已拒绝」，不会删除内容，` +
          '之后可以在「已拒绝」标签里找回。',
      )
    ) {
      return;
    }
    try {
      await api.post('/api/drafts/bulk-reject', { ids: [...selected] });
      toast(`已拒绝 ${selected.size} 篇`);
      setSelected(new Set());
      void load();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'err');
    }
  }

  const pendingVisible = drafts.filter((d) => d.status === 'pending').length;
  const allSelected = pendingVisible > 0 && pendingVisible === selected.size;

  return (
    <div>
      <SectionTitle
        title="草稿审核"
        desc="逐篇确认后才会发布到你的小红书"
        action={
          <div className="flex items-center gap-2">
            <button className="btn-ghost" disabled={selected.size === 0} onClick={() => void bulkReject()}>
              批量拒绝{selected.size > 0 ? `（${selected.size}）` : ''}
            </button>
            <button className="btn-primary" disabled={selected.size === 0} onClick={() => void bulkApprove()}>
              批量通过{selected.size > 0 ? `（${selected.size}）` : ''}
            </button>
          </div>
        }
      />

      <div className="flex gap-1 mb-4">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-3 py-1.5 rounded-lg text-sm transition-colors ${
              tab === t.key ? 'bg-ink-900 text-white' : 'bg-white text-ink-600 hover:bg-ink-100'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'pending' && pendingVisible > 0 && (
        <label className="flex items-center gap-2 text-xs text-ink-500 mb-2 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={allSelected}
            onChange={toggleAll}
            className="w-4 h-4 accent-accent-500"
          />
          全选本页 {pendingVisible} 篇待审核
          {selected.size > 0 && !allSelected && (
            <span className="text-ink-400">（已选 {selected.size}）</span>
          )}
        </label>
      )}

      {loading ? (
        <Spinner />
      ) : drafts.length === 0 ? (
        <Empty>这里还没有内容</Empty>
      ) : (
        <div className="space-y-2">
          {drafts.map((d) => (
            <Card key={d.id} className="py-3.5 flex items-center gap-3">
              {tab === 'pending' && (
                <input
                  type="checkbox"
                  checked={selected.has(d.id)}
                  onChange={() => toggle(d.id)}
                  className="w-4 h-4 accent-accent-500 shrink-0"
                />
              )}
              <Link to={`/drafts/${d.id}`} className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-ink-900 truncate">{d.title}</span>
                  {!d.rendered && <span className="badge bg-amber-100 text-amber-700 shrink-0">未渲染</span>}
                </div>
                <div className="text-[11px] text-ink-400 mt-0.5">
                  {d.nickname ?? '未知来源'} · {d.created_at}
                  {d.publish_error ? ` · ${d.publish_error}` : ''}
                </div>
              </Link>
              <StatusBadge status={d.status} />
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}