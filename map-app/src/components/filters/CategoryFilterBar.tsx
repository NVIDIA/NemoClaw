import { useFilterStore } from '@/store'
import { CATEGORY_META } from '@/types'
import type { PriceCategory } from '@/types'
import { useUiStore } from '@/store'

const CATEGORIES: PriceCategory[] = [
  'exchange', 'fuel', 'restaurant', 'cafe', 'convenience',
  'jjimjilbang', 'karaoke', 'market', 'attraction', 'extra',
]

export function CategoryFilterBar() {
  const { activeCategories, toggleCategory, clearCategories } = useFilterStore()
  const { language } = useUiStore()

  return (
    <div className="flex items-center gap-2 overflow-x-auto py-2 px-3 scrollbar-hide">
      {/* All button */}
      <button
        onClick={clearCategories}
        className={`flex-shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-medium
          border transition-all duration-150
          ${activeCategories.length === 0
            ? 'bg-bg-neutral-inverted text-fg-neutral-inverted border-transparent shadow-sm'
            : 'bg-bg-layer-default text-fg-neutral-muted border-stroke-neutral-subtle hover:border-stroke-neutral-muted'
          }`}
      >
        🌍 {language === 'ko' ? '전체' : 'All'}
      </button>

      {CATEGORIES.map((cat) => {
        const meta = CATEGORY_META[cat]
        const isActive = activeCategories.includes(cat)
        return (
          <button
            key={cat}
            onClick={() => toggleCategory(cat)}
            className={`flex-shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-medium
              border transition-all duration-150
              ${isActive
                ? 'text-fg-neutral-inverted border-transparent shadow-sm'
                : 'bg-bg-layer-default text-fg-neutral-muted border-stroke-neutral-subtle hover:border-stroke-neutral-muted'
              }`}
            style={isActive ? { backgroundColor: meta.color, borderColor: meta.color } : {}}
          >
            <span>{meta.emoji}</span>
            <span>{language === 'ko' ? meta.label : meta.labelEn}</span>
          </button>
        )
      })}
    </div>
  )
}
