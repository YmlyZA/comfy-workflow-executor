import { Navigate, NavLink, Outlet, Route, Routes, useLocation } from 'react-router-dom'
import { MonitorIcon, MoonIcon, SunIcon } from 'lucide-react'
import { Toaster } from 'sonner'
import { getToken } from '@/lib/api'
import { HostStatus } from '@/components/host-status'
import { MobileTabBar } from '@/components/mobile-tab-bar'
import { cn } from '@/lib/utils'
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

const navCls = ({ isActive }: { isActive: boolean }) =>
  cn(
    'relative pb-0.5 text-sm transition-colors duration-150',
    isActive
      ? 'font-medium text-primary after:absolute after:inset-x-0 after:-bottom-[3px] after:h-0.5 after:rounded-full after:bg-primary'
      : 'text-muted-foreground hover:text-foreground',
  )

function RequireToken() {
  const location = useLocation()
  const { resolved } = useTheme()
  if (!getToken()) return <Navigate to="/login" state={{ from: location }} replace />
  return (
    <div className="mx-auto max-w-6xl p-4 pb-[calc(5rem_+_env(safe-area-inset-bottom))] md:p-6 md:pb-6">
      <nav className="mb-4 flex items-center gap-3 border-b pb-3 md:mb-6 md:gap-6 md:pb-4">
        <span className="min-w-0 truncate font-semibold">Comfy Workflow Executor</span>
        <div className="hidden items-center gap-6 md:flex">
          <NavLink to="/batches" className={navCls}>
            Batches
          </NavLink>
          <NavLink to="/templates" className={navCls}>
            Templates
          </NavLink>
          <NavLink to="/prompts" className={navCls}>
            Prompt 库
          </NavLink>
          <NavLink to="/backup" className={navCls}>
            数据备份
          </NavLink>
          <NavLink to="/hosts" className={navCls}>
            GPU 主机
          </NavLink>
          <NavLink to="/maintenance" className={navCls}>
            维护
          </NavLink>
        </div>
        <ThemeToggle />
        <HostStatus />
      </nav>
      <Outlet />
      <MobileTabBar />
      <Toaster richColors position="bottom-right" theme={resolved} mobileOffset={{ bottom: 80 }} />
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
