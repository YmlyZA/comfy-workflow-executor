import { Link, Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom'
import { getToken } from '@/lib/api'
import LoginPage from '@/pages/login'
import TemplatesPage from '@/pages/templates'
import TemplateImportPage from '@/pages/template-import'

function Placeholder({ name }: { name: string }) {
  return <div className="text-muted-foreground">{name} — Task 11-13 实现</div>
}

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
      </nav>
      <Outlet />
    </div>
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
        <Route path="/batches" element={<Placeholder name="Batches" />} />
        <Route path="/batches/new" element={<Placeholder name="New Batch" />} />
        <Route path="/batches/:id" element={<Placeholder name="Batch Detail" />} />
      </Route>
    </Routes>
  )
}
