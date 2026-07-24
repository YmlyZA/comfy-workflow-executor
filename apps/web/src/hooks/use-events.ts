import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { getToken } from '@/lib/api'

export interface JobProgress {
  value: number
  max: number
}

export function useEvents(): Record<number, JobProgress> {
  const qc = useQueryClient()
  const [progress, setProgress] = useState<Record<number, JobProgress>>({})

  useEffect(() => {
    const es = new EventSource(`/api/events?token=${encodeURIComponent(getToken())}`)
    const invalidate = () => void qc.invalidateQueries({ queryKey: ['batches'] })
    es.addEventListener('job-updated', invalidate)
    es.addEventListener('batch-updated', invalidate)
    es.addEventListener('progress', (e) => {
      const d = JSON.parse((e as MessageEvent).data) as { jobId: number; value: number; max: number }
      setProgress((prev) => ({ ...prev, [d.jobId]: { value: d.value, max: d.max } }))
    })
    return () => es.close()
  }, [qc])

  return progress
}
