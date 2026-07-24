import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { setToken } from '@/lib/api'

export default function LoginPage() {
  const [value, setValue] = useState('')
  const [error, setError] = useState('')
  const navigate = useNavigate()

  async function submit() {
    const res = await fetch('/api/templates', {
      headers: { Authorization: `Bearer ${value}` },
    })
    if (!res.ok) {
      setError('Token 无效')
      return
    }
    setToken(value)
    navigate('/')
  }

  return (
    <div className="flex min-h-screen items-center justify-center">
      <Card className="w-96">
        <CardHeader>
          <CardTitle>Comfy Workflow Executor</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <Input
            type="password"
            placeholder="Access Token"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
          />
          {error && <p className="text-sm text-destructive">{error}</p>}
          <Button className="w-full" onClick={submit}>
            进入
          </Button>
        </CardContent>
      </Card>
    </div>
  )
}
