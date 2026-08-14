import { Link, NavLink, useLocation } from 'react-router-dom'
import { EllipsisIcon, ImagesIcon, LibraryIcon, WorkflowIcon } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'

const TABS = [
  { to: '/batches', label: 'Batches', Icon: ImagesIcon },
  { to: '/templates', label: 'Templates', Icon: WorkflowIcon },
  { to: '/prompts', label: 'Prompt 库', Icon: LibraryIcon },
] as const

const MORE = [
  { to: '/backup', label: '数据备份' },
  { to: '/hosts', label: 'GPU 主机' },
  { to: '/maintenance', label: '维护' },
] as const

const tabCls = (active: boolean) =>
  cn(
    'flex flex-col items-center gap-0.5 py-2 text-xs',
    active ? 'text-primary' : 'text-muted-foreground',
  )

/** 小屏底部导航:三个主入口 + 「更多」上弹菜单;pb-safe 避开 iPhone Home Indicator */
export function MobileTabBar() {
  const { pathname } = useLocation()
  const moreActive = MORE.some((m) => pathname.startsWith(m.to))
  return (
    <nav className="fixed inset-x-0 bottom-0 z-40 border-t bg-background pb-[env(safe-area-inset-bottom)] md:hidden">
      <div className="grid grid-cols-4">
        {TABS.map(({ to, label, Icon }) => (
          <NavLink key={to} to={to} className={({ isActive }) => tabCls(isActive)}>
            <Icon className="size-5" />
            {label}
          </NavLink>
        ))}
        <DropdownMenu>
          <DropdownMenuTrigger className={tabCls(moreActive)}>
            <EllipsisIcon className="size-5" />
            更多
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="end">
            {MORE.map((m) => (
              <DropdownMenuItem key={m.to} asChild>
                <Link to={m.to} className={pathname.startsWith(m.to) ? 'text-primary' : undefined}>
                  {m.label}
                </Link>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </nav>
  )
}
