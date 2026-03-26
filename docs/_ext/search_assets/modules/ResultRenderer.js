/**
 * ResultRenderer Module
 * Handles rendering of search results in the interface
 */

class ResultRenderer {
    constructor(options, utils) {
        this.options = options;
        this.utils = utils;
    }

    /**
     * Render search results
     */
    render(results, query, container) {
        if (!container) {
            console.warn('No container provided for rendering results');
            return;
        }

        if (results.length === 0) {
            container.innerHTML = this.renderNoResults(query);
            return;
        }

        const html = results.map((result, index) => {
            const isSelected = index === 0;
            return this.renderResultItem(result, query, isSelected);
        }).join('');

        container.innerHTML = `<div class="search-results-list">${html}</div>`;

        // Bind click events
        this.bindResultEvents(container, results);
    }

    /**
     * Render a single result item
     */
    renderResultItem(result, query, isSelected = false) {
        const title = this.utils.highlightText(result.title || 'Untitled', query);
        const summary = this.utils.highlightText(result.summary || result.content?.substring(0, 200) || '', query);
        const breadcrumb = this.utils.generateBreadcrumb(result.id);

        // Render matching sections
        const sectionsHtml = this.renderMatchingSections(result, query);

        // Show multiple matches indicator
        const multipleMatchesIndicator = result.totalMatches > 1
            ? `<span class="search-result-matches-count">${result.totalMatches} matches</span>`
            : '';

        return `
            <div class="search-result-item ${isSelected ? 'selected' : ''}" tabindex="0" data-url="${this.utils.getDocumentUrl(result)}">
                <div class="search-result-content">
                    <div class="search-result-title">${title} ${multipleMatchesIndicator}</div>
                    <div class="search-result-summary">${summary}...</div>
                    ${sectionsHtml}
                    <div class="search-result-meta">
                        <span class="search-result-breadcrumb">${breadcrumb}</span>
                        ${result.tags ? `<span class="search-result-tags">${this.utils.safeArray(result.tags).slice(0, 3).map(tag => `<span class="tag">${tag}</span>`).join('')}</span>` : ''}
                    </div>
                </div>
                <div class="search-result-score">
                    <i class="fa-solid fa-arrow-right"></i>
                </div>
            </div>
        `;
    }

    /**
     * Render matching sections within a result
     */
    renderMatchingSections(result, query) {
        if (!result.matchingSections || result.matchingSections.length <= 1) {
            return '';
        }

        // Show only the first few sections to avoid overwhelming
        const sectionsToShow = result.matchingSections.slice(0, 4);
        const hasMore = result.matchingSections.length > 4;

        const sectionsHtml = sectionsToShow.map(section => {
            const icon = this.utils.getSectionIcon(section.type, section.level);
            const sectionText = this.utils.highlightText(section.text, query);
            const anchor = section.anchor ? `#${section.anchor}` : '';

            return `
                <div class="search-result-section" data-anchor="${anchor}">
                    ${icon} <span class="section-text">${sectionText}</span>
                </div>
            `;
        }).join('');

        const moreIndicator = hasMore
            ? `<div class="search-result-section-more">+${result.matchingSections.length - 4} more sections</div>`
            : '';

        return `
            <div class="search-result-sections">
                ${sectionsHtml}
                ${moreIndicator}
            </div>
        `;
    }

    /**
     * Render no results state
     */
    renderNoResults(query) {
        return `
            <div class="search-no-results">
                <i class="fa-solid fa-search-minus"></i>
                <p>No results found for "<strong>${this.utils.escapeHtml(query)}</strong>"</p>
                <div class="search-suggestions">
                    <strong>Try:</strong>
                    <ul>
                        <li>Checking for typos</li>
                        <li>Using different or more general terms</li>
                        <li>Using fewer keywords</li>
                    </ul>
                </div>
            </div>
        `;
    }

    /**
     * Bind click events to result items
     */
    bindResultEvents(container, results) {
        container.querySelectorAll('.search-result-item').forEach((item, index) => {
            const _result = results[index];

            // Main item click - go to document
            item.addEventListener('click', (e) => {
                // Don't trigger if clicking on a section
                if (e.target.closest('.search-result-section')) {
                    return;
                }

                const url = item.dataset.url;
                window.location.href = url;
            });

            // Section clicks - go to specific section
            item.querySelectorAll('.search-result-section').forEach(sectionEl => {
                sectionEl.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const anchor = sectionEl.dataset.anchor;
                    const baseUrl = item.dataset.url;
                    window.location.href = baseUrl + anchor;
                });
            });
        });
    }

    /**
     * Get result items from container
     */
    getResultItems(container) {
        return container.querySelectorAll('.search-result-item');
    }

    /**
     * Get selected result item
     */
    getSelectedResult(container) {
        return container.querySelector('.search-result-item.selected');
    }

    /**
     * Select next result item
     */
    selectNext(container) {
        const results = this.getResultItems(container);
        const selected = this.getSelectedResult(container);

        if (results.length === 0) return;

        if (!selected) {
            results[0].classList.add('selected');
            return;
        }

        const currentIndex = Array.from(results).indexOf(selected);
        selected.classList.remove('selected');

        const nextIndex = (currentIndex + 1) % results.length;
        results[nextIndex].classList.add('selected');
        results[nextIndex].scrollIntoView({ block: 'nearest' });
    }

    /**
     * Select previous result item
     */
    selectPrevious(container) {
        const results = this.getResultItems(container);
        const selected = this.getSelectedResult(container);

        if (results.length === 0) return;

        if (!selected) {
            results[results.length - 1].classList.add('selected');
            return;
        }

        const currentIndex = Array.from(results).indexOf(selected);
        selected.classList.remove('selected');

        const prevIndex = currentIndex === 0 ? results.length - 1 : currentIndex - 1;
        results[prevIndex].classList.add('selected');
        results[prevIndex].scrollIntoView({ block: 'nearest' });
    }

    /**
     * Activate selected result
     */
    activateSelected(container) {
        const selected = this.getSelectedResult(container);
        if (selected) {
            selected.click();
        }
    }

    /**
     * Clear all selections
     */
    clearSelection(container) {
        const results = this.getResultItems(container);
        results.forEach(result => result.classList.remove('selected'));
    }

    /**
     * Render loading state
     */
    renderLoading(container) {
        if (container) {
            container.innerHTML = `
                <div class="search-loading">
                    <i class="fa-solid fa-spinner fa-spin"></i>
                    <p>Searching...</p>
                </div>
            `;
        }
    }

    /**
     * Render error state
     */
    renderError(container, message = 'Search error occurred') {
        if (container) {
            container.innerHTML = `
                <div class="search-error">
                    <i class="fa-solid fa-exclamation-triangle"></i>
                    <p>${this.utils.escapeHtml(message)}</p>
                </div>
            `;
        }
    }
}

// Make ResultRenderer available globally
window.ResultRenderer = ResultRenderer;
