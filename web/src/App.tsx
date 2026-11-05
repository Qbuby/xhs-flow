import { useEffect, useState } from 'react';
import { NavLink, Route, Routes } from 'react-router-dom';
import { api, type Source } from './api';
import { useUi } from './store';
import { Dashboard } from './pages/Dashboard';
import { Sources } from './pages/Sources';
import { Studio } from './pages/Studio';
import { SourceDetail } from './pages/SourceDetail';
import { BrandKit } from './pages/BrandKit';
import { Drafts } from './pages/Drafts';
import { DraftDetail } from './pages/DraftDetail';
import { Publish } from './pages/Publish';
import { Settings } from './pages/Settings';

const NAV = [
  { to: '/', label: '总览', end: true },
  { to: '/sources', label: '语料库' },
  // 「模板调整」放在语料库后面：它是按语料源存的功能，跟着语料库走最自然
  { to: null, label: '模板调整', end: false },
  { to: '/studio', label: '创作台' },
  { to: '/drafts', label: '草稿审核' },
  { to: '/publish', label: '发布' },
  { to: '/settings', label: '设置' },
];

const navClass = (active: boolean) =>
  `block px-3 py-2 rounded-lg text-sm mb-0.5 transition-colors ${
    active ? 'bg-accent-500/10 text-accent-600 font-medium' : 'text-ink-600 hover:bg-ink-100'
  }`;

/**
 * 侧栏的「模板调整」入口。
 *
 * 品牌套件是**按语料源**存的（data/brand-kits/<sourceId>/），所以这个顶层
 * 入口必须先定下「是哪个源」。规则：优先最近浏览过的源；还没浏览过就取
 * 语料库里的第一个。都拿不到时退回语料库列表，让用户自己挑一个。
 */
function BrandKitNav() {
  const lastSourceId = useUi((s) => s.lastSourceId);
  const [firstId, setFirstId] = useState<number | null>(null);

  useEffect(() => {
    if (lastSourceId) return;
    let alive = true;
    void api
      .get<Source[]>('/api/sources')
      .then((list) => {
        if (alive && list.length > 0) setFirstId(list[0].id);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [lastSourceId]);

  const target = lastSourceId ?? firstId;
  if (target === null) {
    return (
      <NavLink to="/sources" className={({ isActive }) => navClass(isActive)}>
        模板调整
      </NavLink>
    );
  }
  return (
    <NavLink
      to={`/sources/${target}/brand-kit`}
      end
      className={({ isActive }) => navClass(isActive)}
    >
      模板调整
    </NavLink>
  );
}

/** 全局提示宿主。之前只挂在总览页，导致从别的页面调用 toast() 完全没有反馈。 */
function Toasts() {
  const toasts = useUi((s) => s.toasts);
  if (toasts.length === 0) return null;
  return (
    <div className="fixed top-5 right-8 z-50 space-y-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`px-4 py-2.5 rounded-lg text-sm shadow-lg text-white max-w-md ${
            t.kind === 'ok' ? 'bg-ink-900' : 'bg-rose-600'
          }`}
        >
          {t.text}
        </div>
      ))}
    </div>
  );
}

export function App() {
  return (
    <div className="flex h-full">
      <Toasts />
      <aside className="w-56 shrink-0 bg-white border-r border-ink-200 flex flex-col">
        <div className="px-5 py-5 border-b border-ink-100">
          <div className="font-semibold text-ink-900">xhsflow</div>
          <div className="text-[11px] text-ink-400 mt-0.5">小红书内容工厂</div>
        </div>
        <nav className="p-3 flex-1">
          {NAV.map((n) =>
            n.to === null ? (
              <BrandKitNav key="brand-kit" />
            ) : (
              <NavLink
                key={n.to}
                to={n.to}
                end={n.end}
                className={({ isActive }) => navClass(isActive)}
              >
                {n.label}
              </NavLink>
            ),
          )}
        </nav>
        <div className="px-5 py-4 border-t border-ink-100 text-[11px] text-ink-400">
          本地常驻服务
        </div>
      </aside>

      <main className="flex-1 overflow-y-auto">
        <div className="max-w-6xl mx-auto px-8 py-7">
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/sources" element={<Sources />} />
            <Route path="/studio" element={<Studio />} />
            <Route path="/sources/:id" element={<SourceDetail />} />
            <Route path="/sources/:id/brand-kit" element={<BrandKit />} />
            <Route path="/drafts" element={<Drafts />} />
            <Route path="/drafts/:id" element={<DraftDetail />} />
            <Route path="/publish" element={<Publish />} />
            <Route path="/settings" element={<Settings />} />
          </Routes>
        </div>
      </main>
    </div>
  );
}