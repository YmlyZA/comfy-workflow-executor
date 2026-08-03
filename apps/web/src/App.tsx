import { Link, Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom'
import { MonitorIcon, MoonIcon, SunIcon } from 'lucide-react'
import { getToken } from '@/lib/api'
import { HostStatus } from '@/components/host-status'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Button } from '@/components/ui/button'
import { useTheme } from '@/components/theme-provider'
import BackupPage from '@/pages/backup'
import BatchDetailPage from '@/pages/batch-detail'
import BatchNewPage from '@/pages/batch-new'
import BatchesPage from '@/pages/batches'
import HostsPage from '@/pages/hosts'
import LoginPage from '@/pages/login'
import MaintenancePage from '@/pages/maintenance'
import PromptsPage from '@/pages/prompts'
import TemplateImportPage from '@/pages/template-import'
import TemplatesPage from '@/pages/templates'

function RequireToken() {
  const location = useLocation()
  if (!getToken()) return <Navigate to="/login" state={{ from: location }} replace />
  return (
    <div className="mx-auto max-w-6xl p-6">
      <nav className="mb-6 flex items-center gap-6 border-b pb-4">
        <span className="font-semibold">Comfy Workflow Executor</span>
        <Link to="/batches" className="text-sm hover:underline">
          Batches
        </Link>
        <Link to="/templates" className="text-sm hover:underline">
          Templates
        </Link>
        <Link to="/prompts" className="text-sm hover:underline">
          Prompt 库
        </Link>
        <Link to="/backup" className="text-sm hover:underline">
          数据备份
        </Link>
        <Link to="/hosts" className="text-sm hover:underline">
          GPU 主机
        </Link>
        <Link to="/maintenance" className="text-sm hover:underline">
          维护
        </Link>
        <ThemeToggle />
        <HostStatus />
      </nav>
      <Outlet />
    </div>
  )
}

const THEME_ITEMS = [
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
  { value: 'system', label: '跟随系统' },
] as const

function ThemeToggle() {
  const { theme, resolved, setTheme } = useTheme()
  const Icon = theme === 'system' ? MonitorIcon : resolved === 'dark' ? MoonIcon : SunIcon
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="ml-auto size-8" title="主题">
          <Icon className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {THEME_ITEMS.map((it) => (
          <DropdownMenuCheckboxItem
            key={it.value}
            checked={theme === it.value}
            onCheckedChange={() => setTheme(it.value)}
          >
            {it.label}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<RequireToken />}>
        <Route path="/" element={<Navigate to="/batches" replace />} />
        <Route path="/templates" element={<TemplatesPage />} />
        <Route path="/templates/new" element={<TemplateImportPage />} />
        <Route path="/prompts" element={<PromptsPage />} />
        <Route path="/backup" element={<BackupPage />} />
        <Route path="/hosts" element={<HostsPage />} />
        <Route path="/batches" element={<BatchesPage />} />
        <Route path="/batches/new" element={<BatchNewPage />} />
        <Route path="/batches/:id" element={<BatchDetailPage />} />
        <Route path="/maintenance" element={<MaintenancePage />} />
      </Route>
    </Routes>
  )
}
