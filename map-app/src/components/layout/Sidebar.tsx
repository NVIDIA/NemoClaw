import { PriceRangeSlider } from '@/components/filters/PriceRangeSlider'
import { useUiStore } from '@/store'
import { useFilterStore } from '@/store'
import { useAllLocations } from '@/hooks/useAllLocations'
import { CATEGORY_META } from '@/types'
import type { PriceCategory } from '@/types'

const CATEGORIES: PriceCategory[] = [
  'exchange', 'fuel', 'restaurant', 'cafe', 'convenience',
  'jjimjilbang', 'karaoke', 'market', 'attraction', 'extra',
]

export function Sidebar() {
  const { language } = useUiStore()
  const { activeCategories, toggleCategory, clearCategories } = useFilterStore()
  const all = useAllLocations()

  const countByCategory = CATEGORIES.reduce<Record<string, number>>((acc, cat) => {
    acc[cat] = all.filter((l) => l.category === cat).length
    return acc
  }, {})

  return (
    <aside className="hidden lg:flex flex-col w-64 xl:w-72 bg-white border-r border-slate-100 overflow-y-auto flex-shrink-0">
      <div className="p-4 space-y-4">
        {/* Category filter */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-sm font-semibold text-slate-700">
              {language === 'ko' ? '카테고리' : 'Categories'}
            </h3>
            {activeCategories.length > 0 && (
              <button
                onClick={clearCategories}
                className="text-xs text-blue-600 hover:text-blue-800 font-medium"
              >
                {language === 'ko' ? '전체보기' : 'All'}
              </button>
            )}
          </div>
          <div className="space-y-1">
            {CATEGORIES.map((cat) => {
              const meta = CATEGORY_META[cat]
              const isActive = activeCategories.includes(cat)
              const count = countByCategory[cat] ?? 0
              return (
                <button
                  key={cat}
                  onClick={() => toggleCategory(cat)}
                  className={`w-full flex items-center justify-between px-3 py-2 rounded-xl transition-all text-sm
                    ${isActive
                      ? 'text-white shadow-sm'
                      : 'text-slate-600 hover:bg-slate-50'
                    }`}
                  style={isActive ? { backgroundColor: meta.color } : {}}
                >
                  <div className="flex items-center gap-2.5">
                    <span className="text-lg">{meta.emoji}</span>
                    <span className="font-medium">{language === 'ko' ? meta.label : meta.labelEn}</span>
                  </div>
                  <span className={`text-xs font-semibold px-1.5 py-0.5 rounded-full
                    ${isActive ? 'bg-white/20 text-white' : 'bg-slate-100 text-slate-500'}`}>
                    {count}
                  </span>
                </button>
              )
            })}
          </div>
        </div>

        {/* Price range */}
        <PriceRangeSlider />

        {/* Stats */}
        <div className="bg-gradient-to-br from-slate-800 to-slate-900 rounded-2xl p-4 text-white">
          <div className="text-xs font-semibold text-slate-400 mb-3 uppercase tracking-wide">
            {language === 'ko' ? '데이터 현황' : 'Data Overview'}
          </div>
          <div className="grid grid-cols-2 gap-2">
            {[
              { emoji: '💱', value: '8', label: language === 'ko' ? '환전소' : 'Exchange' },
              { emoji: '⛽', value: '12', label: language === 'ko' ? '주유소' : 'Fuel' },
              { emoji: '🍜', value: '14', label: language === 'ko' ? '식당' : 'Restaurants' },
              { emoji: '☕', value: '8', label: language === 'ko' ? '카페' : 'Cafes' },
            ].map((stat) => (
              <div key={stat.label} className="bg-white/10 rounded-xl p-2 text-center">
                <div className="text-lg">{stat.emoji}</div>
                <div className="text-base font-bold">{stat.value}</div>
                <div className="text-[10px] text-slate-400">{stat.label}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </aside>
  )
}
