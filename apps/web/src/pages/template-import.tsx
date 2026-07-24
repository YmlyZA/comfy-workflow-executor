import { useMutation } from '@tanstack/react-query'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { ParamDef, ParamType } from '@cwe/shared'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { api } from '@/lib/api'
import { guessType, parseNodeInputs, type NodeInputRow } from '@/lib/comfy-parse'

interface Selection {
  key: string
  type: ParamType
}

const rowId = (r: NodeInputRow) => `${r.nodeId}.${r.inputName}`

export default function TemplateImportPage() {
  const navigate = useNavigate()
  const [name, setName] = useState('')
  const [json, setJson] = useState<Record<string, any> | null>(null)
  const [rows, setRows] = useState<NodeInputRow[]>([])
  const [selected, setSelected] = useState<Record<string, Selection>>({})
  const [error, setError] = useState('')

  function onFile(file: File) {
    file.text().then((text) => {
      try {
        const parsed = JSON.parse(text) as Record<string, any>
        const inputs = parseNodeInputs(parsed)
        if (inputs.length === 0) {
          setError('未解析到任何节点输入——请确认导出的是 API-format JSON（设置里开启 Dev Mode 后用 "Save (API Format)")')
          return
        }
        setJson(parsed)
        setRows(inputs)
        setSelected({})
        setError('')
        if (!name) setName(file.name.replace(/\.json$/, ''))
      } catch {
        setError('JSON 解析失败')
      }
    })
  }

  const save = useMutation({
    mutationFn: () => {
      const params: ParamDef[] = rows
        .filter((r) => selected[rowId(r)])
        .map((r) => {
          const sel = selected[rowId(r)]!
          return {
            key: sel.key,
            label: sel.key,
            nodeId: r.nodeId,
            inputName: r.inputName,
            type: sel.type,
            default: r.value,
          }
        })
      return api('/templates', {
        method: 'POST',
        body: JSON.stringify({ name, comfyJson: json, params }),
      })
    },
    onSuccess: () => navigate('/templates'),
    onError: (e) => setError(e.message),
  })

  const chosenCount = Object.keys(selected).length
  const keys = rows.filter((r) => selected[rowId(r)]).map((r) => selected[rowId(r)]!.key)
  const hasDuplicateKeys = new Set(keys).size !== keys.length

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">导入 Workflow</h1>
      <div className="flex items-center gap-4">
        <Input type="file" accept=".json" className="w-72" onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])} />
        <Input placeholder="模板名称" className="w-72" value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
      {rows.length > 0 && (
        <>
          <p className="text-sm text-muted-foreground">
            勾选要作为批量参数的输入并命名（其余输入保持导出时的值）：
          </p>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10" />
                <TableHead>节点</TableHead>
                <TableHead>输入</TableHead>
                <TableHead>当前值</TableHead>
                <TableHead>参数 key</TableHead>
                <TableHead>类型</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => {
                const id = rowId(r)
                const sel = selected[id]
                return (
                  <TableRow key={id}>
                    <TableCell>
                      <input
                        type="checkbox"
                        checked={!!sel}
                        onChange={(e) => {
                          setSelected((prev) => {
                            const next = { ...prev }
                            if (e.target.checked) {
                              next[id] = { key: r.inputName, type: guessType(r) }
                            } else {
                              delete next[id]
                            }
                            return next
                          })
                        }}
                      />
                    </TableCell>
                    <TableCell>
                      {r.nodeId} · {r.classType}
                    </TableCell>
                    <TableCell>{r.inputName}</TableCell>
                    <TableCell className="max-w-64 truncate text-muted-foreground">
                      {String(r.value)}
                    </TableCell>
                    <TableCell>
                      {sel && (
                        <Input
                          className="h-8 w-36"
                          value={sel.key}
                          onChange={(e) =>
                            setSelected((prev) => ({ ...prev, [id]: { ...sel, key: e.target.value } }))
                          }
                        />
                      )}
                    </TableCell>
                    <TableCell>
                      {sel && (
                        <Select
                          value={sel.type}
                          onValueChange={(v) =>
                            setSelected((prev) => ({ ...prev, [id]: { ...sel, type: v as ParamType } }))
                          }
                        >
                          <SelectTrigger className="h-8 w-28">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {(['text', 'number', 'seed', 'image'] as const).map((t) => (
                              <SelectItem key={t} value={t}>
                                {t}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      )}
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
          {hasDuplicateKeys && <p className="text-sm text-destructive">参数 key 重复，请修改后再保存</p>}
          <Button disabled={!name || chosenCount === 0 || save.isPending || hasDuplicateKeys} onClick={() => save.mutate()}>
            保存模板（{chosenCount} 个参数）
          </Button>
        </>
      )}
    </div>
  )
}
