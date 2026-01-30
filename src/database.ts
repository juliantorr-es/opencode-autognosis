import Database from "better-sqlite3";
import * as path from "node:path";
import * as fs from "node:fs";
import { tool } from "@opencode-ai/plugin";
import type { ChunkCard } from "./chunk-cards.js";
import { ollama, DEFAULT_EMBEDDING_MODEL } from "./services/ollama.js";

const PROJECT_ROOT = process.cwd();
const OPENCODE_DIR = path.join(PROJECT_ROOT, ".opencode");
const DB_PATH = path.join(OPENCODE_DIR, "autognosis.db");

export class CodeGraphDB {
  private db: Database.Database;
  private workerRunning: boolean = false;

  constructor() {
    // Ensure directory exists
    if (!fs.existsSync(OPENCODE_DIR)) {
      fs.mkdirSync(OPENCODE_DIR, { recursive: true });
    }
    
    this.db = new Database(DB_PATH);
    this.initialize();
    
    // Start background worker
    this.startWorker();
  }

  private initialize() {
    // Enable WAL mode for concurrency and performance
    this.db.pragma('journal_mode = WAL');

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        path TEXT UNIQUE NOT NULL,
        hash TEXT,
        last_indexed DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS chunks (
        id TEXT PRIMARY KEY,
        file_id INTEGER,
        type TEXT,
        complexity_score REAL,
        content_summary TEXT,
        embedding BLOB,
        FOREIGN KEY(file_id) REFERENCES files(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS embedding_queue (
        chunk_id TEXT PRIMARY KEY,
        text_to_embed TEXT,
        status TEXT DEFAULT 'pending', -- pending, processing, failed
        retries INTEGER DEFAULT 0,
        FOREIGN KEY(chunk_id) REFERENCES chunks(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS symbols (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chunk_id TEXT,
        name TEXT NOT NULL,
        kind TEXT, -- 'function', 'class', 'interface', etc.
        FOREIGN KEY(chunk_id) REFERENCES chunks(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS dependencies (
        source_chunk_id TEXT,
        target_path TEXT,
        FOREIGN KEY(source_chunk_id) REFERENCES chunks(id) ON DELETE CASCADE
      );

      -- Indexes for performance
      CREATE INDEX IF NOT EXISTS idx_files_path ON files(path);
      CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
      CREATE INDEX IF NOT EXISTS idx_dependencies_target ON dependencies(target_path);
    `);

    // Migrations
    try { this.db.exec("ALTER TABLE chunks ADD COLUMN embedding BLOB"); } catch {}
  }

  private async startWorker() {
    if (this.workerRunning) return;
    this.workerRunning = true;
    
    // Run periodically
    setInterval(async () => {
      try {
        await this.processEmbeddingQueue();
      } catch (e) {
        // console.error("Worker error:", e);
      }
    }, 5000); // Check every 5s
  }

  private async processEmbeddingQueue() {
    // Check if Ollama is ready
    if (!(await ollama.isRunning())) return;

    // Get next task
    const task = this.db.prepare(`
      SELECT chunk_id, text_to_embed, retries 
      FROM embedding_queue 
      WHERE status = 'pending' 
      ORDER BY rowid ASC 
      LIMIT 1
    `).get() as { chunk_id: string; text_to_embed: string; retries: number } | undefined;

    if (!task) return;

    // Mark processing
    this.db.prepare("UPDATE embedding_queue SET status = 'processing' WHERE chunk_id = ?").run(task.chunk_id);

    try {
      // Generate embedding
      const vector = await ollama.getEmbedding(task.text_to_embed);
      
      if (vector.length > 0) {
        // Store blob (Float32Array to Buffer)
        const buffer = Buffer.from(new Float32Array(vector).buffer);
        
        const updateChunk = this.db.prepare("UPDATE chunks SET embedding = ? WHERE id = ?");
        const deleteQueue = this.db.prepare("DELETE FROM embedding_queue WHERE chunk_id = ?");
        
        const txn = this.db.transaction(() => {
          updateChunk.run(buffer, task.chunk_id);
          deleteQueue.run(task.chunk_id);
        });
        txn();
      } else {
        throw new Error("Empty vector returned");
      }
    } catch (error) {
      if (task.retries > 3) {
        // Give up
        this.db.prepare("UPDATE embedding_queue SET status = 'failed' WHERE chunk_id = ?").run(task.chunk_id);
      } else {
        // Retry
        this.db.prepare("UPDATE embedding_queue SET status = 'pending', retries = retries + 1 WHERE chunk_id = ?").run(task.chunk_id);
      }
    }
  }

  /**
   * Syncs a ChunkCard (JSON) into the SQLite Index.
   * This is an "Upsert" operation.
   */
  public ingestChunkCard(card: ChunkCard) {
    const insertFile = this.db.prepare(`
      INSERT INTO files (path, hash, last_indexed)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(path) DO UPDATE SET
        hash = excluded.hash,
        last_indexed = CURRENT_TIMESTAMP
      RETURNING id
    `);

    const insertChunk = this.db.prepare(`
      INSERT INTO chunks (id, file_id, type, complexity_score, content_summary)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        complexity_score = excluded.complexity_score,
        content_summary = excluded.content_summary
    `);

    const queueEmbedding = this.db.prepare(`
      INSERT INTO embedding_queue (chunk_id, text_to_embed)
      VALUES (?, ?)
      ON CONFLICT(chunk_id) DO UPDATE SET
        text_to_embed = excluded.text_to_embed,
        status = 'pending',
        retries = 0
    `);

    const insertSymbol = this.db.prepare(`
      INSERT INTO symbols (chunk_id, name, kind) VALUES (?, ?, 'unknown')
    `);

    const insertDep = this.db.prepare(`
      INSERT INTO dependencies (source_chunk_id, target_path) VALUES (?, ?)
    `);

    const deleteOldSymbols = this.db.prepare('DELETE FROM symbols WHERE chunk_id = ?');
    const deleteOldDeps = this.db.prepare('DELETE FROM dependencies WHERE source_chunk_id = ?');

    const transaction = this.db.transaction(() => {
      // 1. Upsert File
      const fileRes = insertFile.get(card.file_path, card.metadata.hash) as { id: number };
      const fileId = fileRes.id;

      // 2. Upsert Chunk
      insertChunk.run(
        card.id,
        fileId,
        card.chunk_type,
        card.metadata.complexity_score,
        card.content.slice(0, 500) // Store preview
      );

      // 3. Queue for Embedding
      // Use the summary or content as the text to embed
      const textToEmbed = `${card.chunk_type.toUpperCase()} for ${path.basename(card.file_path)}\n\n${card.content.slice(0, 2000)}`;
      queueEmbedding.run(card.id, textToEmbed);

      // 4. Replace Symbols
      deleteOldSymbols.run(card.id);
      for (const sym of card.metadata.symbols) {
        insertSymbol.run(card.id, sym);
      }

      // 5. Replace Dependencies
      deleteOldDeps.run(card.id);
      for (const dep of card.metadata.dependencies) {
        insertDep.run(card.id, dep);
      }
    });

    transaction();
  }

  /**
   * Remove a card from the index
   */
  public deleteChunkCard(cardId: string) {
    this.db.prepare('DELETE FROM chunks WHERE id = ?').run(cardId);
  }

  // ===========================================================================
  // QUERY METHODS
  // ===========================================================================

  public findDependents(filePath: string): string[] {
    // Find all chunks that depend on this file path
    // Note: dependency paths might be relative or absolute, simplistic matching for now
    const query = this.db.prepare(`
      SELECT DISTINCT f.path 
      FROM files f
      JOIN chunks c ON f.id = c.file_id
      JOIN dependencies d ON c.id = d.source_chunk_id
      WHERE d.target_path LIKE ? OR d.target_path = ?
    `);
    
    // Attempt to match exact path or likely relative imports (simplistic)
    const basename = path.basename(filePath);
    const results = query.all(`%/${basename}%`, basename) as { path: string }[];
    return results.map(r => r.path);
  }

  public searchSymbols(query: string): any[] {
    const stmt = this.db.prepare(`
      SELECT s.name, c.type, f.path 
      FROM symbols s
      JOIN chunks c ON s.chunk_id = c.id
      JOIN files f ON c.file_id = f.id
      WHERE s.name LIKE ?
      LIMIT 20
    `);
    return stmt.all(`%${query}%`);
  }

  public async semanticSearch(query: string, limit: number = 10): Promise<any[]> {
    if (!(await ollama.isRunning())) {
      throw new Error("Ollama is not running. Please run 'autognosis_setup_ai' first.");
    }

    const queryVec = await ollama.getEmbedding(query);
    if (queryVec.length === 0) return [];

    // Get all embeddings from DB
    // SQLite doesn't have vector math, so we fetch all and sort in JS
    // Optimizations: In future, use sqlite-vec or filter by complexity/type first
    const chunks = this.db.prepare(`
      SELECT c.id, c.content_summary, c.type, f.path, c.embedding
      FROM chunks c
      JOIN files f ON c.file_id = f.id
      WHERE c.embedding IS NOT NULL
    `).all() as { id: string; content_summary: string; type: string; path: string; embedding: Buffer }[];

    const results = chunks.map(chunk => {
      const vector = new Float32Array(chunk.embedding.buffer, chunk.embedding.byteOffset, chunk.embedding.byteLength / 4);
      const similarity = this.cosineSimilarity(queryVec, vector);
      return { ...chunk, similarity, embedding: undefined }; // Don't return blob
    });

    results.sort((a, b) => b.similarity - a.similarity);
    return results.slice(0, limit);
  }

  private cosineSimilarity(vecA: number[], vecB: Float32Array): number {
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < vecA.length; i++) {
      dot += vecA[i] * vecB[i];
      normA += vecA[i] * vecA[i];
      normB += vecB[i] * vecB[i];
    }
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
  }
  
  public getStats() {
    const files = this.db.prepare('SELECT COUNT(*) as c FROM files').get() as { c: number };
    const symbols = this.db.prepare('SELECT COUNT(*) as c FROM symbols').get() as { c: number };
    const deps = this.db.prepare('SELECT COUNT(*) as c FROM dependencies').get() as { c: number };
    const chunks = this.db.prepare('SELECT COUNT(*) as c FROM chunks').get() as { c: number };
    const embedded = this.db.prepare('SELECT COUNT(*) as c FROM chunks WHERE embedding IS NOT NULL').get() as { c: number };
    const queue = this.db.prepare("SELECT COUNT(*) as c FROM embedding_queue WHERE status = 'pending'").get() as { c: number };
    
    return {
      files: files.c,
      chunks: chunks.c,
      symbols: symbols.c,
      dependencies: deps.c,
      embeddings: {
        completed: embedded.c,
        pending: queue.c
      }
    };
  }
}

// Singleton instance for the plugin
let dbInstance: CodeGraphDB | null = null;

export function getDb(): CodeGraphDB {
  if (!dbInstance) {
    dbInstance = new CodeGraphDB();
  }
  return dbInstance;
}

export function graphTools(): { [key: string]: any } {
  return {
    autognosis_setup_ai: tool({
        description: "Configure local AI capabilities (Ollama). Checks installation, installs if needed, and pulls the embedding model.",
        args: {
            model: tool.schema.string().optional().default(DEFAULT_EMBEDDING_MODEL).describe("Embedding model to pull")
        },
        async execute({ model }) {
            try {
                const installed = await ollama.isInstalled();
                let statusMsg = "Ollama is installed.";
                
                if (!installed) {
                    statusMsg = await ollama.install();
                }
                
                await ollama.startServer();
                await ollama.pullModel(model);
                
                return JSON.stringify({
                    status: "SUCCESS",
                    message: `${statusMsg} Server is running. Model ${model} is ready.`,
                    config: {
                        model,
                        base_url: "http://127.0.0.1:11434"
                    }
                }, null, 2);
            } catch (error) {
                return JSON.stringify({ status: "ERROR", message: String(error) }, null, 2);
            }
        }
    }),

    graph_semantic_search: tool({
      description: "Search the codebase using natural language (Vector/Semantic Search). Requires AI setup.",
      args: {
        query: tool.schema.string().describe("Natural language query"),
        limit: tool.schema.number().optional().default(10).describe("Max results")
      },
      async execute({ query, limit }) {
        try {
          const results = await getDb().semanticSearch(query, limit);
          return JSON.stringify({
            status: "SUCCESS",
            query,
            results
          }, null, 2);
        } catch (error) {
          return JSON.stringify({ status: "ERROR", message: String(error) }, null, 2);
        }
      }
    }),

    graph_query_dependents: tool({
      description: "Find all files that depend on a specific file (upstream impact analysis).",
      args: {
        file_path: tool.schema.string().describe("File path to analyze"),
      },
      async execute({ file_path }) {
        try {
          const dependents = getDb().findDependents(file_path);
          return JSON.stringify({
            status: "SUCCESS",
            file_path,
            dependents,
            count: dependents.length
          }, null, 2);
        } catch (error) {
          return JSON.stringify({ status: "ERROR", message: String(error) }, null, 2);
        }
      }
    }),

    graph_search_symbols: tool({
      description: "Fast fuzzy search for symbols (functions, classes) across the entire codebase index.",
      args: {
        query: tool.schema.string().describe("Symbol name query"),
      },
      async execute({ query }) {
        try {
          const results = getDb().searchSymbols(query);
          return JSON.stringify({
            status: "SUCCESS",
            query,
            results,
            count: results.length
          }, null, 2);
        } catch (error) {
          return JSON.stringify({ status: "ERROR", message: String(error) }, null, 2);
        }
      }
    }),
    
    graph_stats: tool({
      description: "Get statistics about the Code Graph Index.",
      args: {},
      async execute() {
        try {
          const stats = getDb().getStats();
          return JSON.stringify({
            status: "SUCCESS",
            stats
          }, null, 2);
        } catch (error) {
          return JSON.stringify({ status: "ERROR", message: String(error) }, null, 2);
        }
      }
    })
  };
}
