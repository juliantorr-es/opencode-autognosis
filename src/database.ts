import { Database, type Statement } from "bun:sqlite";
import * as path from "node:path";
import * as fs from "node:fs";
import { tool } from "@opencode-ai/plugin";
import {
    type ChunkCard,
    type BackgroundJob,
    type PerformanceMetric,
    type BoardPost,
    type BoardReply,
    type AgentProfile,
    type RunEval
} from "./services/schemas.js";
import { ollama, DEFAULT_EMBEDDING_MODEL } from "./services/ollama.js";
import { mlxService } from "./services/mlx.js";
import { tui } from "./services/tui.js";
import { Logger } from "./services/logger.js";
import { PolicyModule } from "./services/policy.js";

const PROJECT_ROOT = process.cwd();
const OPENCODE_DIR = path.join(PROJECT_ROOT, ".opencode");
const DB_PATH = path.join(OPENCODE_DIR, "autognosis.db");

export interface ToolContract {
  id: number;
  trigger_tool: string;
  trigger_action: string;
  target_tool: string;
  target_args: string;
  condition_script?: string;
}

export class CodeGraphDB {
  private db: Database;
  private workerRunning: boolean = false;
  private workerTimeout: Timer | null = null;

  // Typed Prepared Statements
  private stmts: {
    insertFile: Statement;
    insertChunk: Statement;
    insertSymbol: Statement;
    insertDep: Statement;
    insertCall: Statement;
    queueEmbedding: Statement;
    getJob: Statement;
    updateJobBase: string;
    logAccess: Statement;
    insertMetric: Statement;
    deleteSymbols: Statement;
    deleteDeps: Statement;
    deleteCalls: Statement;
  };

  constructor() {
    if (!fs.existsSync(OPENCODE_DIR)) {
      fs.mkdirSync(OPENCODE_DIR, { recursive: true });
    }
    this.db = new Database(DB_PATH, { create: true });
    this.runMigrations();
    this.reconcileWorkers();
    this.stmts = this.prepareStatements();
    this.startWorker();
  }

  private runMigrations() {
    const res = this.db.query("PRAGMA user_version").get() as any;
    const currentVersion = typeof res === 'object' ? res.user_version : res;
    
    const migrationDir = path.join(PROJECT_ROOT, "src", "db", "migrations");
    if (!fs.existsSync(migrationDir)) return;

    const migrations = fs.readdirSync(migrationDir)
      .filter(f => f.endsWith(".sql"))
      .sort();

    for (let i = 0; i < migrations.length; i++) {
      const version = i + 1;
      if (version > currentVersion) {
        const sql = fs.readFileSync(path.join(migrationDir, migrations[i]), "utf-8");
        this.db.transaction(() => {
          this.db.exec(sql);
          this.db.exec(`PRAGMA user_version = ${version}`);
        })();
        Logger.log("Database", `Applied migration ${migrations[i]} (v${version})`);
      }
    }
  }

  private prepareStatements(): any {
    return {
      insertFile: this.db.prepare("INSERT INTO files (path, hash, last_indexed) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(path) DO UPDATE SET hash = excluded.hash, last_indexed = CURRENT_TIMESTAMP RETURNING id"),
      insertChunk: this.db.prepare("INSERT INTO chunks (id, file_id, type, complexity_score, content_summary, parent_id) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET complexity_score = excluded.complexity_score, content_summary = excluded.content_summary, parent_id = excluded.parent_id"),
      insertSymbol: this.db.prepare("INSERT INTO symbols (chunk_id, name, kind) VALUES (?, ?, 'unknown')"),
      insertDep: this.db.prepare("INSERT INTO dependencies (source_chunk_id, target_path) VALUES (?, ?)"),
      insertCall: this.db.prepare("INSERT INTO calls (caller_chunk_id, callee_name, line_number) VALUES (?, ?, ?)"),
      queueEmbedding: this.db.prepare("INSERT INTO embedding_queue (chunk_id, text_to_embed) VALUES (?, ?) ON CONFLICT(chunk_id) DO UPDATE SET text_to_embed = excluded.text_to_embed, status = 'pending', retries = 0"),
      getJob: this.db.prepare("SELECT * FROM background_jobs WHERE id = ?"),
      updateJobBase: "UPDATE background_jobs SET ",
      logAccess: this.db.prepare("INSERT INTO context_access_log (chunk_id, plan_id) VALUES (?, ?)"),
      insertMetric: this.db.prepare("INSERT INTO performance_metrics (operation, duration_ms, memory_usage_mb, success, error) VALUES (?, ?, ?, ?, ?)"),
      deleteSymbols: this.db.prepare('DELETE FROM symbols WHERE chunk_id = ?'),
      deleteDeps: this.db.prepare('DELETE FROM dependencies WHERE source_chunk_id = ?'),
      deleteCalls: this.db.prepare('DELETE FROM calls WHERE caller_chunk_id = ?'),
    };
  }

  public registerWorker(pid: number, runId: string, command: string) {
    this.db.prepare("INSERT INTO worker_registry (pid, run_id, command, cwd) VALUES (?, ?, ?, ?) ON CONFLICT(pid) DO UPDATE SET run_id = excluded.run_id, status = 'alive', last_heartbeat = CURRENT_TIMESTAMP").run(pid, runId, command, PROJECT_ROOT);
  }

  public reconcileWorkers() {
    const workers = this.db.prepare("SELECT * FROM worker_registry WHERE status = 'alive'").all() as any[];
    for (const w of workers) {
        try {
            process.kill(w.pid, 0); 
        } catch {
            this.db.prepare("UPDATE worker_registry SET status = 'stale' WHERE pid = ?").run(w.pid);
        }
    }
  }

  public stopAllWorkers() {
    const workers = this.db.prepare("SELECT pid FROM worker_registry WHERE status = 'alive'").all() as { pid: number }[];
    for (const w of workers) {
      try {
        process.kill(w.pid, 'SIGTERM');
        setTimeout(() => { try { process.kill(w.pid, 'SIGKILL'); } catch {} }, 2000);
      } catch {}
    }
    this.db.prepare("UPDATE worker_registry SET status = 'terminated' WHERE status = 'alive'").run();
  }

  public uninstall() {
    this.close();
    const pathsToRemove = [
        path.join(PROJECT_ROOT, ".opencode", "chunks"),
        path.join(PROJECT_ROOT, ".opencode", "cache"),
        path.join(PROJECT_ROOT, ".opencode", "metrics"),
        path.join(PROJECT_ROOT, ".opencode", "performance"),
        path.join(PROJECT_ROOT, ".opencode", "autognosis.db"),
        path.join(PROJECT_ROOT, ".opencode", "autognosis.db-shm"),
        path.join(PROJECT_ROOT, ".opencode", "autognosis.db-wal")
    ];
    for (const p of pathsToRemove) {
        if (fs.existsSync(p)) {
            if (fs.lstatSync(p).isDirectory()) fs.rmSync(p, { recursive: true });
            else fs.unlinkSync(p);
        }
    }
    return "Autognosis uninstalled cleanly. No haunted state remains.";
  }

  public close() {
    this.stopWorker();
    this.db.close();
  }

  public pragma(sql: string) {
    return this.db.query(sql).all();
  }

  public registerContract(triggerTool: string, triggerAction: string, targetTool: string, targetArgs: any) {
    this.db.prepare("INSERT INTO tool_contracts (trigger_tool, trigger_action, target_tool, target_args) VALUES (?, ?, ?, ?)").run(triggerTool, triggerAction, targetTool, JSON.stringify(targetArgs));
  }

  public getContracts(triggerTool: string, triggerAction: string): ToolContract[] {
    return this.db.prepare("SELECT * FROM tool_contracts WHERE trigger_tool = ? AND (trigger_action = ? OR trigger_action IS NULL)").all(triggerTool, triggerAction) as ToolContract[];
  }

  public createJob(id: string, type: string, metadata?: any): void {
    this.db.prepare("INSERT INTO background_jobs (id, type, status, progress, result) VALUES (?, ?, 'pending', 0, ?)").run(id, type, metadata ? JSON.stringify(metadata) : null);
  }

  public updateJob(id: string, updates: { status?: string, progress?: number, result?: string, error?: string }): void {
    const sets: string[] = [];
    const params: any[] = [];
    if (updates.status) { sets.push("status = ?"); params.push(updates.status); }
    if (updates.progress !== undefined) { sets.push("progress = ?"); params.push(updates.progress); }
    if (updates.result) { sets.push("result = ?"); params.push(updates.result); }
    if (updates.error) { sets.push("error = ?"); params.push(updates.error); }
    sets.push("updated_at = CURRENT_TIMESTAMP");
    params.push(id);
    this.db.prepare(this.stmts.updateJobBase + sets.join(", ") + " WHERE id = ?").run(...params);
  }

  public getJob(id: string): BackgroundJob | undefined { 
    return this.stmts.getJob.get(id) as BackgroundJob | undefined; 
  }

  public listJobs(type?: string, limit: number = 10): BackgroundJob[] {
    if (type) return this.db.prepare("SELECT * FROM background_jobs WHERE type = ? ORDER BY created_at DESC LIMIT ?").all(type, limit) as BackgroundJob[];
    return this.db.prepare("SELECT * FROM background_jobs ORDER BY created_at DESC LIMIT ?").all(limit) as BackgroundJob[];
  }

  public recordMetric(metric: PerformanceMetric): void {
    this.stmts.insertMetric.run(metric.operation, metric.duration_ms, metric.memory_usage_mb, metric.success ? 1 : 0, metric.error || null);
  }

  public createPost(post: BoardPost) {
    this.db.prepare(`
      INSERT INTO board_posts (id, title, type, body, status, agent_id, git_hash, evidence_ids)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      post.id, 
      post.title, 
      post.type, 
      post.body, 
      post.status, 
      post.author.agent_id, 
      post.author.git_hash ?? null, 
      JSON.stringify(post.evidence_ids)
    );
  }

  public addReply(reply: BoardReply) {
    this.db.prepare(`
      INSERT INTO board_replies (id, post_id, type, body, agent_id, git_hash, evidence_ids)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      reply.id, 
      reply.post_id, 
      reply.type, 
      reply.body, 
      reply.author.agent_id, 
      reply.author.git_hash ?? null, 
      JSON.stringify(reply.evidence_ids || [])
    );
  }

  public queryBoard(filters: { type?: string, status?: string, agent_id?: string, limit?: number }) {
    let sql = "SELECT * FROM board_posts WHERE 1=1";
    const params: any[] = [];
    if (filters.type) { sql += " AND type = ?"; params.push(filters.type); }
    if (filters.status) { sql += " AND status = ?"; params.push(filters.status); }
    if (filters.agent_id) { sql += " AND agent_id = ?"; params.push(filters.agent_id); }
    sql += " ORDER BY created_at DESC LIMIT ?";
    params.push(filters.limit || 20);
    return this.db.prepare(sql).all(...params) as any[];
  }

  public getAgentProfile(agentId: string): AgentProfile {
    const profile = this.db.prepare("SELECT * FROM agent_profiles WHERE agent_id = ?").get(agentId) as any;
    if (!profile) {
        const newProfile: AgentProfile = {
            id: `prof-${Date.now()}`,
            agent_id: agentId,
            rank: "bronze",
            mmr: 1000,
            streak: 0,
            probation: false,
            stats: { verified_fixes: 0, regressions: 0, evidence_score_avg: 0 },
            allowed_tools: ["code_search", "code_read", "code_status"],
            created_at: new Date().toISOString()
        };
        this.db.prepare("INSERT INTO agent_profiles (id, agent_id, stats, allowed_tools) VALUES (?, ?, ?, ?)").run(newProfile.id, newProfile.agent_id, JSON.stringify(newProfile.stats), JSON.stringify(newProfile.allowed_tools));
        return newProfile;
    }
    return {
        ...profile,
        stats: JSON.parse(profile.stats),
        allowed_tools: JSON.parse(profile.allowed_tools),
        probation: !!profile.probation
    };
  }

  public updateAgentMMR(runEval: RunEval) {
    const profile = this.getAgentProfile(runEval.agent_id);
    const newMmr = PolicyModule.calculateNewMMR(profile.mmr, runEval);
    const newRank = PolicyModule.determineRank(newMmr);
    const tools = PolicyModule.getAllowedTools(newRank);

    this.db.prepare("UPDATE agent_profiles SET mmr = ?, rank = ?, allowed_tools = ? WHERE agent_id = ?")
      .run(newMmr, newRank, JSON.stringify(tools), runEval.agent_id);
    
    this.db.prepare("INSERT INTO run_evals (id, run_id, agent_id, score, breakdown, reasons, evidence_ids, mmr_delta) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(runEval.id, runEval.run_id, runEval.agent_id, runEval.score, JSON.stringify(runEval.breakdown), JSON.stringify(runEval.reasons), JSON.stringify(runEval.evidence_ids), runEval.mmr_delta);
  }

  public getBoardDigest() {
    const posts = this.db.prepare(`
      SELECT type, title, status, agent_id 
      FROM board_posts 
      WHERE status = 'open' OR type = 'decision' 
      ORDER BY created_at DESC LIMIT 5
    `).all() as any[];
    
    if (posts.length === 0) return "No active board items.";
    
    return posts.map(p => `[${p.type.toUpperCase()}] ${p.title} (${p.status}) - by ${p.agent_id}`).join("\n");
  }

  public acquireLock(resourceId: string, agentName: string, ttlSeconds: number = 300) {
    const current = this.isLocked(resourceId);
    if (current && current.owner_agent !== agentName) throw new Error("Resource " + resourceId + " is already locked by " + current.owner_agent);
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
    this.db.prepare("INSERT INTO locks (resource_id, owner_agent, expires_at) VALUES (?, ?, ?) ON CONFLICT(resource_id) DO UPDATE SET owner_agent = excluded.owner_agent, expires_at = excluded.expires_at").run(resourceId, agentName, expiresAt);
  }

  public releaseLock(resourceId: string, agentName: string) { 
    this.db.prepare("DELETE FROM locks WHERE resource_id = ? AND owner_agent = ?").run(resourceId, agentName); 
  }

  public isLocked(resourceId: string) {
    this.db.prepare("DELETE FROM locks WHERE expires_at < CURRENT_TIMESTAMP").run();
    return this.db.prepare("SELECT * FROM locks WHERE resource_id = ?").get(resourceId) as { owner_agent: string, expires_at: string } | undefined;
  }

  public listLocks() { return this.db.prepare("SELECT * FROM locks").all() as any[]; } 

  public storeIntent(patchId: string, reasoning: string, planId: string) { 
    this.db.prepare("INSERT INTO intents (patch_id, reasoning, plan_id) VALUES (?, ?, ?) ON CONFLICT(patch_id) DO UPDATE SET reasoning = excluded.reasoning, plan_id = excluded.plan_id").run(patchId, reasoning, planId); 
  }

  public getIntent(patchId: string) { return this.db.prepare("SELECT * FROM intents WHERE patch_id = ?").get(patchId); }

  public addArchRule(source: string, target: string) { 
    this.db.prepare("INSERT INTO arch_rules (source_pattern, target_pattern) VALUES (?, ?)").run(source, target); 
  }

  public checkArchViolation(sourcePath: string, targetPath: string) {
    const rules = this.db.prepare("SELECT * FROM arch_rules").all() as any[];
    for (const rule of rules) if (sourcePath.includes(rule.source_pattern) && targetPath.includes(rule.target_pattern)) return rule;
    return null;
  }
  
  public logAccess(chunkId: string, planId: string = 'adhoc') {
    this.stmts.logAccess.run(chunkId, planId);
  }
  
  public getLruChunks(limit: number = 5) {
    return this.db.prepare(`
      SELECT DISTINCT chunk_id 
      FROM context_access_log 
      ORDER BY accessed_at ASC 
      LIMIT ?
    `).all(limit) as { chunk_id: string }[];
  }
  
  private async startWorker() {
    if (this.workerRunning) return;
    this.workerRunning = true;
    const loop = async () => {
        try { await this.processEmbeddingQueue(); } catch (e) {}
        if (this.workerRunning) this.workerTimeout = setTimeout(loop, 10000);
    };
    this.workerTimeout = setTimeout(loop, 5000);
  }

  public stopWorker() {
      this.workerRunning = false;
      if (this.workerTimeout) { clearTimeout(this.workerTimeout); this.workerTimeout = null; }
  }

  private async processEmbeddingQueue() {
    const useMLX = await mlxService.checkAvailability();
    const useOllama = !useMLX && (await ollama.isRunning());
    if (!useMLX && !useOllama) return;
    const task = this.db.prepare("SELECT chunk_id, text_to_embed, retries FROM embedding_queue WHERE status = 'pending' ORDER BY rowid ASC LIMIT 1").get() as { chunk_id: string; text_to_embed: string; retries: number } | undefined;
    if (!task) return;
    this.db.prepare("UPDATE embedding_queue SET status = 'processing' WHERE chunk_id = ?").run(task.chunk_id);
    try {
      const vector = useMLX ? await mlxService.getEmbedding(task.text_to_embed) : await ollama.getEmbedding(task.text_to_embed);
      if (vector.length > 0) {
        const buffer = Buffer.from(new Float32Array(vector).buffer);
        const updateChunk = this.db.prepare("UPDATE chunks SET embedding = ? WHERE id = ?");
        const deleteQueue = this.db.prepare("DELETE FROM embedding_queue WHERE chunk_id = ?");
        this.db.transaction(() => { updateChunk.run(buffer, task.chunk_id); deleteQueue.run(task.chunk_id); })();
      } else { throw new Error("Empty vector"); }
    } catch (error) {
      if (task.retries > 3) this.db.prepare("UPDATE embedding_queue SET status = 'failed' WHERE chunk_id = ?").run(task.chunk_id);
      else this.db.prepare("UPDATE embedding_queue SET status = 'pending', retries = retries + 1 WHERE chunk_id = ?").run(task.chunk_id);
    }
  }

  public ingestChunkCard(card: ChunkCard) {
    this.db.transaction(() => {
      const fileRes = this.stmts.insertFile.get(card.file_path, card.metadata.hash) as { id: number };
      const fileId = fileRes.id;
      
      this.stmts.insertChunk.run(
        card.id, 
        fileId, 
        card.chunk_type, 
        card.metadata.complexity_score,
        card.content.slice(0, 500),
        card.parent_id || null
      );

      const textToEmbed = card.chunk_type.toUpperCase() + " for " + path.basename(card.file_path) + "\n\n" + card.content.slice(0, 2000);
      this.stmts.queueEmbedding.run(card.id, textToEmbed);
      
      this.stmts.deleteSymbols.run(card.id);
      for (const sym of card.metadata.symbols) this.stmts.insertSymbol.run(card.id, sym);
      
      this.stmts.deleteDeps.run(card.id);
      for (const dep of card.metadata.dependencies) this.stmts.insertDep.run(card.id, dep);
      
      this.stmts.deleteCalls.run(card.id);
      if (card.metadata.calls) {
        for (const call of card.metadata.calls) this.stmts.insertCall.run(card.id, call.name, call.line);
      }
    })();
  }

  public findCallers(functionName: string) { 
    return this.db.prepare("SELECT DISTINCT f.path, cl.line_number FROM files f JOIN chunks c ON f.id = c.file_id JOIN calls cl ON c.id = cl.caller_chunk_id WHERE cl.callee_name = ?").all(functionName) as { path: string, line_number: number }[]; 
  } 

  public deleteChunkCard(cardId: string) { this.db.prepare('DELETE FROM chunks WHERE id = ?').run(cardId); } 

  public recordExecution(planId: string | undefined, toolName: string, args: any, isOnPlan: boolean) { 
    this.db.prepare("INSERT INTO plan_ledger (plan_id, tool_name, args, is_on_plan) VALUES (?, ?, ?, ?)").run(planId || 'no-plan', toolName, JSON.stringify(args), isOnPlan ? 1 : 0); 
  }

  public ingestCommits(commits: any[]) {
    const insert = this.db.prepare("INSERT INTO commits (hash, author, date, message, files_touched) VALUES (?, ?, ?, ?, ?) ON CONFLICT(hash) DO NOTHING");
    this.db.transaction((data: any[]) => { for (const c of data) insert.run(c.hash, c.author, c.date, c.message, JSON.stringify(c.files)); })(commits);
  }

  public getHotFiles(pathPrefix: string = '', limit: number = 10) {
    const recent = this.db.prepare("SELECT files_touched FROM commits ORDER BY date DESC LIMIT 100").all() as { files_touched: string }[];
    const counts: Record<string, number> = {};
    for (const r of recent) { 
        try { 
            const files = JSON.parse(r.files_touched); 
            for (const f of files) if (f.startsWith(pathPrefix)) counts[f] = (counts[f] || 0) + 1; 
        } catch {} 
    }
    return Object.entries(counts).map(([path, count]) => ({ path, count })).sort((a, b) => b.count - a.count).slice(0, limit);
  }

  public getPlanMetrics(planId: string) {
    const total = this.db.prepare("SELECT COUNT(*) as c FROM plan_ledger WHERE plan_id = ?").get(planId) as { c: number };
    const onPlan = this.db.prepare("SELECT COUNT(*) as c FROM plan_ledger WHERE plan_id = ? AND is_on_plan = 1").get(planId) as { c: number };
    const offPlan = this.db.prepare("SELECT COUNT(*) as c FROM plan_ledger WHERE plan_id = ? AND is_on_plan = 0").get(planId) as { c: number };
    return { total: total.c, on_plan: onPlan.c, off_plan: offPlan.c, compliance: total.c > 0 ? Math.round((onPlan.c / total.c) * 100) : 100 };
  }

  public findDependents(filePath: string): string[] {
    const query = this.db.prepare("SELECT DISTINCT f.path FROM files f JOIN chunks c ON f.id = c.file_id JOIN dependencies d ON c.id = d.source_chunk_id WHERE d.target_path LIKE ? OR d.target_path = ?");
    const basename = path.basename(filePath);
    return (query.all("%/" + basename, basename) as { path: string }[]).map(r => r.path);
  }

  public searchSymbols(query: string): any[] { 
    return this.db.prepare("SELECT s.name, c.type, f.path FROM symbols s JOIN chunks c ON s.chunk_id = c.id JOIN files f ON c.file_id = f.id WHERE s.name LIKE ? LIMIT 20").all("%" + query + "%"); 
  }

  public findAffectedTests(symbolName: string): string[] {
    const results = this.db.prepare("WITH RECURSIVE impact_tree(caller_chunk_id) AS (SELECT caller_chunk_id FROM calls WHERE callee_name = ? UNION SELECT c.caller_chunk_id FROM calls c JOIN impact_tree it ON c.callee_name IN (SELECT s.name FROM symbols s WHERE s.chunk_id = it.caller_chunk_id)) SELECT DISTINCT f.path FROM files f JOIN chunks c ON f.id = c.file_id JOIN impact_tree it ON c.id = it.caller_chunk_id WHERE f.path LIKE '%.test.%' OR f.path LIKE '%Tests.%' OR f.path LIKE 'test_%'").all(symbolName) as { path: string }[];
    return results.map(r => r.path);
  }

  public async semanticSearch(query: string, limit: number = 10): Promise<any[]> {
    if (!(await ollama.isRunning())) throw new Error("Ollama is not running.");
    const queryVec = await ollama.getEmbedding(query);
    if (queryVec.length === 0) return [];

    // TWO-PASS RAG: 
    // 1. Keyword search via FTS5
    const keywordMatches = this.db.prepare(`
      SELECT id, rank 
      FROM chunks_fts 
      WHERE chunks_fts MATCH ? 
      ORDER BY rank 
      LIMIT 100
    `).all(query) as { id: string; rank: number }[];

    let candidates;
    if (keywordMatches.length > 0) {
      const ids = keywordMatches.map(m => `'${m.id}'`).join(',');
      candidates = this.db.prepare(`
        SELECT c.id, c.content_summary, c.type, f.path, c.embedding 
        FROM chunks c 
        JOIN files f ON c.file_id = f.id 
        WHERE c.id IN (${ids}) AND c.embedding IS NOT NULL
      `).all() as { id: string; content_summary: string; type: string; path: string; embedding: Buffer }[];
    } else {
      candidates = this.db.prepare("SELECT c.id, c.content_summary, c.type, f.path, c.embedding FROM chunks c JOIN files f ON c.file_id = f.id WHERE c.embedding IS NOT NULL LIMIT 500").all() as { id: string; content_summary: string; type: string; path: string; embedding: Buffer }[];
    }

    const results = candidates.map(chunk => {
      const vector = new Float32Array(chunk.embedding.buffer, chunk.embedding.byteOffset, chunk.embedding.byteLength / 4);
      const vectorSimilarity = this.cosineSimilarity(Array.from(queryVec), vector);
      const kwMatch = keywordMatches.find(m => m.id === chunk.id);
      const keywordScore = kwMatch ? Math.abs(kwMatch.rank) : 0;
      return { 
        ...chunk, 
        similarity: (vectorSimilarity * 0.8) + (Math.min(0.2, keywordScore * 0.01)), 
        vectorSimilarity, 
        keywordScore, 
        embedding: undefined 
      };
    });

    return results.sort((a, b) => b.similarity - a.similarity).slice(0, limit);
  }

  private cosineSimilarity(vecA: number[], vecB: Float32Array): number {
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < vecA.length; i++) { dot += vecA[i] * vecB[i]; normA += vecA[i] * vecA[i]; normB += vecB[i] * vecB[i]; }
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  public getStats() {
    const files = this.db.prepare('SELECT COUNT(*) as c FROM files').get() as { c: number };
    const symbols = this.db.prepare('SELECT COUNT(*) as c FROM symbols').get() as { c: number };
    const chunks = this.db.prepare('SELECT COUNT(*) as c FROM chunks').get() as { c: number };
    const embedded = this.db.prepare('SELECT COUNT(*) as c FROM chunks WHERE embedding IS NOT NULL').get() as { c: number };
    const queue = this.db.prepare("SELECT COUNT(*) as c FROM embedding_queue WHERE status = 'pending'").get() as { c: number };
    return { files: files.c, chunks: chunks.c, symbols: symbols.c, embeddings: { completed: embedded.c, pending: queue.c } };
  }
}

let dbInstance: CodeGraphDB | null = null;
export function getDb(): CodeGraphDB {
  if (!dbInstance) dbInstance = new CodeGraphDB();
  return dbInstance;
}

export function closeDb() {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}

export function graphTools(): { [key: string]: any } {
  const agentName = process.env.AGENT_NAME || `agent-${process.pid}`;
  return {
    autognosis_setup_ai: tool({
        description: "Configure local AI capabilities (Ollama or MLX) in the background.",
        args: { provider: tool.schema.enum(["ollama", "mlx"]).optional().default("ollama"), model: tool.schema.string().optional().default(DEFAULT_EMBEDDING_MODEL) },
        async execute({ provider, model }) {
            const jobId = "job-setup-ai-" + Date.now();
            getDb().createJob(jobId, "setup", { provider, model });
            (async () => {
                try {
                    getDb().updateJob(jobId, { status: "running", progress: 10 });
                    await tui.showProgress("AI Setup", 10, "Initializing " + provider + "...");
                    if (provider === "mlx") {
                        await mlxService.setup();
                        getDb().updateJob(jobId, { status: "completed", progress: 100, result: "MLX is ready." });
                        await tui.showSuccess("AI Setup Complete", "MLX backend is ready.");
                    } else {
                        if (!(await ollama.isInstalled())) { await tui.showProgress("AI Setup", 20, "Downloading Ollama..."); await ollama.install(); }
                        getDb().updateJob(jobId, { progress: 40 });
                        await tui.showProgress("AI Setup", 40, "Starting Ollama server...");
                        await ollama.startServer();
                        getDb().updateJob(jobId, { progress: 60 });
                        await tui.showProgress("AI Setup", 60, "Pulling model: " + model + "...");
                        await ollama.pullModel(model);
                        getDb().updateJob(jobId, { status: "completed", progress: 100, result: "Ollama (" + model + ") is ready." });
                        await tui.showSuccess("AI Setup Complete", "Ollama (" + model + ") is ready.");
                    }
                } catch (error: any) { 
                    getDb().updateJob(jobId, { status: "failed", error: error.message });
                    await tui.showError("AI Setup Failed", error.message);
                }
            })();
            return JSON.stringify({ status: "STARTED", message: "AI Setup (" + provider + ") started in background.", job_id: jobId, instruction: "Use graph_background_status to check progress." }, null, 2);
        }
    }),
    graph_semantic_search: tool({
      description: "Search the codebase using natural language (Vector/Semantic Search).",
      args: { query: tool.schema.string(), limit: tool.schema.number().optional().default(10) },
      async execute({ query, limit }) {
        try { const results = await getDb().semanticSearch(query, limit); return JSON.stringify({ status: "SUCCESS", query, results }, null, 2); }
        catch (error) { return JSON.stringify({ status: "ERROR", message: String(error) }, null, 2); }
      }
    }),
    graph_query_dependents: tool({
      description: "Find all files that depend on a specific file.",
      args: { file_path: tool.schema.string() },
      async execute({ file_path }) {
        try { const dependents = getDb().findDependents(file_path); return JSON.stringify({ status: "SUCCESS", file_path, dependents, count: dependents.length }, null, 2); }
        catch (error) { return JSON.stringify({ status: "ERROR", message: String(error) }, null, 2); }
      }
    }),
    graph_search_symbols: tool({
      description: "Fast fuzzy search for symbols across the entire codebase index.",
      args: { query: tool.schema.string() },
      async execute({ query }) {
        try { const results = getDb().searchSymbols(query); return JSON.stringify({ status: "SUCCESS", query, results, count: results.length }, null, 2); }
        catch (error) { return JSON.stringify({ status: "ERROR", message: String(error) }, null, 2); }
      }
    }),
    graph_stats: tool({
      description: "Get statistics about the Code Graph Index.",
      args: {},
      async execute() {
        try { return JSON.stringify({ status: "SUCCESS", stats: getDb().getStats() }, null, 2); }
        catch (error) { return JSON.stringify({ status: "ERROR", message: String(error) }, null, 2); }
      }
    }),
    journal_build: tool({
      description: "Scan git history and populate the Change Journal.",
      args: { limit: tool.schema.number().optional().default(100) },
      async execute({ limit }) {
        try {
          const { execSync } = await import("node:child_process");
          const logOut = execSync('git log -n ' + limit + ' --pretty=format:"%H|%an|%ad|%s" --date=iso', { encoding: 'utf-8' });
          const commits = logOut.split('\n').filter(Boolean).map(line => {
            const [hash, author, date, message] = line.split('|');
            const files = execSync('git show --name-only --pretty="" ' + hash, { encoding: 'utf-8' }).split('\n').filter(Boolean);
            return { hash, author, date, message, files };
          });
          getDb().ingestCommits(commits);
          return JSON.stringify({ status: "SUCCESS", message: "Ingested " + commits.length + " commits." }, null, 2);
        } catch (error) { return JSON.stringify({ status: "ERROR", message: String(error) }, null, 2); }
      }
    }),
    journal_query_hot_files: tool({
      description: "Query the Change Journal for frequently changed files.",
      args: { path_prefix: tool.schema.string().optional().default(""), limit: tool.schema.number().optional().default(10) },
      async execute({ path_prefix, limit }) {
        try { return JSON.stringify({ status: "SUCCESS", hot_files: getDb().getHotFiles(path_prefix, limit) }, null, 2); }
        catch (error) { return JSON.stringify({ status: "ERROR", message: String(error) }, null, 2); }
      }
    }),
    graph_get_plan_metrics: tool({
      description: "Retrieve execution metrics for a specific plan ID.",
      args: { plan_id: tool.schema.string() },
      async execute({ plan_id }) {
        try { return JSON.stringify({ status: "SUCCESS", plan_id, metrics: getDb().getPlanMetrics(plan_id) }, null, 2); }
        catch (error) { return JSON.stringify({ status: "ERROR", message: String(error) }, null, 2); }
      }
    }),
    graph_background_status: tool({
      description: "Check status of background tasks (validation, setup, indexing).",
      args: { 
        job_id: tool.schema.string().optional(),
        type: tool.schema.enum(["validation", "setup", "indexing"]).optional(),
        limit: tool.schema.number().optional().default(5)
      },
      async execute({ job_id, type, limit }) {
        try {
          if (job_id) return JSON.stringify({ status: "SUCCESS", job: getDb().getJob(job_id) }, null, 2);
          return JSON.stringify({ status: "SUCCESS", jobs: getDb().listJobs(type, limit) }, null, 2);
        } catch (error) { return JSON.stringify({ status: "ERROR", message: String(error) }, null, 2); }
      }
    })
  };
}