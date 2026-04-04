interface Props {
  price: number
  unit?: string
  highlight?: boolean
  className?: string
}

export function PriceBadge({ price, unit = '₩', highlight = false, className = '' }: Props) {
  const formatted = price.toLocaleString('ko-KR')
  return (
    <span
      className={`inline-flex items-center gap-0.5 px-2 py-0.5 rounded-full text-sm font-semibold
        ${highlight
          ? 'bg-yellow-400 text-yellow-900'
          : 'bg-slate-100 text-slate-700'
        } ${className}`}
    >
      {highlight && <span>👑</span>}
      {unit}{formatted}
    </span>
  )
}
