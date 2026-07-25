import { useEffect, useState } from 'react'

/** 值防抖:delayMs 内无新值才更新返回值(手填文件名时避免逐键触发探测) */
export function useDebouncedValue<T>(value: T, delayMs = 500): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delayMs)
    return () => clearTimeout(t)
  }, [value, delayMs])
  return debounced
}
