/**
 * DocumentLoader Module
 * Handles loading and managing search documents from JSON index
 */

class DocumentLoader {
    constructor() {
        this.documents = {};
        this.isLoaded = false;
    }

    /**
     * Load documents from JSON index files
     */
    async loadDocuments() {
        try {
            const data = await this.fetchDocumentData();
            this.processDocuments(data);
            this.isLoaded = true;
            console.log(`✅ Document loader initialized with ${Object.keys(this.documents).length} documents`);
        } catch (error) {
            console.error('Failed to load search documents:', error);
            throw error;
        }
    }

    /**
     * Fetch document data from various possible paths
     */
    async fetchDocumentData() {
        // Try different paths to account for different page depths
        const possiblePaths = [
            './index.json',
            '../index.json',
            '../../index.json',
            '../../../index.json'
        ];

        for (const path of possiblePaths) {
            try {
                const response = await fetch(path);
                if (response.ok) {
                    const data = await response.json();
                    console.log(`✅ Loaded search index from: ${path}`);
                    return data;
                }
            } catch (error) {
                console.log(`❌ Failed to load from ${path}: ${error.message}`);
            }
        }

        throw new Error('Failed to load search data from any path');
    }

    /**
     * Process and filter documents from raw data
     * Supports three formats:
     * 1. Array of documents (new format): [{ id, title, ... }, ...]
     * 2. Object with children (legacy): { children: [...] }
     * 3. Single document (fallback): { id, title, ... }
     */
    processDocuments(data) {
        let allDocs;
        if (Array.isArray(data)) {
            // New format: root is an array of documents
            allDocs = data;
        } else if (data.children) {
            // Legacy format: object with children array
            allDocs = data.children;
        } else {
            // Fallback: single document
            allDocs = [data];
        }

        // Filter out problematic documents
        const filteredDocs = allDocs.filter(doc => this.isValidDocument(doc));

        // Store documents by ID
        filteredDocs.forEach(doc => {
            this.documents[doc.id] = this.sanitizeDocument(doc);
        });

        console.log(`Processed ${filteredDocs.length} documents (filtered from ${allDocs.length} total)`);
    }

    /**
     * Check if a document is valid for indexing
     */
    isValidDocument(doc) {
        const docId = doc.id || '';
        return !docId.toLowerCase().includes('readme') &&
               !docId.startsWith('_') &&
               doc.title &&
               doc.content;
    }

    /**
     * Sanitize document content for safe indexing
     * Supports both new schema fields and legacy fields
     * Preserves dynamic facets as-is
     */
    sanitizeDocument(doc) {
        const sanitized = {
            ...doc,
            title: this.sanitizeText(doc.title, 200),
            // Add description as separate indexed field (for improved search relevance)
            description: this.sanitizeText(doc.description, 300),
            description_agent: this.sanitizeText(doc.description_agent, 300),
            content: this.sanitizeText(doc.content, 5000),
            summary: this.sanitizeText(doc.summary, 500),
            headings: this.sanitizeHeadings(doc.headings),
            headings_text: this.sanitizeText(doc.headings_text, 1000),
            keywords: this.sanitizeArray(doc.keywords, 300),
            tags: this.sanitizeArray(doc.tags, 200),
            // Support both topics (new) and categories (legacy)
            topics: this.sanitizeArray(doc.topics || doc.categories, 200),
            // Support both audience (new) and personas (legacy)
            audience: this.sanitizeArray(doc.audience || doc.personas, 200),
            // Content type and difficulty
            content_type: this.sanitizeText(doc.content_type, 50),
            difficulty: this.sanitizeText(doc.difficulty, 50),
            doc_type: this.sanitizeText(doc.doc_type, 50),
            section_path: this.sanitizeArray(doc.section_path, 200),
            author: this.sanitizeText(doc.author, 100)
        };

        // Preserve facets object (dynamic, user-defined keys)
        if (doc.facets && typeof doc.facets === 'object') {
            sanitized.facets = this.sanitizeFacets(doc.facets);
        }

        // Preserve legacy flat modality if present and no facets.modality
        if (doc.modality && (!doc.facets || !doc.facets.modality)) {
            sanitized.modality = this.sanitizeText(doc.modality, 50);
        }

        return sanitized;
    }

    /**
     * Sanitize facets object (dynamic keys with string or array values)
     */
    sanitizeFacets(facets) {
        const sanitized = {};
        Object.entries(facets).forEach(([key, value]) => {
            if (Array.isArray(value)) {
                sanitized[key] = value.map(v => String(v).substring(0, 100));
            } else if (value) {
                sanitized[key] = String(value).substring(0, 100);
            }
        });
        return sanitized;
    }

    /**
     * Sanitize text content with length limits
     */
    sanitizeText(text, maxLength) {
        if (!text || typeof text !== 'string') return '';
        return text.substring(0, maxLength);
    }

    /**
     * Sanitize array content
     */
    sanitizeArray(arr, maxLength) {
        if (!Array.isArray(arr)) return [];
        return arr.map(item => String(item)).join(' ').substring(0, maxLength);
    }

    /**
     * Sanitize headings array
     */
    sanitizeHeadings(headings) {
        if (!Array.isArray(headings)) return [];
        return headings.map(heading => ({
            text: this.sanitizeText(heading.text, 200),
            level: Number(heading.level) || 1
        }));
    }

    /**
     * Get all loaded documents
     */
    getDocuments() {
        return this.documents;
    }

    /**
     * Get a specific document by ID
     */
    getDocument(id) {
        return this.documents[id];
    }

    /**
     * Get document count
     */
    getDocumentCount() {
        return Object.keys(this.documents).length;
    }

    /**
     * Check if documents are loaded
     */
    isReady() {
        return this.isLoaded && Object.keys(this.documents).length > 0;
    }

    /**
     * Get documents as array for indexing
     */
    getDocumentsArray() {
        return Object.values(this.documents);
    }

    /**
     * Filter documents by criteria
     */
    filterDocuments(filterFn) {
        return this.getDocumentsArray().filter(filterFn);
    }

    /**
     * Get document statistics
     */
    getStatistics() {
        const docs = this.getDocumentsArray();
        return {
            totalDocuments: docs.length,
            documentsWithSummary: docs.filter(d => d.summary).length,
            documentsWithHeadings: docs.filter(d => d.headings && d.headings.length > 0).length,
            documentsWithTags: docs.filter(d => d.tags && d.tags.length > 0).length,
            averageContentLength: docs.reduce((sum, d) => sum + (d.content?.length || 0), 0) / docs.length
        };
    }
}

// Make DocumentLoader available globally
window.DocumentLoader = DocumentLoader;
