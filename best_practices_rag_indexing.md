# Best Practices: Codebase RAG & Indexing

## 1. Structural Chunking (AST-First)
### Industry Best Practice
*   **Semantic Boundaries:** Chunk code by logical units (classes, functions, methods) using AST parsers (tree-sitter, ast-grep) rather than line counts.
*   **Context Injection:** Each chunk should include its "ancestry" (e.g., "In Class X -> In Method Y") to preserve local context.

### Current Implementation Analysis
*   **Hybrid Approach:** The project uses `parseFileAST` and specific generators (`generateSummaryChunk`, etc.), which is a strong start.
*   **Flat Relationships:** Symbols and dependencies are stored, but the hierarchy isn't fully exploited during retrieval (semantic search is a flat cosine similarity).

## 2. Hierarchical Retrieval (Multi-Level RAG)
### Industry Best Practice
*   **Summary -> Detail:** Retrieve at the "Module Summary" level first to find the relevant file, then "drill down" into specific API or Implementation chunks.
*   **Vector + Keyword Hybrid:** Use BM25 or keyword matching alongside vector search to handle specific symbol lookups (like `AuthService`) which vectors often "fuzzy" too much.

### Current Implementation Analysis
*   **Flat Semantic Search:** `semanticSearch` in `database.ts` pulls all chunks into memory to calculate cosine similarity. This will crash on large repositories.
*   **Missing Hybrid Search:** It uses a manual `keywordScore` multiplier, but lacks a formal full-text search (FTS5) index in SQLite.

### Refinement Plan
1.  **FTS5 Integration:** Enable SQLite FTS5 for symbol and content search to supplement vector retrieval.
2.  **Hierarchical Navigation:** Update `graph_semantic_search` to prefer `module_summaries` as "entry points" before presenting raw chunks.
3.  **AST Metadata:** Enrich `ChunkCard` metadata with "Parent" IDs to allow agents to "traverse up" the code structure.
