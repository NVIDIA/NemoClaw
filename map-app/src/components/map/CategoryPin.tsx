import L from 'leaflet'
import { CATEGORY_META } from '@/types'
import type { PriceCategory } from '@/types'

// Create custom Leaflet DivIcon for each category
export function createCategoryIcon(
  category: PriceCategory,
  rank?: 1 | 2 | 3,
): L.DivIcon {
  const meta = CATEGORY_META[category]

  const rankBadge =
    rank === 1
      ? '<div class="absolute -top-2 -right-2 w-5 h-5 bg-yellow-400 rounded-full flex items-center justify-center text-xs font-bold text-yellow-900 shadow-md z-10">👑</div>'
      : rank === 2
      ? '<div class="absolute -top-2 -right-2 w-5 h-5 bg-slate-300 rounded-full flex items-center justify-center text-xs font-bold text-slate-700 shadow-md z-10">2</div>'
      : rank === 3
      ? '<div class="absolute -top-2 -right-2 w-5 h-5 bg-amber-600 rounded-full flex items-center justify-center text-xs font-bold text-white shadow-md z-10">3</div>'
      : ''

  const html = `
    <div class="relative marker-pin" style="width:40px;height:48px;">
      ${rankBadge}
      <div style="
        width:40px;height:40px;
        background:${meta.color};
        border-radius:50% 50% 50% 0;
        transform:rotate(-45deg);
        box-shadow:0 3px 8px rgba(0,0,0,0.35);
        border:2.5px solid white;
        display:flex;align-items:center;justify-content:center;
      ">
        <span style="
          transform:rotate(45deg);
          font-size:18px;
          line-height:1;
          filter:drop-shadow(0 1px 1px rgba(0,0,0,0.3));
        ">${meta.emoji}</span>
      </div>
    </div>
  `

  return L.divIcon({
    html,
    className: '',
    iconSize: [40, 48],
    iconAnchor: [20, 48],
    popupAnchor: [0, -48],
  })
}
