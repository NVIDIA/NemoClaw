/**
 * SearchEngine Module
 * Handles Lunr.js integration and search logic with filtering and grouping
 */

class SearchEngine {
    constructor(utils) {
        this.utils = utils;
        this.index = null;
        this.documents = {};
        this.isInitialized = false;
        // Support both new schema (topics, audience) and legacy (categories, personas)
        this.topics = new Set();
        this.tags = new Set();
        this.documentTypes = new Set();
        this.audience = new Set();
        this.difficulties = new Set();
        // Dynamic facets - discovered from documents, not predefined
        this.facets = {}; // { facetKey: Set of values }
    }

    /**
     * Initialize the search engine with documents
     */
    async initialize(documents) {
        await this.loadLunr();
        this.documents = documents;
        this.collectMetadata();
        this.buildIndex();
        this.isInitialized = true;
    }

    /**
     * Collect metadata for filtering using actual frontmatter values
     * Supports both new schema (topics, audience) and legacy (categories, personas)
     * Dynamically discovers all facet keys from documents
     */
    collectMetadata() {
        // Clear existing sets
        this.topics = new Set();
        this.tags = new Set();
        this.documentTypes = new Set();
        this.audience = new Set();
        this.difficulties = new Set();
        this.facets = {}; // Reset dynamic facets

        Object.values(this.documents).forEach(doc => {
            // Collect topics (new schema) or categories (legacy)
            const topicsField = doc.topics || doc.categories;
            if (topicsField) {
                if (Array.isArray(topicsField)) {
                    topicsField.forEach(topic => this.topics.add(topic));
                } else if (typeof topicsField === 'string') {
                    topicsField.split(',').forEach(topic => this.topics.add(topic.trim()));
                }
            }

            // Collect actual frontmatter tags
            if (doc.tags) {
                if (Array.isArray(doc.tags)) {
                    doc.tags.forEach(tag => {
                        // Split space-separated tags and add individually
                        if (typeof tag === 'string' && tag.includes(' ')) {
                            tag.split(' ').forEach(individualTag => {
                                if (individualTag.trim()) {
                                    this.tags.add(individualTag.trim());
                                }
                            });
                        } else if (tag && tag.trim()) {
                            this.tags.add(tag.trim());
                        }
                    });
                } else if (typeof doc.tags === 'string') {
                    // Handle both comma-separated and space-separated tags
                    const allTags = doc.tags.includes(',')
                        ? doc.tags.split(',')
                        : doc.tags.split(' ');

                    allTags.forEach(tag => {
                        if (tag && tag.trim()) {
                            this.tags.add(tag.trim());
                        }
                    });
                }
            }

            // Use actual content_type from frontmatter (not calculated doc_type)
            if (doc.content_type) {
                this.documentTypes.add(doc.content_type);
            }

            // Collect audience (new schema) or personas (legacy)
            const audienceField = doc.audience || doc.personas;
            if (audienceField) {
                if (Array.isArray(audienceField)) {
                    audienceField.forEach(aud => this.audience.add(aud));
                } else if (typeof audienceField === 'string') {
                    this.audience.add(audienceField);
                }
            }

            if (doc.difficulty) {
                this.difficulties.add(doc.difficulty);
            }

            // Dynamically discover all facets from documents
            if (doc.facets && typeof doc.facets === 'object') {
                Object.entries(doc.facets).forEach(([facetKey, facetValue]) => {
                    // Initialize Set for this facet if not exists
                    if (!this.facets[facetKey]) {
                        this.facets[facetKey] = new Set();
                    }
                    // Add value(s) to the facet Set
                    if (Array.isArray(facetValue)) {
                        facetValue.forEach(v => this.facets[facetKey].add(v));
                    } else if (facetValue) {
                        this.facets[facetKey].add(facetValue);
                    }
                });
            }

            // Also check for flat facet fields (legacy modality, etc.)
            // These get added to facets dynamically
            if (doc.modality && !this.facets.modality) {
                this.facets.modality = new Set();
            }
            if (doc.modality) {
                this.facets.modality.add(doc.modality);
            }
        });
    }

    /**
     * Get available filter options using actual frontmatter taxonomy
     * Returns both new field names and legacy names for backwards compatibility
     * Includes dynamically discovered facets
     */
    getFilterOptions() {
        // Convert dynamic facets from Sets to sorted arrays
        const facetOptions = {};
        Object.entries(this.facets).forEach(([facetKey, facetSet]) => {
            facetOptions[facetKey] = Array.from(facetSet).sort();
        });

        return {
            // New schema names
            topics: Array.from(this.topics).sort(),
            audience: Array.from(this.audience).sort(),
            // Legacy names (aliases for backwards compatibility)
            categories: Array.from(this.topics).sort(),
            personas: Array.from(this.audience).sort(),
            // Common fields
            tags: Array.from(this.tags).sort(),
            documentTypes: Array.from(this.documentTypes).sort(),
            difficulties: Array.from(this.difficulties).sort(),
            // Dynamic facets (user-defined, discovered from documents)
            facets: facetOptions
        };
    }

    /**
     * Load Lunr.js library if not already loaded
     */
    async loadLunr() {
        if (typeof lunr === 'undefined') {
            await this.utils.loadScript('https://unpkg.com/lunr@2.3.9/lunr.min.js');
        }
    }

    /**
     * Build the Lunr search index
     * Supports both new schema (topics, audience) and legacy (categories, personas)
     *
     * Field boosting rationale:
     * - Title matches are almost always what users want (highest boost)
     * - Description (from frontmatter) is hand-crafted summary (high boost)
     * - Headings provide structural relevance (medium-high boost)
     * - Content gets lowest boost to prevent long documents from dominating
     * - Hierarchy: title > description > headings/keywords > tags > content
     */
    buildIndex() {
        const documentsArray = Object.values(this.documents);
        const self = this;

        this.index = lunr(function() {
            // Define fields with optimized boosting for documentation search patterns
            this.ref('id');

            // Primary fields - highest relevance
            this.field('title', { boost: 10 });           // Title matches most important
            this.field('description', { boost: 8 });      // Frontmatter description (hand-crafted)

            // Secondary fields - structural relevance
            this.field('keywords', { boost: 7 });         // Explicit keywords
            this.field('headings_text', { boost: 5 });    // Section headings
            this.field('headings', { boost: 5 });         // Section headings (legacy format)
            this.field('tags', { boost: 4 });             // Taxonomy tags

            // Tertiary fields - content matching
            this.field('summary', { boost: 3 });          // Summary field
            this.field('topics', { boost: 2 });           // Topic categorization
            this.field('content', { boost: 1 });          // Full content (low to prevent long docs dominating)

            // Metadata fields - filtering support
            this.field('content_type', { boost: 1 });
            this.field('audience', { boost: 1 });
            this.field('difficulty', { boost: 1 });
            this.field('modality', { boost: 1 });
            this.field('section_path', { boost: 1 });
            this.field('author', { boost: 1 });

            // Add documents to index
            documentsArray.forEach((doc) => {
                try {
                    this.add({
                        id: doc.id,
                        title: doc.title || '',
                        description: doc.description || '',  // NEW: separate indexed field
                        content: (doc.content || '').substring(0, 5000), // Limit content length
                        summary: doc.summary || '',
                        headings: self.extractHeadingsText(doc.headings),
                        headings_text: doc.headings_text || '',
                        keywords: self.arrayToString(doc.keywords),
                        tags: self.arrayToString(doc.tags),
                        // Support both topics (new) and categories (legacy)
                        topics: self.arrayToString(doc.topics || doc.categories),
                        content_type: doc.content_type || '',
                        // Support both audience (new) and personas (legacy)
                        audience: self.arrayToString(doc.audience || doc.personas),
                        difficulty: doc.difficulty || '',
                        modality: doc.modality || '',
                        section_path: self.arrayToString(doc.section_path),
                        author: doc.author || ''
                    });
                } catch (_docError) {
                    // Skip documents that fail to index
                }
            }, this);
        });
    }

    /**
     * Convert array to string for indexing
     */
    arrayToString(arr) {
        if (Array.isArray(arr)) {
            return arr.join(' ');
        }
        return arr || '';
    }

    /**
     * Extract text from headings array
     */
    extractHeadingsText(headings) {
        if (!Array.isArray(headings)) return '';
        return headings.map(h => h.text || '').join(' ');
    }

    /**
     * Perform search with query and optional filters
     */
    search(query, filters = {}, maxResults = 20) {
        if (!this.isInitialized || !this.index) {
            return [];
        }

        if (!query || query.trim().length < 2) {
            return [];
        }

        try {
            // Enhanced search with multiple strategies
            const results = this.performMultiStrategySearch(query);

            // Process and enhance results
            const enhancedResults = this.enhanceResults(results, query);

            // Apply filters
            const filteredResults = this.applyFilters(enhancedResults, filters);

            // Group and rank results
            const groupedResults = this.groupResultsByDocument(filteredResults, query);

            return groupedResults.slice(0, maxResults);

        } catch (_error) {
            return [];
        }
    }

    /**
     * Apply filters to search results
     * Supports both new schema (topic, audience) and legacy (category, persona) filter names
     * Handles dynamic facet filters
     */
    applyFilters(results, filters) {
        return results.filter(result => {
            // Topic filter (new) or category filter (legacy)
            const topicFilter = filters.topic || filters.category;
            if (topicFilter && topicFilter !== '') {
                const docTopics = this.getDocumentTopics(result);
                if (!docTopics.includes(topicFilter)) {
                    return false;
                }
            }

            // Tag filter
            if (filters.tag && filters.tag !== '') {
                const docTags = this.getDocumentTags(result);
                if (!docTags.includes(filters.tag)) {
                    return false;
                }
            }

            // Document type filter (using actual frontmatter content_type)
            if (filters.type && filters.type !== '') {
                if (result.content_type !== filters.type) {
                    return false;
                }
            }

            // Audience filter (new) or persona filter (legacy)
            const audienceFilter = filters.audience || filters.persona;
            if (audienceFilter && audienceFilter !== '') {
                const docAudience = this.getDocumentAudience(result);
                if (!docAudience.includes(audienceFilter)) {
                    return false;
                }
            }

            // Difficulty filter
            if (filters.difficulty && filters.difficulty !== '') {
                if (result.difficulty !== filters.difficulty) {
                    return false;
                }
            }

            // Dynamic facet filters (e.g., filters.facets = { modality: 'text-only', framework: 'pytorch' })
            if (filters.facets && typeof filters.facets === 'object') {
                for (const [facetKey, facetValue] of Object.entries(filters.facets)) {
                    if (facetValue && facetValue !== '') {
                        const docFacetValue = this.getDocumentFacet(result, facetKey);
                        if (!docFacetValue.includes(facetValue)) {
                            return false;
                        }
                    }
                }
            }

            // Legacy flat facet filters (e.g., filters.modality directly)
            // Check for any filter key that matches a known facet
            for (const facetKey of Object.keys(this.facets)) {
                if (filters[facetKey] && filters[facetKey] !== '') {
                    const docFacetValue = this.getDocumentFacet(result, facetKey);
                    if (!docFacetValue.includes(filters[facetKey])) {
                        return false;
                    }
                }
            }

            return true;
        });
    }

    /**
     * Get a specific facet value for a document
     */
    getDocumentFacet(doc, facetKey) {
        // Check nested facets object first
        if (doc.facets && doc.facets[facetKey]) {
            const value = doc.facets[facetKey];
            return Array.isArray(value) ? value : [value];
        }
        // Check flat field (legacy)
        if (doc[facetKey]) {
            const value = doc[facetKey];
            return Array.isArray(value) ? value : [value];
        }
        return [];
    }

    /**
     * Get topics for a document (supports new schema and legacy categories)
     */
    getDocumentTopics(doc) {
        const topics = [];

        // From explicit topics (new schema) or categories (legacy)
        const topicsField = doc.topics || doc.categories;
        if (topicsField) {
            if (Array.isArray(topicsField)) {
                topics.push(...topicsField);
            } else {
                topics.push(...topicsField.split(',').map(t => t.trim()));
            }
        }

        // From section path
        if (doc.section_path && Array.isArray(doc.section_path)) {
            topics.push(...doc.section_path);
        }

        // From document ID path
        if (doc.id) {
            const pathParts = doc.id.split('/').filter(part => part && part !== 'index');
            topics.push(...pathParts);
        }

        return [...new Set(topics)]; // Remove duplicates
    }

    /**
     * Get categories for a document (legacy alias for getDocumentTopics)
     */
    getDocumentCategories(doc) {
        return this.getDocumentTopics(doc);
    }

    /**
     * Get tags for a document
     */
    getDocumentTags(doc) {
        if (!doc.tags) return [];

        if (Array.isArray(doc.tags)) {
            // Handle array of tags that might contain space-separated strings
            const flatTags = [];
            doc.tags.forEach(tag => {
                if (typeof tag === 'string' && tag.includes(' ')) {
                    // Split space-separated tags
                    tag.split(' ').forEach(individualTag => {
                        if (individualTag.trim()) {
                            flatTags.push(individualTag.trim());
                        }
                    });
                } else if (tag && tag.trim()) {
                    flatTags.push(tag.trim());
                }
            });
            return flatTags;
        }

        // Handle string tags - check for both comma and space separation
        if (typeof doc.tags === 'string') {
            const allTags = [];
            const tagString = doc.tags.trim();

            if (tagString.includes(',')) {
                // Comma-separated tags
                tagString.split(',').forEach(tag => {
                    if (tag.trim()) {
                        allTags.push(tag.trim());
                    }
                });
            } else {
                // Space-separated tags
                tagString.split(' ').forEach(tag => {
                    if (tag.trim()) {
                        allTags.push(tag.trim());
                    }
                });
            }

            return allTags;
        }

        return [];
    }


    /**
     * Get audience for a document (supports new schema and legacy personas)
     */
    getDocumentAudience(doc) {
        // Support both audience (new) and personas (legacy)
        const audienceField = doc.audience || doc.personas;
        if (!audienceField) return [];

        if (Array.isArray(audienceField)) {
            return audienceField;
        }

        return [audienceField];
    }

    /**
     * Get personas for a document (legacy alias for getDocumentAudience)
     */
    getDocumentPersonas(doc) {
        return this.getDocumentAudience(doc);
    }

    /**
     * Perform search with multiple strategies
     */
    performMultiStrategySearch(query) {
        const strategies = [
            // Exact phrase search with wildcards
            `"${query}" ${query}*`,
            // Fuzzy search with wildcards
            `${query}* ${query}~2`,
            // Individual terms with boost
            query.split(/\s+/).map(term => `${term}*`).join(' '),
            // Fallback: just the query
            query
        ];

        let allResults = [];
        const seenIds = new Set();

        for (const strategy of strategies) {
            try {
                const results = this.index.search(strategy);

                // Add new results (avoid duplicates)
                results.forEach(result => {
                    if (!seenIds.has(result.ref)) {
                        seenIds.add(result.ref);
                        allResults.push({
                            ...result,
                            strategy: strategy
                        });
                    }
                });

                // If we have enough good results, stop
                if (allResults.length >= 30) break;

            } catch (strategyError) {
                console.warn(`Search strategy failed: ${strategy}`, strategyError);
            }
        }

        return allResults;
    }

    /**
     * Enhance search results with document data and apply re-ranking
     */
    enhanceResults(results, query) {
        const queryLower = query.toLowerCase().trim();
        const queryTerms = queryLower.split(/\s+/);

        return results.map(result => {
            const doc = this.documents[result.ref];
            if (!doc) {
                console.warn(`Document not found: ${result.ref}`);
                return null;
            }

            // Calculate additional relevance boost for title matches
            const titleBoost = this.calculateTitleBoost(doc, queryLower, queryTerms);
            const keywordBoost = this.calculateKeywordBoost(doc, queryTerms);
            const descriptionBoost = this.calculateDescriptionBoost(doc, queryTerms);

            // Apply boosts to base score
            const enhancedScore = result.score * (1 + titleBoost + keywordBoost + descriptionBoost);

            return {
                ...doc,
                score: enhancedScore,
                baseScore: result.score,
                titleBoost,
                keywordBoost,
                descriptionBoost,
                matchedTerms: Object.keys(result.matchData?.metadata || {}),
                matchData: result.matchData,
                strategy: result.strategy
            };
        }).filter(Boolean); // Remove null results
    }

    /**
     * Calculate boost for title matches
     * Heavily rewards exact and partial title matches
     */
    calculateTitleBoost(doc, queryLower, queryTerms) {
        if (!doc.title) return 0;

        const titleLower = doc.title.toLowerCase();
        let boost = 0;

        // Exact title match (highest boost)
        if (titleLower === queryLower) {
            boost += 10;
        }
        // Title starts with query
        else if (titleLower.startsWith(queryLower)) {
            boost += 8;
        }
        // Query is a significant part of title (e.g., "audit" in "Documentation Audit Guide")
        else if (titleLower.includes(queryLower)) {
            // Boost more if query is a larger portion of the title
            const ratio = queryLower.length / titleLower.length;
            boost += 5 * ratio + 3;
        }
        // All query terms appear in title
        else if (queryTerms.every(term => titleLower.includes(term))) {
            boost += 4;
        }
        // Some query terms appear in title
        else {
            const matchingTerms = queryTerms.filter(term => titleLower.includes(term));
            if (matchingTerms.length > 0) {
                boost += 2 * (matchingTerms.length / queryTerms.length);
            }
        }

        // Additional boost if title contains query as a distinct word
        const titleWords = titleLower.split(/[\s\-_:]+/);
        if (titleWords.some(word => word === queryLower || word.startsWith(queryLower))) {
            boost += 2;
        }

        return boost;
    }

    /**
     * Calculate boost for keyword matches
     */
    calculateKeywordBoost(doc, queryTerms) {
        if (!doc.keywords) return 0;

        const keywords = Array.isArray(doc.keywords)
            ? doc.keywords.map(k => k.toLowerCase())
            : doc.keywords.toLowerCase().split(/[\s,]+/);

        let boost = 0;

        queryTerms.forEach(term => {
            if (keywords.some(kw => kw === term || kw.startsWith(term))) {
                boost += 1.5;
            }
        });

        return boost;
    }

    /**
     * Calculate boost for description matches
     */
    calculateDescriptionBoost(doc, queryTerms) {
        if (!doc.description) return 0;

        const descLower = doc.description.toLowerCase();
        let boost = 0;

        // Check if query terms appear early in description
        queryTerms.forEach(term => {
            const pos = descLower.indexOf(term);
            if (pos !== -1) {
                // Boost more if term appears early
                boost += pos < 50 ? 1 : 0.5;
            }
        });

        return boost;
    }

    /**
     * Group results by document and find matching sections
     */
    groupResultsByDocument(results, query) {
        const grouped = new Map();

        results.forEach(result => {
            const docId = result.id;

            if (!grouped.has(docId)) {
                // Find matching sections within this document
                const matchingSections = this.findMatchingSections(result, query);

                grouped.set(docId, {
                    ...result,
                    matchingSections,
                    totalMatches: 1,
                    combinedScore: result.score
                });
            } else {
                // Document already exists, combine scores and sections
                const existing = grouped.get(docId);
                const additionalSections = this.findMatchingSections(result, query);

                existing.matchingSections = this.mergeSections(existing.matchingSections, additionalSections);
                existing.totalMatches += 1;
                existing.combinedScore = Math.max(existing.combinedScore, result.score);
            }
        });

        // Convert map to array and sort by combined score
        return Array.from(grouped.values())
            .sort((a, b) => b.combinedScore - a.combinedScore);
    }

    /**
     * Find matching sections within a document
     */
    findMatchingSections(result, query) {
        const matchingSections = [];
        const queryTerms = query.toLowerCase().split(/\s+/);

        // Check if title matches
        if (result.title) {
            const titleText = result.title.toLowerCase();
            const hasMatch = queryTerms.some(term => titleText.includes(term));

            if (hasMatch) {
                matchingSections.push({
                    type: 'title',
                    text: result.title,
                    level: 1,
                    anchor: ''
                });
            }
        }

        // Check headings for matches
        if (result.headings && Array.isArray(result.headings)) {
            result.headings.forEach(heading => {
                const headingText = heading.text?.toLowerCase() || '';
                const hasMatch = queryTerms.some(term => headingText.includes(term));

                if (hasMatch) {
                    matchingSections.push({
                        type: 'heading',
                        text: heading.text,
                        level: heading.level || 2,
                        anchor: this.generateAnchor(heading.text)
                    });
                }
            });
        }

        // If no specific sections found, add a general content match
        if (matchingSections.length === 0) {
            matchingSections.push({
                type: 'content',
                text: 'Content match',
                level: 0,
                anchor: ''
            });
        }

        return matchingSections;
    }

    /**
     * Generate anchor link similar to how Sphinx does it
     */
    generateAnchor(headingText) {
        if (!headingText) return '';

        return headingText
            .toLowerCase()
            .replace(/[^\w\s-]/g, '')  // Remove special chars
            .replace(/\s+/g, '-')      // Replace spaces with hyphens
            .trim();
    }

    /**
     * Merge sections, avoiding duplicates
     */
    mergeSections(existing, additional) {
        const merged = [...existing];

        additional.forEach(section => {
            const isDuplicate = existing.some(existingSection =>
                existingSection.text === section.text &&
                existingSection.type === section.type
            );

            if (!isDuplicate) {
                merged.push(section);
            }
        });

        return merged;
    }

    /**
     * Get search statistics
     */
    getStatistics() {
        // Count facet keys and total values
        const facetStats = {};
        Object.entries(this.facets).forEach(([key, valueSet]) => {
            facetStats[key] = valueSet.size;
        });

        return {
            documentsIndexed: Object.keys(this.documents).length,
            topicsAvailable: this.topics.size,
            tagsAvailable: this.tags.size,
            documentTypesAvailable: this.documentTypes.size,
            audienceAvailable: this.audience.size,
            difficultiesAvailable: this.difficulties.size,
            facetsDiscovered: Object.keys(this.facets).length,
            facetStats: facetStats,
            isInitialized: this.isInitialized
        };
    }

    /**
     * Check if the search engine is ready
     */
    isReady() {
        return this.isInitialized && this.index !== null;
    }
}

// Make SearchEngine available globally
window.SearchEngine = SearchEngine;
