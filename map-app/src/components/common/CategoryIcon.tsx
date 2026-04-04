import { CATEGORY_META } from '@/types'
import type { PriceCategory } from '@/types'

interface Props {
  category: PriceCategory
  size?: 'sm' | 'md' | 'lg'
  className?: string
}

export function CategoryIcon({ category, size = 'md', className = '' }: Props) {
  const meta = CATEGORY_META[category]
  const sizeClass = size === 'sm' ? 'text-lg' : size === 'lg' ? 'text-3xl' : 'text-xl'
  return (
    <span className={`${sizeClass} ${className}`} role="img" aria-label={meta.labelEn}>
      {meta.emoji}
    </span>
  )
}
