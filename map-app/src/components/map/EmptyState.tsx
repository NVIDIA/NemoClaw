import { useFilterStore } from '@/store'
import { useUiStore } from '@/store'

export function EmptyState() {
  const { resetFilters } = useFilterStore()
  const { language } = useUiStore()

  return (
    <div
      style={{
        position: 'absolute', inset: 0, display: 'flex',
        alignItems: 'center', justifyContent: 'center',
        zIndex: 900, pointerEvents: 'none',
      }}
    >
      <div style={{
        background: '#fff', borderRadius: '16px',
        boxShadow: '0 8px 32px rgba(0,0,0,0.18)',
        padding: '28px 32px', textAlign: 'center',
        maxWidth: '280px', pointerEvents: 'auto',
      }}>
        <div style={{ fontSize: '40px', marginBottom: '12px' }}>🗺️</div>
        <h2 style={{ fontSize: '16px', fontWeight: 700, color: '#1e293b', margin: '0 0 6px' }}>
          {language === 'ko' ? '검색 결과 없음' : 'No results found'}
        </h2>
        <p style={{ fontSize: '13px', color: '#64748b', margin: '0 0 16px' }}>
          {language === 'ko'
            ? '필터 조건을 변경하거나 초기화해 보세요'
            : 'Try adjusting or resetting your filters'}
        </p>
        <button
          onClick={resetFilters}
          style={{
            width: '100%', padding: '10px 0',
            background: '#fbbf24', color: '#000',
            border: 'none', borderRadius: '10px',
            fontSize: '14px', fontWeight: 600, cursor: 'pointer',
          }}
        >
          {language === 'ko' ? '필터 초기화' : 'Reset Filters'}
        </button>
      </div>
    </div>
  )
}
