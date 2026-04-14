/* global Utils, DocumentLoader, SearchEngine, SearchPageManager */
/**
 * Enhanced Search Main Entry Point
 * Loads search engine and page manager for enhanced search page
 * Does NOT interfere with default search behavior
 */

// Prevent multiple initializations
if (typeof window.EnhancedSearch !== 'undefined') {
    // already initialized
} else {

// Import modules (will be loaded dynamically)
class EnhancedSearch {
    constructor(options = {}) {
        this.options = {
            placeholder: options.placeholder || 'Search documentation...',
            maxResults: options.maxResults || 20,
            minQueryLength: 2,
            highlightClass: 'search-highlight',
            ...options
        };

        this.isLoaded = false;

        // Module instances
        this.documentLoader = null;
        this.searchEngine = null;
        this.searchPageManager = null;
        this.utils = null;

        this.init();
    }

    async init() {
        try {
            // Load required modules
            await this.loadModules();

            // Initialize core modules
            this.utils = new Utils();
            this.documentLoader = new DocumentLoader();
            this.searchEngine = new SearchEngine(this.utils);

            // Load documents and initialize search engine (always needed)
            await this.documentLoader.loadDocuments();
            await this.searchEngine.initialize(this.documentLoader.getDocuments());

            // Check if we're on the search page
            const isSearchPage = this.isSearchPage();

            if (isSearchPage) {
                this.searchPageManager = new SearchPageManager();
            }

            this.isLoaded = true;
        } catch (_error) {
            this.fallbackToDefaultSearch();
        }
    }

    isSearchPage() {
        return window.location.pathname.includes('/search') ||
               window.location.pathname.includes('/search.html') ||
               window.location.pathname.endsWith('search/') ||
               document.querySelector('#enhanced-search-page-input') !== null ||
               document.querySelector('#enhanced-search-page-results') !== null;
    }

    async loadModules() {
        const moduleNames = [
            'Utils',
            'DocumentLoader',
            'SearchEngine',
            'SearchPageManager'
        ];

        // Load modules with smart path resolution
        const modulePromises = moduleNames.map(name =>
            this.loadModuleWithFallback(name)
        );

        await Promise.all(modulePromises);
    }

    async loadModuleWithFallback(moduleName) {
        const possiblePaths = this.getModulePaths(moduleName);

        for (const path of possiblePaths) {
            try {
                await this.loadModule(path);
                return;
            } catch (_error) {
                // Continue to next path
            }
        }

        throw new Error(`Failed to load module ${moduleName} from any path`);
    }

    getModulePaths(moduleName) {
        const fileName = `${moduleName}.js`;

        // Calculate nesting level to determine correct _static path
        const pathParts = window.location.pathname.split('/').filter(part => part.length > 0);
        const htmlFile = pathParts[pathParts.length - 1];

        // Remove the HTML file from the count if it exists
        let nestingLevel = pathParts.length;
        if (htmlFile && htmlFile.endsWith('.html')) {
            nestingLevel--;
        }

        // Build the correct _static path based on nesting level
        const staticPrefix = nestingLevel > 0 ? '../'.repeat(nestingLevel) : './';
        const staticPath = `${staticPrefix}_static`;

        // Search assets only has modules directory
        const moduleDir = 'modules';

        // Generate paths in order of likelihood
        const paths = [];

        // 1. Most likely path based on calculated nesting
        paths.push(`${staticPath}/${moduleDir}/${fileName}`);

        // 2. Fallback static paths (for different nesting scenarios)
        paths.push(`_static/${moduleDir}/${fileName}`);
        paths.push(`./_static/${moduleDir}/${fileName}`);
        if (nestingLevel > 1) {
            paths.push(`../_static/${moduleDir}/${fileName}`);
        }

        // 3. Legacy fallback paths
        paths.push(`./modules/${fileName}`);
        paths.push(`../modules/${fileName}`);
        paths.push(`modules/${fileName}`);

        return paths;
    }

    async loadModule(src) {
        return new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = src;
            script.onload = resolve;
            script.onerror = () => reject(new Error(`Failed to load module: ${src}`));
            document.head.appendChild(script);
        });
    }

    // Public API methods
    search(query) {
        if (!this.searchEngine) {
            return [];
        }

        return this.searchEngine.search(query);
    }

    renderResults(_results, _query) {
        // Use SearchPageManager for search page rendering
        return '';
    }

    fallbackToDefaultSearch() {
        // Don't interfere with default search - just fallback
    }

    getDocuments() {
        return this.documentLoader ? this.documentLoader.getDocuments() : [];
    }

    get documents() {
        return this.getDocuments();
    }

    getSearchEngine() {
        return this.searchEngine;
    }

    getOptions() {
        return this.options;
    }
}

// Initialize the enhanced search system
window.EnhancedSearch = EnhancedSearch;

// Auto-initialize
document.addEventListener('DOMContentLoaded', function() {
    // Create the global instance
    window.enhancedSearchInstance = new EnhancedSearch({
        placeholder: 'Search NVIDIA documentation...',
        maxResults: 50
    });
});

} // End of duplicate prevention check
