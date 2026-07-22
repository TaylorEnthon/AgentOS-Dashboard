import { Routes, Route, NavLink, Navigate } from 'react-router-dom';
import { OverviewPage } from './pages/Overview';
import { AgentsPage } from './pages/Agents';
import { AgentDetailPage } from './pages/AgentDetail';
import { ProjectViewPage } from './pages/ProjectView';
import { SettingsPage } from './pages/Settings';
import { DataHealthPage } from './pages/DataHealth';
import { TimelinePage } from './pages/Timeline';
import { cn } from './lib/format';

const NAV = [
  { to: '/', label: 'Overview', end: true },
  { to: '/timeline', label: 'Timeline' },
  { to: '/agents', label: 'Agents' },
  { to: '/projects', label: 'Projects' },
  { to: '/data-health', label: 'Data Health' },
  { to: '/settings', label: 'Settings' },
];

export function App() {
  return (
    <div className="flex h-full">
      <aside className="hidden w-56 shrink-0 border-r border-border bg-muted/30 p-4 sm:block">
        <div className="mb-6 flex items-center gap-2">
          <div className="grid h-8 w-8 place-items-center rounded-md bg-primary text-primary-foreground font-bold">A</div>
          <div>
            <div className="font-semibold leading-tight">AgentOS</div>
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Dashboard v0.6</div>
          </div>
        </div>
        <nav className="flex flex-col gap-1">
          {NAV.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.end}
              className={({ isActive }) => cn(
                'rounded-md px-3 py-1.5 text-sm transition-colors',
                isActive
                  ? 'bg-background text-foreground shadow-sm font-medium'
                  : 'text-muted-foreground hover:bg-background/60 hover:text-foreground',
              )}
            >
              {n.label}
            </NavLink>
          ))}
        </nav>
        <div className="mt-8 rounded-md border border-border bg-background p-3 text-xs text-muted-foreground">
          Live SSE stream + 60s polling fallback. Click <strong>Refresh</strong> on Overview to scan now.
        </div>
      </aside>

      <main className="min-w-0 flex-1 overflow-y-auto p-6 scrollbar-thin">
        <Routes>
          <Route path="/" element={<OverviewPage />} />
          <Route path="/timeline" element={<TimelinePage />} />
          <Route path="/agents" element={<AgentsPage />} />
          <Route path="/agents/:id" element={<AgentDetailPage />} />
          <Route path="/projects" element={<ProjectViewPage />} />
          <Route path="/data-health" element={<DataHealthPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}