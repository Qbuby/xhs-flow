import { NavLink, Route, Routes } from 'react-router-dom';
import { Dashboard } from './pages/Dashboard';
import { Sources } from './pages/Sources';
import { SourceDetail } from './pages/SourceDetail';
import { Drafts } from './pages/Drafts';
import { DraftDetail } from './pages/DraftDetail';
import { Publish } from './pages/Publish';
import { Settings } from './pages/Settings';

const NAV = [
  { to: '/', label: '总览', end: true },
  { to: '/sources', label: '语料库' },
  { to: '/drafts', label: '草稿审核' },
  { to: '/publish', label: '发布' },
  { to: '/settings', label: '设置' },
];

export function App() {
  return (
    <div className="flex h-full">
      <aside className="w-56 shrink-0 bg-white border-r border-ink-200 flex flex-col">
        <div className="px-5 py-5 border-b border-ink-100">
          <div className="font-semibold text-ink-900">xhsflow</div>
          <div className="text-[11px] text-ink-400 mt-0.5">小红书内容工厂</div>
        </div>
        <nav className="p-3 flex-1">
          {NAV.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.end}
              className={({ isActive }) =>
                `block px-3 py-2 rounded-lg text-sm mb-0.5 transition-colors ${
                  isActive
                    ? 'bg-accent-500/10 text-accent-600 font-medium'
                    : 'text-ink-600 hover:bg-ink-100'
                }`
              }
            >
              {n.label}
            </NavLink>
          ))}
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
            <Route path="/sources/:id" element={<SourceDetail />} />
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