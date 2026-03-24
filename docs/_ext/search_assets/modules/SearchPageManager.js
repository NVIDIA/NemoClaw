/**
 * Search Page Manager Module
 * Handles search functionality on the dedicated search page with filtering and grouping
 */

/* exported SearchPageManager */
class SearchPageManager {
    constructor() {
        this.searchInput = null;
        this.resultsContainer = null;
        this.searchEngine = null;
        this.documents = [];
        this.currentQuery = '';
        this.allResults = [];
        this.currentFilters = {
            topic: '',
            category: '',  // Legacy alias
            tag: '',
            type: '',
            facets: {}  // Dynamic facets
        };
        this.filterOptions = {
            topics: [],
            categories: [],  // Legacy alias
            tags: [],
            documentTypes: [],
            audience: [],
            personas: [],  // Legacy alias
            difficulties: [],
            facets: {}  // Dynamic facets
        };

        this.init();
    }

    async init() {
        console.log('🔍 Initializing search page...');

        // Get page elements
        this.searchInput = document.querySelector('#enhanced-search-page-input');
        this.resultsContainer = document.querySelector('#enhanced-search-page-results');

        if (!this.searchInput || !this.resultsContainer) {
            console.error('❌ Required search page elements not found');
            return;
        }

        // Wait for enhanced search to be available
        await this.waitForEnhancedSearch();

        // Create filter interface
        this.createFilterInterface();

        // Set up event listeners
        this.setupEventListeners();

        // Handle URL search parameter
        this.handleUrlSearch();

        console.log('✅ Search page initialized');
    }

    async waitForEnhancedSearch() {
        return new Promise((resolve) => {
            const checkForSearch = () => {
                if (window.enhancedSearchInstance && window.enhancedSearchInstance.isLoaded) {
                    this.searchEngine = window.enhancedSearchInstance.getSearchEngine();
                    this.documents = window.enhancedSearchInstance.getDocuments();

                    // Get filter options
                    if (this.searchEngine && this.searchEngine.getFilterOptions) {
                        this.filterOptions = this.searchEngine.getFilterOptions();
                        console.log('✅ Filter options loaded:', this.filterOptions);
                    }

                    resolve();
                } else {
                    setTimeout(checkForSearch, 100);
                }
            };
            checkForSearch();
        });
    }

    createFilterInterface() {
        // Get the search controls container
        const searchControlsContainer = this.searchInput.parentNode;

        // Add unified styling to the container
        searchControlsContainer.className = 'search-controls-container mb-4';

        // Create filter section
        const filterSection = document.createElement('div');
        filterSection.className = 'search-filters';
        filterSection.innerHTML = this.renderFilterInterface();

        // Wrap the search input in a styled container
        const searchInputWrapper = document.createElement('div');
        searchInputWrapper.className = 'search-input-wrapper';
        searchInputWrapper.innerHTML = `
            <i class="fa-solid fa-magnifying-glass search-input-icon"></i>
        `;
        this.searchInput.parentNode.insertBefore(searchInputWrapper, this.searchInput);
        searchInputWrapper.appendChild(this.searchInput);

        // Insert filters before the search input wrapper within the same container
        searchControlsContainer.insertBefore(filterSection, searchInputWrapper);

        // Add search input wrapper class for consistent styling
        this.searchInput.className = 'search-input-field';
        this.searchInput.placeholder = 'Search documentation...';

        // Bind filter events
        this.bindFilterEvents();
    }

    renderFilterInterface() {
        // Use topics (new) or categories (legacy) with null safety
        const topics = this.filterOptions.topics || this.filterOptions.categories || [];
        const topicOptions = topics.map(topic =>
            `<option value="${this.escapeHtml(topic)}">${this.escapeHtml(this.formatCategoryName(topic))}</option>`
        ).join('');

        const tags = this.filterOptions.tags || [];
        const tagOptions = tags.map(tag =>
            `<option value="${this.escapeHtml(tag)}">${this.escapeHtml(tag)}</option>`
        ).join('');

        const types = this.filterOptions.documentTypes || [];
        const typeOptions = types.map(type =>
            `<option value="${this.escapeHtml(type)}">${this.escapeHtml(this.formatTypeName(type))}</option>`
        ).join('');

        // Dynamic facets - render additional filter dropdowns for each facet
        const facetFilters = this.renderDynamicFacetFilters();

        // Count active filters
        const activeCount = this.getActiveFilterCount();

        return `
            <div class="filter-header">
                <div class="filter-header-left">
                    <i class="fa-solid fa-sliders filter-header-icon"></i>
                    <span class="filter-header-title">Filters</span>
                    ${activeCount > 0 ? `<span class="active-filter-count">${activeCount}</span>` : ''}
                </div>
                <button id="clear-filters" class="filter-clear-btn ${activeCount === 0 ? 'hidden' : ''}" aria-label="Clear all filters">
                    <i class="fa-solid fa-xmark"></i>
                    <span>Clear all</span>
                </button>
            </div>
            <div class="filter-grid">
                <div class="filter-group">
                    <label class="filter-label" for="topic-filter">
                        <i class="fa-solid fa-folder"></i>
                        Topic
                    </label>
                    <div class="filter-select-wrapper">
                        <select id="topic-filter" class="filter-select" aria-label="Filter by topic">
                            <option value="">All Topics</option>
                            ${topicOptions}
                        </select>
                        <i class="fa-solid fa-chevron-down filter-select-arrow"></i>
                    </div>
                </div>

                <div class="filter-group">
                    <label class="filter-label" for="tag-filter">
                        <i class="fa-solid fa-tag"></i>
                        Tag
                    </label>
                    <div class="filter-select-wrapper">
                        <select id="tag-filter" class="filter-select" aria-label="Filter by tag">
                            <option value="">All Tags</option>
                            ${tagOptions}
                        </select>
                        <i class="fa-solid fa-chevron-down filter-select-arrow"></i>
                    </div>
                </div>

                <div class="filter-group">
                    <label class="filter-label" for="type-filter">
                        <i class="fa-solid fa-file-lines"></i>
                        Type
                    </label>
                    <div class="filter-select-wrapper">
                        <select id="type-filter" class="filter-select" aria-label="Filter by content type">
                            <option value="">All Types</option>
                            ${typeOptions}
                        </select>
                        <i class="fa-solid fa-chevron-down filter-select-arrow"></i>
                    </div>
                </div>

                ${facetFilters}
            </div>
        `;
    }

    getActiveFilterCount() {
        let count = 0;
        if (this.currentFilters.topic || this.currentFilters.category) count++;
        if (this.currentFilters.tag) count++;
        if (this.currentFilters.type) count++;
        if (this.currentFilters.facets) {
            Object.values(this.currentFilters.facets).forEach(v => { if (v) count++; });
        }
        return count;
    }

    updateFilterUI() {
        const activeCount = this.getActiveFilterCount();
        const countBadge = document.querySelector('.active-filter-count');
        const clearBtn = document.getElementById('clear-filters');

        if (countBadge) {
            if (activeCount > 0) {
                countBadge.textContent = activeCount;
                countBadge.style.display = 'inline-flex';
            } else {
                countBadge.style.display = 'none';
            }
        }

        if (clearBtn) {
            clearBtn.classList.toggle('hidden', activeCount === 0);
        }

        // Update select wrappers with active state
        document.querySelectorAll('.filter-select').forEach(select => {
            const wrapper = select.closest('.filter-select-wrapper');
            if (wrapper) {
                wrapper.classList.toggle('has-value', select.value !== '');
            }
        });
    }

    renderDynamicFacetFilters() {
        const facets = this.filterOptions.facets || {};

        return Object.entries(facets).map(([facetKey, facetValues]) => {
            if (!Array.isArray(facetValues) || facetValues.length === 0) return '';

            const options = facetValues.map(value =>
                `<option value="${value}">${this.formatFacetValue(value)}</option>`
            ).join('');

            const icon = this.getFacetIcon(facetKey);

            return `
                <div class="filter-group">
                    <label class="filter-label" for="facet-${facetKey}-filter">
                        <i class="${icon}"></i>
                        ${this.formatFacetName(facetKey)}
                    </label>
                    <div class="filter-select-wrapper">
                        <select id="facet-${facetKey}-filter" class="filter-select facet-filter" data-facet-key="${facetKey}">
                            <option value="">All ${this.formatFacetName(facetKey)}</option>
                            ${options}
                        </select>
                        <i class="fa-solid fa-chevron-down filter-select-arrow"></i>
                    </div>
                </div>
            `;
        }).join('');
    }

    getFacetIcon(facetKey) {
        const iconMap = {
            'modality': 'fa-solid fa-layer-group',
            'framework': 'fa-solid fa-cube',
            'platform': 'fa-solid fa-desktop',
            'language': 'fa-solid fa-code',
            'version': 'fa-solid fa-code-branch',
            'status': 'fa-solid fa-circle-check'
        };
        return iconMap[facetKey.toLowerCase()] || 'fa-solid fa-filter';
    }

    formatFacetName(facetKey) {
        return facetKey
            .split(/[-_]/)
            .map(word => word.charAt(0).toUpperCase() + word.slice(1))
            .join(' ');
    }

    formatFacetValue(value) {
        if (typeof value !== 'string') return String(value);
        return value
            .split(/[-_]/)
            .map(word => word.charAt(0).toUpperCase() + word.slice(1))
            .join(' ');
    }

    formatCategoryName(category) {
        return category
            .split(/[-_]/)
            .map(word => word.charAt(0).toUpperCase() + word.slice(1))
            .join(' ');
    }

    formatTypeName(type) {
        return type
            .split(/[-_]/)
            .map(word => word.charAt(0).toUpperCase() + word.slice(1))
            .join(' ');
    }

    formatPersonaName(persona) {
        // Convert "data-scientist-focused" to "Data Scientist Focused"
        return persona
            .replace(/-focused$/, '') // Remove "-focused" suffix
            .split(/[-_]/)
            .map(word => word.charAt(0).toUpperCase() + word.slice(1))
            .join(' ');
    }

    formatDifficultyName(difficulty) {
        return difficulty.charAt(0).toUpperCase() + difficulty.slice(1);
    }

    formatModalityName(modality) {
        return modality
            .split(/[-_]/)
            .map(word => word.charAt(0).toUpperCase() + word.slice(1))
            .join(' ');
    }

    bindFilterEvents() {
        // Topic filter (new schema, replaces category)
        const topicFilter = document.getElementById('topic-filter');
        if (topicFilter) {
            topicFilter.addEventListener('change', (e) => {
                this.currentFilters.topic = e.target.value;
                this.currentFilters.category = e.target.value; // Legacy alias
                this.updateFilterUI();
                this.applyFiltersAndSearch();
            });
        }

        // Tag filter
        const tagFilter = document.getElementById('tag-filter');
        if (tagFilter) {
            tagFilter.addEventListener('change', (e) => {
                this.currentFilters.tag = e.target.value;
                this.updateFilterUI();
                this.applyFiltersAndSearch();
            });
        }

        // Type filter
        const typeFilter = document.getElementById('type-filter');
        if (typeFilter) {
            typeFilter.addEventListener('change', (e) => {
                this.currentFilters.type = e.target.value;
                this.updateFilterUI();
                this.applyFiltersAndSearch();
            });
        }

        // Dynamic facet filters
        document.querySelectorAll('.facet-filter').forEach(select => {
            select.addEventListener('change', (e) => {
                const facetKey = e.target.dataset.facetKey;
                if (!this.currentFilters.facets) {
                    this.currentFilters.facets = {};
                }
                this.currentFilters.facets[facetKey] = e.target.value;
                // Also set flat key for backwards compatibility
                this.currentFilters[facetKey] = e.target.value;
                this.updateFilterUI();
                this.applyFiltersAndSearch();
            });
        });

        // Clear filters
        const clearBtn = document.getElementById('clear-filters');
        if (clearBtn) {
            clearBtn.addEventListener('click', () => {
                this.clearFilters();
            });
        }
    }

    clearFilters() {
        this.currentFilters = {
            topic: '',
            category: '',  // Legacy alias
            tag: '',
            type: '',
            facets: {}
        };

        // Reset filter selects with null safety
        const topicFilter = document.getElementById('topic-filter');
        if (topicFilter) topicFilter.value = '';

        const tagFilter = document.getElementById('tag-filter');
        if (tagFilter) tagFilter.value = '';

        const typeFilter = document.getElementById('type-filter');
        if (typeFilter) typeFilter.value = '';

        // Reset dynamic facet filters
        document.querySelectorAll('.facet-filter').forEach(select => {
            select.value = '';
        });

        // Update filter UI state
        this.updateFilterUI();

        // Clear active filter display
        this.updateActiveFiltersDisplay();

        // Re-run search
        this.applyFiltersAndSearch();
    }

    handleBadgeClick(filterType, filterValue) {
        // Handle dynamic facet filters (facet-modality, facet-framework, etc.)
        if (filterType.startsWith('facet-')) {
            const facetKey = filterType.replace('facet-', '');
            if (!this.currentFilters.facets) {
                this.currentFilters.facets = {};
            }
            this.currentFilters.facets[facetKey] = filterValue;
            this.currentFilters[facetKey] = filterValue; // Flat alias

            // Update dropdown if it exists
            const dropdown = document.getElementById(`facet-${facetKey}-filter`);
            if (dropdown) {
                dropdown.value = filterValue;
            }
        } else {
            // Standard filter
            this.currentFilters[filterType] = filterValue;

            // Handle legacy aliases and update corresponding dropdowns
            if (filterType === 'topic') {
                this.currentFilters.category = filterValue;
                const topicDropdown = document.getElementById('topic-filter');
                if (topicDropdown) topicDropdown.value = filterValue;
            } else if (filterType === 'audience') {
                this.currentFilters.persona = filterValue;
                const audienceDropdown = document.getElementById('audience-filter');
                if (audienceDropdown) audienceDropdown.value = filterValue;
            } else if (filterType === 'difficulty') {
                const difficultyDropdown = document.getElementById('difficulty-filter');
                if (difficultyDropdown) difficultyDropdown.value = filterValue;
            } else if (filterType === 'tag') {
                const tagDropdown = document.getElementById('tag-filter');
                if (tagDropdown) tagDropdown.value = filterValue;
            } else if (filterType === 'type') {
                const typeDropdown = document.getElementById('type-filter');
                if (typeDropdown) typeDropdown.value = filterValue;
            } else {
                // Fallback: try to update dropdown by filter type
                const dropdown = document.getElementById(`${filterType}-filter`);
                if (dropdown) {
                    dropdown.value = filterValue;
                }
            }
        }

        // Update active filters display
        this.updateActiveFiltersDisplay();

        // Re-run search
        this.applyFiltersAndSearch();
    }

    updateActiveFiltersDisplay() {
        // Remove existing active filters display
        const existingDisplay = document.querySelector('.active-filters-display');
        if (existingDisplay) {
            existingDisplay.remove();
        }

        // Check for active dynamic facet filters (not in standard dropdowns)
        const activeMetadataFilters = [];

        // Dynamic facet filters
        if (this.currentFilters.facets) {
            Object.entries(this.currentFilters.facets).forEach(([facetKey, facetValue]) => {
                if (facetValue) {
                    activeMetadataFilters.push(`🏷️ ${this.formatFacetName(facetKey)}: ${this.formatFacetValue(facetValue)}`);
                }
            });
        }

        if (activeMetadataFilters.length > 0) {
            const filtersContainer = document.querySelector('.search-filters');
            if (filtersContainer) {
                const activeFiltersHtml = `
                    <div class="active-filters-display mb-2">
                        <small class="text-muted">Active filters: </small>
                        ${activeMetadataFilters.map(filter => `<span class="active-filter-badge">${filter}</span>`).join(' ')}
                        <button class="btn btn-outline-secondary btn-sm ms-2" onclick="window.searchPageManager.clearMetadataFilters()">
                            <i class="fa-solid fa-xmark"></i> Clear metadata filters
                        </button>
                    </div>
                `;
                filtersContainer.insertAdjacentHTML('afterend', activeFiltersHtml);
            }
        }
    }

    clearMetadataFilters() {
        this.currentFilters.facets = {};

        // Reset dynamic facet filters in UI
        document.querySelectorAll('.facet-filter').forEach(select => {
            select.value = '';
        });

        this.updateActiveFiltersDisplay();
        this.applyFiltersAndSearch();
    }

    applyFiltersAndSearch() {
        if (this.currentQuery) {
            this.handleSearch(this.currentQuery);
        }
    }

    setupEventListeners() {
        // Search input
        this.searchInput.addEventListener('input', this.debounce((e) => {
            this.handleSearch(e.target.value);
        }, 300));

        this.searchInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                this.handleSearch(e.target.value);
            }
        });

        // Badge click handlers (using event delegation)
        this.resultsContainer.addEventListener('click', (e) => {
            if (e.target.classList.contains('clickable-badge')) {
                const filterType = e.target.dataset.filterType;
                const filterValue = e.target.dataset.filterValue;
                this.handleBadgeClick(filterType, filterValue);
            }
        });

        // Make instance available globally for button callbacks
        window.searchPageManager = this;

        // Initialize keyboard navigation state
        this.focusedIndex = -1;

        // Focus input on page load
        this.searchInput.focus();
    }

    /**
     * Setup keyboard navigation for search results
     */
    setupKeyboardNavigation() {
        // Reset focused index when results change
        this.focusedIndex = -1;

        // Use a single event listener on the document (avoiding duplicates)
        if (!this.keyboardNavigationInitialized) {
            this.keyboardNavigationInitialized = true;

            document.addEventListener('keydown', (e) => {
                const results = this.resultsContainer.querySelectorAll('.search-result');
                if (results.length === 0) return;

                // Only handle when search area is focused
                if (!this.isSearchFocused()) return;

                if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    this.focusedIndex = Math.min(this.focusedIndex + 1, results.length - 1);
                    this.focusResult(results, this.focusedIndex);
                } else if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    this.focusedIndex = Math.max(this.focusedIndex - 1, 0);
                    this.focusResult(results, this.focusedIndex);
                } else if (e.key === 'Enter' && this.focusedIndex >= 0) {
                    e.preventDefault();
                    const link = results[this.focusedIndex].querySelector('a');
                    if (link) link.click();
                } else if (e.key === 'Escape') {
                    this.focusedIndex = -1;
                    this.clearFocus();
                    this.searchInput.focus();
                }
            });
        }
    }

    /**
     * Check if search area is focused
     */
    isSearchFocused() {
        const active = document.activeElement;
        return active === this.searchInput ||
            this.resultsContainer.contains(active) ||
            this.resultsContainer.querySelector('.focused');
    }

    /**
     * Focus a specific result by index
     */
    focusResult(results, index) {
        this.clearFocus();
        const element = results[index];
        if (element) {
            element.classList.add('focused');
            element.setAttribute('aria-selected', 'true');
            element.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
    }

    /**
     * Clear focus from all results
     */
    clearFocus() {
        this.resultsContainer.querySelectorAll('.search-result.focused')
            .forEach(el => {
                el.classList.remove('focused');
                el.setAttribute('aria-selected', 'false');
            });
    }

    handleUrlSearch() {
        const urlParams = new URLSearchParams(window.location.search);
        const query = urlParams.get('q');
        if (query) {
            this.searchInput.value = query;
            this.handleSearch(query);
        }
    }

    handleSearch(query) {
        this.currentQuery = query.trim();

        if (!this.currentQuery) {
            this.showEmptyState();
            return;
        }

        if (this.currentQuery.length < 2) {
            this.showMinLengthMessage();
            return;
        }

        // Perform search with filters
        const results = this.searchEngine.search(this.currentQuery, this.currentFilters);
        this.allResults = results;
        this.displayResults(results);

        // Update URL without reload
        const newUrl = new URL(window.location);
        newUrl.searchParams.set('q', this.currentQuery);
        window.history.replaceState(null, '', newUrl);
    }

    displayResults(results) {
        if (results.length === 0) {
            this.showNoResults();
            return;
        }

        const resultsHtml = results.map((result, index) => this.renderResult(result, index)).join('');
        const resultBreakdown = this.getResultBreakdown(results);

        this.resultsContainer.innerHTML = `
            <div id="ai-assistant-container" class="ai-assistant-container mb-4" style="display: none;"></div>
            <div class="search-results-header mb-4">
                <h3>Search Results</h3>
                <p class="text-muted">
                    Found ${results.length} result${results.length !== 1 ? 's' : ''} for "${this.escapeHtml(this.currentQuery)}"
                    ${this.getActiveFiltersText()}
                    ${resultBreakdown ? `<span class="result-breakdown">${resultBreakdown}</span>` : ''}
                </p>
            </div>
            <div class="search-results-list" role="listbox" aria-label="Search results">
                ${resultsHtml}
            </div>
        `;

        // Setup keyboard navigation
        this.setupKeyboardNavigation();

        // Emit event for AI assistant integration
        this.emitSearchAIRequest(this.currentQuery, results);
    }

    /**
     * Get result type breakdown for display
     */
    getResultBreakdown(results) {
        const byType = {};
        results.forEach(r => {
            const type = r.content_type || 'Other';
            byType[type] = (byType[type] || 0) + 1;
        });

        const breakdown = Object.entries(byType)
            .sort((a, b) => b[1] - a[1])
            .map(([type, count]) => `${count} ${this.escapeHtml(this.formatTypeName(type))}`)
            .join(' · ');

        return breakdown;
    }

    /**
     * Render topic badges for a result
     */
    renderTopicBadges(result) {
        const topics = this.searchEngine.getDocumentTopics
            ? this.searchEngine.getDocumentTopics(result)
            : [];

        if (!topics || topics.length === 0) return '';

        const topicBadges = topics.slice(0, 3).map(topic =>
            `<span class="topic-badge clickable-badge"
                   data-filter-type="topic"
                   data-filter-value="${this.escapeHtml(topic)}"
                   title="Click to filter by ${this.escapeHtml(topic)}">
                📁 ${this.escapeHtml(topic)}
            </span>`
        ).join('');

        const moreBadge = topics.length > 3
            ? `<span class="more-topics">+${topics.length - 3}</span>`
            : '';

        return `<div class="result-topics mb-2">${topicBadges}${moreBadge}</div>`;
    }

    getActiveFiltersText() {
        const activeFilters = [];

        // Topic (new) or category (legacy)
        const topicFilter = this.currentFilters.topic || this.currentFilters.category;
        if (topicFilter) {
            activeFilters.push(`Topic: ${this.formatCategoryName(topicFilter)}`);
        }
        if (this.currentFilters.tag) {
            activeFilters.push(`Tag: ${this.currentFilters.tag}`);
        }
        if (this.currentFilters.type) {
            activeFilters.push(`Type: ${this.formatTypeName(this.currentFilters.type)}`);
        }

        // Dynamic facets
        if (this.currentFilters.facets) {
            Object.entries(this.currentFilters.facets).forEach(([facetKey, facetValue]) => {
                if (facetValue) {
                    activeFilters.push(`${this.formatFacetName(facetKey)}: ${this.formatFacetValue(facetValue)}`);
                }
            });
        }

        return activeFilters.length > 0 ? ` (filtered by ${activeFilters.join(', ')})` : '';
    }

    renderResult(result, index) {
        const title = this.highlightText(result.title, this.currentQuery);
        // Use description (frontmatter) > summary > generated snippet
        const snippetSource = result.description || result.summary || this.generateSnippet(result.content, this.currentQuery, 200);
        const summary = this.highlightText(snippetSource || '', this.currentQuery);
        const breadcrumb = this.getBreadcrumb(result.id);
        const sectionInfo = this.getSectionInfo(result.id);
        const matchingSections = this.renderMatchingSections(result, this.currentQuery);
        const resultTags = this.renderResultTags(result);
        const topicBadges = this.renderTopicBadges(result);
        const metadataBadges = this.renderMetadataBadges(result);

        // Multiple matches indicator
        const multipleMatchesIndicator = result.totalMatches > 1
            ? `<span class="multiple-matches-indicator">+${result.totalMatches - 1} more matches</span>`
            : '';

        return `
            <div class="search-result mb-4"
                 role="option"
                 aria-selected="false"
                 tabindex="-1"
                 id="result-${index}"
                 data-result-index="${index}">
                <div class="result-header d-flex align-items-start mb-2">
                    <div class="section-icon me-3">
                        <i class="${sectionInfo.icon}"></i>
                    </div>
                    <div class="result-info flex-grow-1">
                        <h4 class="result-title mb-1">
                            <a href="${this.getDocumentUrl(result)}" class="text-decoration-none">${title}</a>
                            ${multipleMatchesIndicator}
                        </h4>
                        <div class="result-breadcrumb mb-2">
                            <small class="text-muted">${breadcrumb}</small>
                        </div>
                        ${topicBadges}
                        <div class="result-meta d-flex align-items-center gap-2 mb-2 flex-wrap">
                            ${metadataBadges}
                        </div>
                        ${resultTags}
                    </div>
                </div>
                <div class="result-content">
                    <p class="result-summary mb-3">${summary}</p>
                    ${matchingSections}
                </div>
            </div>
        `;
    }

    /**
     * Generate context-aware snippet around search terms
     */
    generateSnippet(content, query, maxLength = 200) {
        if (!content) return '';

        // Find first occurrence of any search term
        const terms = query.toLowerCase().split(/\s+/).filter(t => t.length > 2);
        const lowerContent = content.toLowerCase();

        let startIndex = 0;
        for (const term of terms) {
            const idx = lowerContent.indexOf(term);
            if (idx > 0) {
                startIndex = Math.max(0, idx - 50); // Start 50 chars before match
                break;
            }
        }

        // Extract snippet around match
        let snippet = content.substring(startIndex, startIndex + maxLength);

        // Clean up word boundaries
        if (startIndex > 0) {
            const firstSpace = snippet.indexOf(' ');
            if (firstSpace > 0 && firstSpace < 20) {
                snippet = snippet.substring(firstSpace + 1);
            }
            snippet = '...' + snippet;
        }

        if (startIndex + maxLength < content.length) {
            const lastSpace = snippet.lastIndexOf(' ');
            if (lastSpace > snippet.length - 20) {
                snippet = snippet.substring(0, lastSpace);
            }
            snippet += '...';
        }

        return snippet;
    }

    renderResultTags(result) {
        const tags = this.searchEngine.getDocumentTags(result);
        if (!tags || tags.length === 0) return '';

        const tagsToShow = tags.slice(0, 6); // Show more tags since they're now on their own line
        const tagsHtml = tagsToShow.map(tag =>
            `<span class="result-tag clickable-badge" data-filter-type="tag" data-filter-value="${this.escapeHtml(tag)}" title="Click to filter by this tag">${tag}</span>`
        ).join('');

        const moreText = tags.length > 6 ? `<span class="more-tags">+${tags.length - 6} more</span>` : '';

        return `<div class="result-tags mb-2">${tagsHtml}${moreText}</div>`;
    }

    renderResultCategories(result) {
        // Use getDocumentTopics (new) which falls back to getDocumentCategories (legacy)
        const topics = this.searchEngine.getDocumentTopics
            ? this.searchEngine.getDocumentTopics(result)
            : this.searchEngine.getDocumentCategories(result);
        if (!topics || topics.length === 0) return '';

        const topicsHtml = topics.slice(0, 2).map(topic =>
            `<span class="result-category badge bg-info">${this.formatCategoryName(topic)}</span>`
        ).join('');

        return `<div class="result-categories">${topicsHtml}</div>`;
    }

    renderMetadataBadges(result) {
        const badges = [];

        // Audience badges (new) or personas (legacy) - render each as separate badge
        const audienceField = result.audience || result.personas;
        if (audienceField) {
            // Parse audience list - handle array, comma-separated string, or space-separated string with known patterns
            let audienceList = [];
            if (Array.isArray(audienceField)) {
                audienceList = audienceField;
            } else if (typeof audienceField === 'string') {
                // Check for comma separation first
                if (audienceField.includes(',')) {
                    audienceList = audienceField.split(',').map(a => a.trim()).filter(Boolean);
                } else {
                    // Try to match known audience patterns (e.g., "Technical Writer Developer" -> ["Technical Writer", "Developer"])
                    const knownAudiences = ['Technical Writer', 'Developer', 'Data Scientist', 'ML Engineer', 'DevOps', 'Administrator', 'Researcher'];
                    const matches = [];
                    let remaining = audienceField;

                    for (const known of knownAudiences) {
                        if (remaining.includes(known)) {
                            matches.push(known);
                            remaining = remaining.replace(known, '').trim();
                        }
                    }

                    audienceList = matches.length > 0 ? matches : [audienceField];
                }
            }

            audienceList.forEach(audience => {
                const formatted = this.formatPersonaName(audience);
                badges.push(`<span class="metadata-badge persona-badge" title="${this.escapeHtml(formatted)}">👤 ${this.escapeHtml(formatted)}</span>`);
            });
        }

        // Difficulty badge
        if (result.difficulty) {
            const difficultyIcon = this.getDifficultyIcon(result.difficulty);
            badges.push(`<span class="metadata-badge difficulty-badge" title="${this.formatDifficultyName(result.difficulty)}">${difficultyIcon} ${this.formatDifficultyName(result.difficulty)}</span>`);
        }

        // Dynamic facet badges
        if (result.facets && typeof result.facets === 'object') {
            Object.entries(result.facets).forEach(([facetKey, facetValue]) => {
                if (facetValue) {
                    const values = Array.isArray(facetValue) ? facetValue : [facetValue];
                    values.forEach(value => {
                        badges.push(`<span class="metadata-badge facet-badge" title="${this.formatFacetName(facetKey)}: ${this.formatFacetValue(value)}">🏷️ ${this.formatFacetValue(value)}</span>`);
                    });
                }
            });
        }

        // Legacy flat modality badge (if not in facets)
        if (result.modality && (!result.facets || !result.facets.modality)) {
            const modalityIcon = this.getModalityIcon(result.modality);
            badges.push(`<span class="metadata-badge modality-badge" title="${this.formatFacetValue(result.modality)}">${modalityIcon} ${this.formatFacetValue(result.modality)}</span>`);
        }

        return badges.join('');
    }

    getDifficultyIcon(difficulty) {
        switch (difficulty.toLowerCase()) {
            case 'beginner': return '🔰';
            case 'intermediate': return '📊';
            case 'advanced': return '🚀';
            case 'reference': return '📚';
            default: return '📖';
        }
    }

    getModalityIcon(modality) {
        switch (modality.toLowerCase()) {
            case 'text-only': return '📝';
            case 'image-only': return '🖼️';
            case 'video-only': return '🎥';
            case 'multimodal': return '🔀';
            case 'universal': return '🌐';
            default: return '📄';
        }
    }

    renderMatchingSections(result, query) {
        if (!result.matchingSections || result.matchingSections.length <= 1) {
            return '';
        }

        const sectionsToShow = result.matchingSections.slice(0, 5);
        const hasMore = result.matchingSections.length > 5;

        const sectionsHtml = sectionsToShow.map(section => {
            const sectionIcon = this.getSectionIcon(section.type, section.level);
            const sectionText = this.highlightText(section.text, query);
            const anchor = section.anchor ? `#${section.anchor}` : '';
            const sectionUrl = this.getDocumentUrl(result) + anchor;

            return `
                <a href="${sectionUrl}" class="section-link d-flex align-items-center text-decoration-none mb-1 p-2 rounded">
                    <span class="section-icon me-2">${sectionIcon}</span>
                    <span class="section-text flex-grow-1">${sectionText}</span>
                    <i class="fas fa-external-link-alt ms-2" style="font-size: 0.75rem;"></i>
                </a>
            `;
        }).join('');

        const moreIndicator = hasMore ? `
            <div class="text-muted small mt-1 ms-4">
                <i class="fas fa-ellipsis-h me-1"></i>
                +${result.matchingSections.length - 5} more sections
            </div>
        ` : '';

        return `
            <div class="matching-sections">
                <h5 class="h6 mb-2">
                    <i class="fas fa-list-ul me-1"></i>
                    Matching sections:
                </h5>
                <div class="section-links border rounded p-2">
                    ${sectionsHtml}
                    ${moreIndicator}
                </div>
            </div>
        `;
    }

    getSectionIcon(type, level) {
        switch (type) {
            case 'title':
                return '<i class="fas fa-file-lines"></i>';
            case 'heading':
                if (level <= 2) return '<i class="fas fa-heading"></i>';
                if (level <= 4) return '<i class="fas fa-heading text-muted"></i>';
                return '<i class="fas fa-heading text-muted"></i>';
            case 'content':
                return '<i class="fas fa-align-left text-muted"></i>';
            default:
                return '<i class="fas fa-circle-dot text-muted"></i>';
        }
    }

    getBreadcrumb(docId) {
        const parts = docId.split('/').filter(part => part && part !== 'index');
        return parts.length > 0 ? parts.join(' › ') : 'Home';
    }

    getSectionInfo(docId) {
        const path = docId.toLowerCase();

        if (path.includes('get-started') || path.includes('getting-started')) {
            return {
                class: 'getting-started',
                icon: 'fas fa-rocket',
                label: 'Getting Started'
            };
        } else if (path.includes('admin')) {
            return {
                class: 'admin',
                icon: 'fas fa-cog',
                label: 'Administration'
            };
        } else if (path.includes('reference') || path.includes('api')) {
            return {
                class: 'reference',
                icon: 'fas fa-book',
                label: 'Reference'
            };
        } else if (path.includes('about') || path.includes('concepts')) {
            return {
                class: 'about',
                icon: 'fas fa-info-circle',
                label: 'About'
            };
        } else if (path.includes('tutorial')) {
            return {
                class: 'tutorial',
                icon: 'fas fa-graduation-cap',
                label: 'Tutorial'
            };
        } else {
            return {
                class: 'default',
                icon: 'fas fa-file-lines',
                label: 'Documentation'
            };
        }
    }

    getDocumentUrl(result) {
        if (result.url) {
            return result.url;
        }
        return `${result.id.replace(/^\/+/, '')}.html`;
    }

    highlightText(text, query) {
        if (!query) return this.escapeHtml(text);

        const terms = query.toLowerCase().split(/\s+/).filter(term => term.length > 1);
        let highlightedText = this.escapeHtml(text);

        terms.forEach(term => {
            const regex = new RegExp(`(${this.escapeRegex(term)})`, 'gi');
            highlightedText = highlightedText.replace(regex, '<mark class="search-highlight">$1</mark>');
        });

        return highlightedText;
    }

    showEmptyState() {
        this.resultsContainer.innerHTML = `
            <div class="text-center py-4">
                <i class="fas fa-search fa-2x mb-3 text-success"></i>
                <h4>Search Documentation</h4>
                <p class="text-muted">Start typing to search across all documentation pages...</p>
                <div class="mt-3">
                    <small class="text-muted">
                        <i class="fas fa-lightbulb text-success"></i>
                        <strong>Search Tips:</strong> Use specific terms for better results • Use filters to narrow down results • Search includes titles, content, and headings
                    </small>
                </div>
            </div>
        `;
    }

    showMinLengthMessage() {
        this.resultsContainer.innerHTML = `
            <div class="text-center py-4">
                <i class="fas fa-keyboard fa-2x mb-3 text-muted"></i>
                <h4>Keep typing...</h4>
                <p class="text-muted">Enter at least 2 characters to search</p>
            </div>
        `;
    }

    showNoResults() {
        const filtersActive = this.currentFilters.topic || this.currentFilters.category ||
            this.currentFilters.tag || this.currentFilters.type ||
            (this.currentFilters.facets && Object.keys(this.currentFilters.facets).some(k => this.currentFilters.facets[k]));
        const suggestionText = filtersActive
            ? 'Try clearing some filters or using different keywords'
            : 'Try different keywords or check your spelling';

        this.resultsContainer.innerHTML = `
            <div class="no-results text-center py-4">
                <i class="fas fa-search fa-2x mb-3 text-muted"></i>
                <h4>No results found</h4>
                <p class="text-muted">No results found for "${this.escapeHtml(this.currentQuery)}"${this.getActiveFiltersText()}</p>
                <div class="mt-3">
                    <small class="text-muted">
                        ${suggestionText}
                    </small>
                </div>
                ${filtersActive ? `
                    <div class="mt-3">
                        <button onclick="document.getElementById('clear-filters').click()" class="btn btn-outline-secondary btn-sm">
                            <i class="fas fa-times"></i> Clear Filters
                        </button>
                    </div>
                ` : ''}
            </div>
        `;
    }

    // Utility methods
    debounce(func, wait) {
        let timeout;
        return function executedFunction(...args) {
            const later = () => {
                clearTimeout(timeout);
                func(...args);
            };
            clearTimeout(timeout);
            timeout = setTimeout(later, wait);
        };
    }

    escapeHtml(unsafe) {
        return unsafe
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");
    }

    escapeRegex(string) {
        return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    emitSearchAIRequest(query, results) {
        // Emit event for AI assistant integration (search page)
        const aiRequestEvent = new CustomEvent('search-ai-request', {
            detail: {
                query: query,
                results: results,
                count: results.length,
                container: 'ai-assistant-container'
            }
        });
        document.dispatchEvent(aiRequestEvent);

        console.log(`🤖 Emitted search-ai-request event for query: "${query}" with ${results.length} results`);
    }
}
