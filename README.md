# 💰 최저가 지도 (Lowest Price Map)

> 서울 관광객을 위한 **인터랙티브 최저가 지도** — 환전소·주유소·맛집·카페·편의점·찜질방·노래방·전통시장·관광명소를 한 눈에.

[![React](https://img.shields.io/badge/React-18-61dafb?logo=react)](https://react.dev)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178c6?logo=typescript)](https://www.typescriptlang.org)
[![Vite](https://img.shields.io/badge/Vite-5-646cff?logo=vite)](https://vitejs.dev)
[![Leaflet](https://img.shields.io/badge/Leaflet-1.9-199900?logo=leaflet)](https://leafletjs.com)
[![Tailwind CSS](https://img.shields.io/badge/Tailwind-3-06b6d4?logo=tailwindcss)](https://tailwindcss.com)

---

## 스크린샷

| 지도 메인 | 상세 패널 | 사이드바 필터 |
|-----------|-----------|---------------|
| 카테고리별 컬러 핀 + 가격 툴팁 | 즐겨찾기 · 카카오맵 링크 | 최저가 토글 · 국적 필터 |

---

## 주요 기능

### 🗺️ 지도 & 핀
- **10개 카테고리** 컬러 다이아몬드 핀 (카테고리별 고유 색상 + 이모지)
- **👑 최저가 순위** — 카테고리 내 1·2·3위 핀에 금·은·동 배지
- **선택된 핀 강조** — 클릭 시 scale 1.25 + 흰색 테두리 링
- **툴팁** — 호버 시 이름 + 핵심 가격 정보
- **접히는 범례** (좌측 하단) — 카테고리 색상/이모지 설명

### 🔍 검색 & 필터
- **실시간 검색** — 이름·영문명·주소 (TopBar 🔍 버튼, Escape로 닫기)
- **카테고리 필터** — 10개 카테고리 다중 선택
- **국적 필터** — 한식 / 일식 / 중식 / 서양식 / 인도식 / 할랄 / 비건
- **가격 범위 슬라이더** — 최소~최대 가격 설정
- **최저가만 보기** — 카테고리별 1개 최저가 핀만 표시
- **필터 영속성** — 새로고침 후에도 localStorage에서 복원

### ❤️ 즐겨찾기
- 상세 패널에서 ❤️ 버튼으로 북마크
- Sidebar 즐겨찾기 섹션에서 모아보기
- localStorage 기반 영구 저장

### 📍 내 위치
- 브라우저 Geolocation API → 현재 위치로 지도 flyTo
- 오른쪽 상단 📍 버튼 (Leaflet 네이티브 컨트롤)

### 📱 상세 패널
- 카테고리별 맞춤 정보 (가격표 · 메뉴 · 환율 · 편의시설 등)
- 카카오맵 / Google Maps 딥링크 버튼
- 패널 열릴 때 스크롤 자동 초기화

### 🌐 다국어
- 한국어 / English 토글 (localStorage 저장)

### 🌑 결과 없음 처리
- 핀 0개일 때 오버레이 안내 + 필터 초기화 버튼

---

## 데이터 (151개 장소)

| 카테고리 | 수 | 주요 정보 |
|---|---|---|
| 💱 사설환전소 | 15 | 통화별 매입/판매 환율, 수수료 여부 |
| ⛽ 주유/충전소 | 22 | 휘발유·경유·LPG·전기·수소 가격 |
| 🍜 식당 | 28 | 1인 가격, 국적 태그 (할랄·비건 포함) |
| ☕ 카페 | 18 | 아메리카노 가격, WiFi·야외석 여부 |
| 🏪 편의점 | 12 | 브랜드, 평균 단가, ATM·24시 여부 |
| 🛁 찜질방 | 10 | 입장료, 숙박료, 편의시설 목록 |
| 🎤 노래방 | 10 | 룸 크기별 시간당 요금, 할인 시간대 |
| 🏮 전통시장 | 8 | 인기 메뉴·상품별 가격 |
| 🏛️ 관광명소 | 12 | 입장권 종류별 가격, 무료 입장 조건 |
| ✨ 기타 | 16 | 포장마차·PC방·게스트하우스·빨래방 등 |

---

## 기술 스택

```
Frontend   React 18 + TypeScript 5 + Vite 5
지도       react-leaflet 4.x + Leaflet 1.9.x + OpenStreetMap (CARTO Voyager)
상태관리   Zustand 4.x (filterStore · uiStore · favoritesStore)
스타일     Tailwind CSS v3 + Noto Sans KR
```

---

## 로컬 실행

```bash
cd map-app
npm install
npm run dev
# → http://localhost:5173
```

빌드:

```bash
npm run build
```

---

## 프로젝트 구조

```
map-app/src/
├── components/
│   ├── filters/        # CategoryFilter, NationalityDropdown, PriceRangeSlider
│   ├── layout/         # TopBar (검색), Sidebar (필터+즐겨찾기)
│   ├── map/            # MapContainer, MarkerLayer, CategoryPin
│   │                   # MyLocationButton, EmptyState, MapLegend
│   └── panels/         # DetailPanel (상세 정보)
├── data/               # 10개 카테고리 JSON (151개 장소)
├── hooks/              # useFilteredMarkers, useAllLocations, useAllPriceRanks
├── store/              # filterStore, uiStore, favoritesStore
└── types/              # AnyLocation union type, CATEGORY_META
```

---

## 개발 브랜치

`claude/lowest-price-map-app-aj4LR`

---

## 라이선스

[Apache License 2.0](LICENSE)
