import type { Restaurant } from '@/types'
import { useUiStore } from '@/store'
import { useFilterStore } from '@/store'
import { NATIONALITY_META } from '@/types'

const SPICY_LABELS = ['', '🌶', '🌶🌶', '🌶🌶🌶']

interface Props { location: Restaurant }

export function RestaurantDetail({ location }: Props) {
  const { language } = useUiStore()
  const { nationality } = useFilterStore()

  // Highlight menu items relevant to selected nationality
  const highlightedItems = location.menuItems.filter((item) => {
    if (nationality === 'vegan' || nationality === 'indian') return item.isVegetarian
    if (nationality === 'halal') return item.isHalal
    return true
  })

  const displayItems = highlightedItems.length > 0 ? highlightedItems : location.menuItems

  return (
    <div className="space-y-4">
      {/* Tags */}
      <div className="flex flex-wrap gap-1.5">
        <span className="px-2 py-0.5 bg-orange-100 text-orange-700 text-xs font-semibold rounded-full">
          🍽️ {language === 'ko' ? location.cuisineType : location.cuisineTypeEn}
        </span>
        {location.isHalal && (
          <span className="px-2 py-0.5 bg-green-100 text-green-700 text-xs font-semibold rounded-full">
            🕌 Halal
          </span>
        )}
        {location.isVegetarianFriendly && (
          <span className="px-2 py-0.5 bg-emerald-100 text-emerald-700 text-xs font-semibold rounded-full">
            🌱 {language === 'ko' ? '채식 가능' : 'Vegetarian OK'}
          </span>
        )}
        {location.hasEnglishMenu && (
          <span className="px-2 py-0.5 bg-blue-100 text-blue-700 text-xs font-semibold rounded-full">
            🇺🇸 {language === 'ko' ? '영문메뉴' : 'Eng Menu'}
          </span>
        )}
        {location.hasChineseMenu && (
          <span className="px-2 py-0.5 bg-red-100 text-red-700 text-xs font-semibold rounded-full">
            🇨🇳 {language === 'ko' ? '중문메뉴' : 'CN Menu'}
          </span>
        )}
        {location.hasJapaneseMenu && (
          <span className="px-2 py-0.5 bg-pink-100 text-pink-700 text-xs font-semibold rounded-full">
            🇯🇵 {language === 'ko' ? '일문메뉴' : 'JP Menu'}
          </span>
        )}
      </div>

      {/* Nationality match indicator */}
      {nationality !== 'all' && (
        <div className="flex items-center gap-2 bg-blue-50 rounded-xl px-3 py-2">
          <span className="text-lg">{NATIONALITY_META[nationality].flag}</span>
          <span className="text-xs text-blue-700 font-medium">
            {language === 'ko'
              ? `${NATIONALITY_META[nationality].label} 취향 메뉴를 강조했어요`
              : `Showing items matched for ${NATIONALITY_META[nationality].labelEn} taste`
            }
          </span>
        </div>
      )}

      {/* Average price */}
      <div className="flex items-center justify-between bg-slate-50 rounded-xl px-4 py-3">
        <span className="text-sm text-slate-600">
          {language === 'ko' ? '1인 평균' : 'Avg per person'}
        </span>
        <span className="text-xl font-bold text-emerald-700">
          ₩{location.pricePerPerson.toLocaleString()}
        </span>
      </div>

      {/* Menu items */}
      <div>
        <h4 className="text-sm font-semibold text-slate-600 mb-2">
          {language === 'ko' ? '메뉴' : 'Menu'}
        </h4>
        <div className="space-y-2">
          {displayItems.map((item, i) => (
            <div key={i} className="flex items-center justify-between py-2 border-b border-slate-50 last:border-0">
              <div className="flex flex-col">
                <div className="flex items-center gap-1.5">
                  <span className="font-medium text-slate-800">
                    {language === 'ko' ? item.name : item.nameEn}
                  </span>
                  {item.spicyLevel !== undefined && item.spicyLevel > 0 && (
                    <span className="text-xs">{SPICY_LABELS[item.spicyLevel]}</span>
                  )}
                  {item.isVegetarian && <span className="text-xs">🌱</span>}
                  {item.isHalal && <span className="text-xs">🕌</span>}
                </div>
                {language === 'ko' && item.nameEn && (
                  <span className="text-xs text-slate-400">{item.nameEn}</span>
                )}
              </div>
              <span className="font-semibold text-slate-700">₩{item.price.toLocaleString()}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Nationality tags */}
      <div>
        <h4 className="text-sm font-semibold text-slate-600 mb-1.5">
          {language === 'ko' ? '추천 방문객' : 'Recommended for'}
        </h4>
        <div className="flex flex-wrap gap-1.5">
          {location.nationalityTags.map((nat) => (
            <span key={nat} className="px-2 py-0.5 bg-slate-100 text-slate-600 text-xs rounded-full">
              {NATIONALITY_META[nat].flag} {language === 'ko' ? NATIONALITY_META[nat].label : NATIONALITY_META[nat].labelEn}
            </span>
          ))}
        </div>
      </div>
    </div>
  )
}
