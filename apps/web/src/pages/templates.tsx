import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import type { ParamDef } from '@cwe/shared'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { api } from '@/lib/api'

export interface TemplateDto {
  id: number
  name: string
  comfyJson: Record<string, any>
  params: ParamDef[]
  createdAt: string
}

export default function TemplatesPage() {
  const qc = useQueryClient()
  const [error, setError] = useState('')
  const { data: templates = [] } = useQuery({
    queryKey: ['templates'],
    queryFn: () => api<TemplateDto[]>('/templates'),
  })
  const del = useMutation({
    mutationFn: (id: number) => api(`/templates/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      setError('')
      qc.invalidateQueries({ queryKey: ['templates'] })
    },
    onError: (e: Error) => setError(e.message),
  })

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Templates</h1>
        <Button asChild>
          <Link to="/templates/new">导入 Workflow</Link>
        </Button>
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>名称</TableHead>
            <TableHead>参数</TableHead>
            <TableHead>创建时间</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {templates.map((t) => (
            <TableRow key={t.id}>
              <TableCell className="font-medium">{t.name}</TableCell>
              <TableCell className="space-x-1">
                {t.params.map((p) => (
                  <Badge key={p.key} variant="secondary">
                    {p.key}:{p.type}
                  </Badge>
                ))}
              </TableCell>
              <TableCell>{t.createdAt}</TableCell>
              <TableCell className="space-x-2 text-right">
                <Button asChild size="sm" variant="outline">
                  <Link to={`/batches/new?template=${t.id}`}>新建 Batch</Link>
                </Button>
                <Button size="sm" variant="ghost" onClick={() => del.mutate(t.id)}>
                  删除
                </Button>
              </TableCell>
            </TableRow>
          ))}
          {templates.length === 0 && (
            <TableRow>
              <TableCell colSpan={4} className="text-center text-muted-foreground">
                还没有模板——先从 ComfyUI 导出 API-format JSON 再导入
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  )
}
