import { Link, Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom'
import { getToken } from '@/lib/api'
import BatchDetailPage from '@/pages/batch-detail'
import BatchNewPage from '@/pages/batch-new'
import BatchesPage from '@/pages/batches'
import LoginPage from '@/pages/login'
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
        <Route path="/prompts" element={<PromptsPage />} />
        <Route path="/batches" element={<BatchesPage />} />
        <Route path="/batches/new" element={<BatchNewPage />} />
        <Route path="/batches/:id" element={<BatchDetailPage />} />
      </Route>
    </Routes>
  )
}
