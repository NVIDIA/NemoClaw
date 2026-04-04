import { useFilterStore } from '@/store'
import { useUiStore } from '@/store'

export function PriceRangeSlider() {
  const { priceRange, setPriceRange } = useFilterStore()
  const { language } = useUiStore()
  const MAX = 200000

  const formatPrice = (v: number) => {
    if (v >= 100000) return `${(v / 10000).toFixed(0)}만원`
    if (v >= 10000) return `${(v / 10000).toFixed(1)}만`
    return `₩${v.toLocaleString()}`
  }

  const brandColor = 'var(--seed-color-bg-brand-solid)'
  const trackColor = 'var(--seed-color-bg-neutral-weak)'

  return (
    <div className="bg-bg-layer-default rounded-2xl p-4 shadow-sm border border-stroke-neutral-subtle">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-fg-neutral-muted">
          {language === 'ko' ? '💰 가격 범위' : '💰 Price Range'}
        </h3>
        <span className="text-xs text-fg-neutral-subtle">
          {formatPrice(priceRange[0])} ~ {formatPrice(priceRange[1])}
        </span>
      </div>
      <div className="space-y-3">
        <div>
          <div className="flex items-center justify-between text-xs text-fg-neutral-subtle mb-1">
            <span>{language === 'ko' ? '최소' : 'Min'}</span>
            <span className="font-medium text-fg-brand">{formatPrice(priceRange[0])}</span>
          </div>
          <input
            type="range"
            min={0}
            max={MAX}
            step={1000}
            value={priceRange[0]}
            onChange={(e) => {
              const val = Number(e.target.value)
              if (val < priceRange[1]) setPriceRange([val, priceRange[1]])
            }}
            className="w-full seed-range"
            style={{
              background: `linear-gradient(to right, ${trackColor} 0%, ${trackColor} ${(priceRange[0]/MAX)*100}%, ${brandColor} ${(priceRange[0]/MAX)*100}%, ${brandColor} 100%)`
            }}
          />
        </div>
        <div>
          <div className="flex items-center justify-between text-xs text-fg-neutral-subtle mb-1">
            <span>{language === 'ko' ? '최대' : 'Max'}</span>
            <span className="font-medium text-fg-brand">
              {priceRange[1] >= MAX ? (language === 'ko' ? '제한없음' : 'No limit') : formatPrice(priceRange[1])}
            </span>
          </div>
          <input
            type="range"
            min={0}
            max={MAX}
            step={1000}
            value={priceRange[1]}
            onChange={(e) => {
              const val = Number(e.target.value)
              if (val > priceRange[0]) setPriceRange([priceRange[0], val])
            }}
            className="w-full seed-range"
            style={{
              background: `linear-gradient(to right, ${brandColor} 0%, ${brandColor} ${(priceRange[1]/MAX)*100}%, ${trackColor} ${(priceRange[1]/MAX)*100}%, ${trackColor} 100%)`
            }}
          />
        </div>
      </div>
      <button
        onClick={() => setPriceRange([0, MAX])}
        className="mt-3 w-full text-xs text-fg-neutral-subtle hover:text-fg-neutral-muted transition-colors py-1"
      >
        {language === 'ko' ? '초기화' : 'Reset'}
      </button>
    </div>
  )
}
