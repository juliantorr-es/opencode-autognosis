import { tool } from "@opencode-ai/plugin";
import { exec } from "node:child_process";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import * as crypto from "node:crypto";
import { getDb } from "./database.js";
import { 
  CHUNK_DIR, 
  ensureChunkDir, 
  calculateHash, 
  calculateComplexity, 
  parseFileAST,
  generateSummaryChunk,
  generateApiChunk,
  generateInvariantChunk,
  extractDependencies,
  extractSymbolsFromAST,
  extractSymbols,
  type ChunkCard
} from "./chunk-cards.js";
import { Logger } from "./services/logger.js";
import { tui } from "./services/tui.js";

const execAsync = promisify(exec);
const PROJECT_ROOT = process.cwd();
const OPENCODE_DIR = path.join(PROJECT_ROOT, ".opencode");
const CACHE_DIR = path.join(OPENCODE_DIR, "cache");
const PERF_DIR = path.join(OPENCODE_DIR, "performance");
const METRICS_DIR = path.join(OPENCODE_DIR, "metrics");

// Internal logging
function log(message: string, data?: unknown) {
  Logger.log("Performance", message, data);
}

// =============================================================================
// TYPES AND INTERFACES
// =============================================================================

interface CacheEntry {
  key: string;
  value: any;
  metadata: {
    created_at: string;
    last_accessed: string;
    access_count: number;
    size_bytes: number;
    ttl_seconds?: number;
  };
}

interface PerformanceMetrics {
  operation: string;
  start_time: number;
  end_time: number;
  duration_ms: number;
  memory_usage_mb: number;
  cache_hits: number;
  cache_misses: number;
  success: boolean;
  error?: string;
}

interface IndexingState {
  last_indexed: string;
  files_processed: number;
  files_indexed: number;
  indexing_duration_ms: number;
  cache_status: "fresh" | "stale" | "rebuilding";
}

interface BackgroundTask {
  id: string;
  type: "indexing" | "caching" | "cleanup" | "analysis";
  status: "pending" | "running" | "completed" | "failed";
  progress: number;
  started_at?: string;
  completed_at?: string;
  error?: string;
  metadata: any;
}

// =============================================================================
// HELPERS
// =============================================================================

async function runCmd(cmd: string, cwd: string = PROJECT_ROOT, timeoutMs: number = 30000) {
  try {
    const { stdout, stderr } = await execAsync(cmd, { 
      cwd,
      maxBuffer: 10 * 1024 * 1024,
      timeout: timeoutMs
    });
    return { stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (error: any) {
    if (error.signal === 'SIGTERM' && error.code === undefined) {
      return { stdout: "", stderr: `Command timed out after ${timeoutMs}ms`, error, timedOut: true };
    }
    return { stdout: "", stderr: error.message, error };
  }
}

async function ensurePerfDirs() {
  await fs.mkdir(CACHE_DIR, { recursive: true });
  await fs.mkdir(PERF_DIR, { recursive: true });
  await fs.mkdir(METRICS_DIR, { recursive: true });
}

function generateCacheKey(operation: string, params: any): string {
  const paramHash = crypto.createHash('md5').update(JSON.stringify(params)).digest('hex');
  return `${operation}-${paramHash}`;
}

async function getCacheEntry(key: string): Promise<CacheEntry | null> {
  try {
    const cachePath = path.join(CACHE_DIR, `${key}.json`);
    if (!fsSync.existsSync(cachePath)) {
      return null;
    }
    
    const entry = JSON.parse(await fs.readFile(cachePath, 'utf-8'));
    
    // Check TTL if present
    if (entry.metadata.ttl_seconds) {
      const age = (Date.now() - new Date(entry.metadata.created_at).getTime()) / 1000;
      if (age > entry.metadata.ttl_seconds) {
        await fs.unlink(cachePath);
        return null;
      }
    }
    
    // Update access metadata
    entry.metadata.last_accessed = new Date().toISOString();
    entry.metadata.access_count++;
    await fs.writeFile(cachePath, JSON.stringify(entry, null, 2));
    
    return entry;
  } catch (error) {
    return null;
  }
}

async function setCacheEntry(key: string, value: any, ttlSeconds?: number): Promise<void> {
  try {
    const entry: CacheEntry = {
      key,
      value,
      metadata: {
        created_at: new Date().toISOString(),
        last_accessed: new Date().toISOString(),
        access_count: 1,
        size_bytes: JSON.stringify(value).length,
        ttl_seconds: ttlSeconds
      }
    };
    
    const cachePath = path.join(CACHE_DIR, `${key}.json`);
    await fs.writeFile(cachePath, JSON.stringify(entry, null, 2));
  } catch (error) {
    // Fail silently for cache errors
  }
}

async function recordMetrics(metrics: PerformanceMetrics): Promise<void> {
  try {
    const metricsPath = path.join(METRICS_DIR, `metrics-${Date.now()}.json`);
    await fs.writeFile(metricsPath, JSON.stringify(metrics, null, 2));
  } catch (error) {
    // Fail silently for metrics errors
  }
}

function measureMemoryUsage(): number {
  if (typeof process !== 'undefined' && process.memoryUsage) {
    return process.memoryUsage().heapUsed / 1024 / 1024; // MB
  }
  return 0;
}

// =============================================================================
// PERFORMANCE OPTIMIZATION TOOLS
// =============================================================================

export function performanceTools(): { [key: string]: any } {
  return {
    perf_incremental_index: tool({
      description: "Perform incremental re-indexing of the codebase. Only processes changed files since last index.",
      args: {
        force_full: tool.schema.boolean().optional().default(false).describe("Force full re-indexing instead of incremental"),
        parallel_workers: tool.schema.number().optional().default(4).describe("Number of parallel workers for indexing"),
        background: tool.schema.boolean().optional().default(false).describe("Run indexing in background")
      },
      async execute({ force_full, parallel_workers, background }) {
        log("Tool call: perf_incremental_index", { force_full, parallel_workers, background });
        
        const startTime = Date.now();
        const metrics: PerformanceMetrics = {
          operation: "incremental_index",
          start_time: startTime,
          end_time: 0,
          duration_ms: 0,
          memory_usage_mb: measureMemoryUsage(),
          cache_hits: 0,
          cache_misses: 0,
          success: false
        };
        
        try {
          await ensurePerfDirs();
          
          // Load indexing state
          const statePath = path.join(PERF_DIR, "indexing-state.json");
          let indexingState: IndexingState = {
            last_indexed: "1970-01-01T00:00:00.000Z",
            files_processed: 0,
            files_indexed: 0,
            indexing_duration_ms: 0,
            cache_status: "stale"
          };
          
          if (!force_full && fsSync.existsSync(statePath)) {
            indexingState = JSON.parse(await fs.readFile(statePath, 'utf-8'));
          }
          
          if (background) {
            // Create background task
            const taskId = `task-index-${Date.now()}`;
            const taskPath = path.join(PERF_DIR, `${taskId}.json`);
            
            const backgroundTask: BackgroundTask = {
              id: taskId,
              type: "indexing",
              status: "pending",
              progress: 0,
              metadata: {
                force_full,
                parallel_workers,
                started_at: new Date().toISOString()
              }
            };
            
            await fs.writeFile(taskPath, JSON.stringify(backgroundTask, null, 2));
            
            // Start background indexing (simplified for demo)
            setTimeout(() => runBackgroundIndexing(taskId, indexingState), 100);
            
            return JSON.stringify({
              status: "BACKGROUND_STARTED",
              task_id: taskId,
              message: "Incremental indexing started in background"
            }, null, 2);
          }
          
          // Get changed files
          const { stdout: gitStatus } = await runCmd("git status --porcelain");
          const { stdout: gitDiff } = await runCmd(`git diff --name-only --since="${indexingState.last_indexed}"`);
          
          const changedFiles = gitDiff.split('\n').filter(Boolean);
          const allFiles = await getAllSourceFiles();
          
          const filesToIndex = force_full ? allFiles : changedFiles.length > 0 ? changedFiles : allFiles.slice(0, 10); // Fallback to some files
          
          // Process files
          let filesProcessed = 0;
          let filesIndexed = 0;
          
          for (const file of filesToIndex) {
            try {
              filesProcessed++;
              
              // Check if file needs indexing
              const filePath = path.join(PROJECT_ROOT, file);
              if (!fsSync.existsSync(filePath)) continue;
              
              const stats = await fs.stat(filePath);
              const lastModified = stats.mtime.toISOString();
              
              if (!force_full && lastModified < indexingState.last_indexed) {
                continue;
              }
              
              // Index the file (simplified - would create chunk cards, etc.)
              await indexFile(filePath);
              filesIndexed++;
              
            } catch (error) {
              // Continue with other files
            }
          }
          
          // Update indexing state
          indexingState.last_indexed = new Date().toISOString();
          indexingState.files_processed += filesProcessed;
          indexingState.files_indexed += filesIndexed;
          indexingState.indexing_duration_ms = Date.now() - startTime;
          indexingState.cache_status = "fresh";
          
          await fs.writeFile(statePath, JSON.stringify(indexingState, null, 2));
          
          // Update metrics
          metrics.end_time = Date.now();
          metrics.duration_ms = metrics.end_time - metrics.start_time;
          metrics.success = true;
          await recordMetrics(metrics);
          
          return JSON.stringify({
            status: "SUCCESS",
            indexing: {
              mode: force_full ? "full" : "incremental",
              files_processed: filesProcessed,
              files_indexed: filesIndexed,
              duration_ms: Date.now() - startTime,
              cache_status: indexingState.cache_status
            },
            state: indexingState
          }, null, 2);
          
        } catch (error) {
          metrics.end_time = Date.now();
          metrics.duration_ms = metrics.end_time - metrics.start_time;
          metrics.success = false;
          metrics.error = error instanceof Error ? error.message : `${error}`;
          await recordMetrics(metrics);
          
          return JSON.stringify({
            status: "ERROR",
            message: error instanceof Error ? error.message : `${error}`
          }, null, 2);
        }
      }
    }),

    perf_cache_get: tool({
      description: "Retrieve a value from the performance cache with automatic hit/miss tracking.",
      args: {
        operation: tool.schema.string().describe("Operation type for cache key"),
        params: tool.schema.any().describe("Parameters for cache key generation")
      },
      async execute({ operation, params }) {
        log("Tool call: perf_cache_get", { operation, params });
        
        try {
          const cacheKey = generateCacheKey(operation, params);
          const entry = await getCacheEntry(cacheKey);
          
          if (entry) {
            return JSON.stringify({
              status: "HIT",
              cache_key: cacheKey,
              value: entry.value,
              metadata: entry.metadata
            }, null, 2);
          } else {
            return JSON.stringify({
              status: "MISS",
              cache_key: cacheKey,
              message: "Cache entry not found"
            }, null, 2);
          }
          
        } catch (error) {
          return JSON.stringify({
            status: "ERROR",
            message: error instanceof Error ? error.message : `${error}`
          }, null, 2);
        }
      }
    }),

    perf_cache_set: tool({
      description: "Store a value in the performance cache with optional TTL.",
      args: {
        operation: tool.schema.string().describe("Operation type for cache key"),
        params: tool.schema.any().describe("Parameters for cache key generation"),
        value: tool.schema.any().describe("Value to cache"),
        ttl_seconds: tool.schema.number().optional().describe("Time-to-live in seconds")
      },
      async execute({ operation, params, value, ttl_seconds }) {
        log("Tool call: perf_cache_set", { operation, params, ttl_seconds });
        
        try {
          const cacheKey = generateCacheKey(operation, params);
          await setCacheEntry(cacheKey, value, ttl_seconds);
          
          return JSON.stringify({
            status: "SUCCESS",
            cache_key: cacheKey,
            ttl_seconds,
            message: "Value cached successfully"
          }, null, 2);
          
        } catch (error) {
          return JSON.stringify({
            status: "ERROR",
            message: error instanceof Error ? error.message : `${error}`
          }, null, 2);
        }
      }
    }),

    perf_cache_cleanup: tool({
      description: "Clean up expired and stale cache entries to free memory.",
      args: {
        max_age_hours: tool.schema.number().optional().default(24).describe("Maximum age for cache entries"),
        max_size_mb: tool.schema.number().optional().default(100).describe("Maximum cache size in MB"),
        dry_run: tool.schema.boolean().optional().default(false).describe("Show what would be deleted without actually deleting")
      },
      async execute({ max_age_hours, max_size_mb, dry_run }) {
        log("Tool call: perf_cache_cleanup", { max_age_hours, max_size_mb, dry_run });
        
        try {
          await ensurePerfDirs();
          
          const files = await fs.readdir(CACHE_DIR);
          const now = Date.now();
          const maxAge = max_age_hours * 60 * 60 * 1000;
          
          let totalSize = 0;
          let expiredCount = 0;
          let oversizedCount = 0;
          const deletedFiles = [];
          
          for (const file of files) {
            if (file.endsWith('.json')) {
              const filePath = path.join(CACHE_DIR, file);
              const stats = await fs.stat(filePath);
              const age = now - stats.mtime.getTime();
              
              try {
                const entry = JSON.parse(await fs.readFile(filePath, 'utf-8'));
                totalSize += entry.metadata.size_bytes || 0;
                
                const shouldDelete = age > maxAge || totalSize > (max_size_mb * 1024 * 1024);
                
                if (shouldDelete) {
                  if (age > maxAge) expiredCount++;
                  else oversizedCount++;
                  
                  deletedFiles.push({
                    file,
                    reason: age > maxAge ? "expired" : "oversized",
                    size_bytes: entry.metadata.size_bytes || 0,
                    age_hours: age / (1000 * 60 * 60)
                  });
                  
                  if (!dry_run) {
                    await fs.unlink(filePath);
                  }
                }
              } catch (error) {
                // Remove corrupted files
                if (!dry_run) {
                  await fs.unlink(filePath);
                }
              }
            }
          }
          
          return JSON.stringify({
            status: "SUCCESS",
            cleanup: {
              dry_run,
              max_age_hours,
              max_size_mb,
              total_files: files.length,
              expired_files: expiredCount,
              oversized_files: oversizedCount,
              deleted_files: deletedFiles,
              total_size_mb: Math.round(totalSize / 1024 / 1024 * 100) / 100
            }
          }, null, 2);
          
        } catch (error) {
          return JSON.stringify({
            status: "ERROR",
            message: error instanceof Error ? error.message : `${error}`
          }, null, 2);
        }
      }
    }),

    perf_metrics_get: tool({
      description: "Retrieve performance metrics for analysis and monitoring.",
      args: {
        operation_filter: tool.schema.string().optional().describe("Filter by operation type (regex)"),
        time_range_hours: tool.schema.number().optional().default(24).describe("Time range in hours"),
        limit: tool.schema.number().optional().default(100).describe("Maximum number of metrics to return")
      },
      async execute({ operation_filter, time_range_hours, limit }) {
        log("Tool call: perf_metrics_get", { operation_filter, time_range_hours, limit });
        
        try {
          await ensurePerfDirs();
          
          const files = await fs.readdir(METRICS_DIR);
          const cutoffTime = Date.now() - (time_range_hours * 60 * 60 * 1000);
          const metrics = [];
          
          for (const file of files) {
            if (file.endsWith('.json')) {
              const filePath = path.join(METRICS_DIR, file);
              const stats = await fs.stat(filePath);
              
              if (stats.mtime.getTime() > cutoffTime) {
                try {
                  const metric = JSON.parse(await fs.readFile(filePath, 'utf-8'));
                  
                  // Apply operation filter if specified
                  if (operation_filter && !new RegExp(operation_filter).test(metric.operation)) {
                    continue;
                  }
                  
                  metrics.push(metric);
                } catch (error) {
                  // Skip corrupted files
                }
              }
            }
          }
          
          // Sort by start time (most recent first)
          metrics.sort((a, b) => b.start_time - a.start_time);
          
          // Apply limit
          const limitedMetrics = metrics.slice(0, limit);
          
          // Calculate summary statistics
          const summary = calculateMetricsSummary(limitedMetrics);
          
          return JSON.stringify({
            status: "SUCCESS",
            metrics: limitedMetrics,
            summary,
            filters: {
              operation_filter,
              time_range_hours,
              limit
            }
          }, null, 2);
          
        } catch (error) {
          return JSON.stringify({
            status: "ERROR",
            message: error instanceof Error ? error.message : `${error}`
          }, null, 2);
        }
      }
    }),

    perf_background_status: tool({
      description: "Check status of background tasks and operations.",
      args: {
        task_id: tool.schema.string().optional().describe("Specific task ID to check"),
        task_type: tool.schema.enum(["indexing", "caching", "cleanup", "analysis", "validation", "setup"]).optional().describe("Filter by task type")
      },
      async execute({ task_id, task_type }) {
        log("Tool call: perf_background_status", { task_id, task_type });
        
        try {
          const tasks = [];
          
          // 1. Check DB Jobs
          if (task_id) {
              const job = getDb().getJob(task_id);
              if (job) tasks.push(job);
          } else {
              const dbJobs = getDb().listJobs(task_type as string, 10);
              tasks.push(...dbJobs);
          }

          // 2. Check File-based tasks
          await ensurePerfDirs();
          const files = await fs.readdir(PERF_DIR);
          for (const file of files) {
            if (file.startsWith('task-') && file.endsWith('.json')) {
              try {
                const taskPath = path.join(PERF_DIR, file);
                const task = JSON.parse(await fs.readFile(taskPath, 'utf-8'));
                if (task_id && task.id !== task_id) continue;
                if (task_type && task.type !== task_type) continue;
                // Avoid duplication if already in DB (shouldn't happen with new ID scheme)
                if (!tasks.some(t => t.id === task.id)) {
                    tasks.push(task);
                }
              } catch (error) {}
            }
          }
          
          return JSON.stringify({
            status: "SUCCESS",
            tasks,
            total_count: tasks.length,
            filters: {
              task_id,
              task_type
            }
          }, null, 2);
          
        } catch (error) {
          return JSON.stringify({
            status: "ERROR",
            message: error instanceof Error ? error.message : `${error}`
          }, null, 2);
        }
      }
    }),

    perf_optimize_memory: tool({
      description: "Optimize memory usage for large codebases with intelligent caching and cleanup.",
      args: {
        aggressive: tool.schema.boolean().optional().default(false).describe("Use aggressive memory optimization"),
        target_memory_mb: tool.schema.number().optional().default(500).describe("Target memory usage in MB"),
        preserve_recent: tool.schema.boolean().optional().default(true).describe("Preserve recently accessed cache entries")
      },
      async execute({ aggressive, target_memory_mb, preserve_recent }) {
        log("Tool call: perf_optimize_memory", { aggressive, target_memory_mb, preserve_recent });
        
        try {
          await ensurePerfDirs();
          
          const currentMemory = measureMemoryUsage();
          const memoryReductionNeeded = Math.max(0, currentMemory - target_memory_mb);
          
          if (memoryReductionNeeded <= 0) {
            return JSON.stringify({
              status: "SUCCESS",
              message: "Memory usage already within target",
              current_memory_mb: currentMemory,
              target_memory_mb
            }, null, 2);
          }
          
          // Get all cache entries
          const cacheFiles = await fs.readdir(CACHE_DIR);
          const cacheEntries = [];
          
          for (const file of cacheFiles) {
            if (file.endsWith('.json')) {
              try {
                const filePath = path.join(CACHE_DIR, file);
                const entry = JSON.parse(await fs.readFile(filePath, 'utf-8'));
                cacheEntries.push({
                  file,
                  entry,
                  size_bytes: entry.metadata.size_bytes || 0,
                  last_accessed: new Date(entry.metadata.last_accessed).getTime(),
                  access_count: entry.metadata.access_count || 0
                });
              } catch (error) {
                // Remove corrupted files
                await fs.unlink(path.join(CACHE_DIR, file));
              }
            }
          }
          
          // Sort by priority (keep recently accessed and frequently used)
          cacheEntries.sort((a, b) => {
            const scoreA = (preserve_recent ? a.last_accessed : 0) + (a.access_count * 1000);
            const scoreB = (preserve_recent ? b.last_accessed : 0) + (b.access_count * 1000);
            return scoreB - scoreA;
          });
          
          // Remove entries until target is met
          let removedSize = 0;
          let removedCount = 0;
          const targetRemovalSize = memoryReductionNeeded * 1024 * 1024; // Convert to bytes
          
          for (let i = cacheEntries.length - 1; i >= 0; i--) {
            if (removedSize >= targetRemovalSize) break;
            
            const entry = cacheEntries[i];
            await fs.unlink(path.join(CACHE_DIR, entry.file));
            removedSize += entry.size_bytes;
            removedCount++;
          }
          
          // Force garbage collection if available
          if (global.gc) {
            global.gc();
          }
          
          const finalMemory = measureMemoryUsage();
          
          return JSON.stringify({
            status: "SUCCESS",
            optimization: {
              aggressive,
              target_memory_mb,
              preserve_recent,
              initial_memory_mb: currentMemory,
              final_memory_mb: finalMemory,
              memory_freed_mb: Math.round((currentMemory - finalMemory) * 100) / 100,
              cache_entries_removed: removedCount,
              cache_size_freed_mb: Math.round(removedSize / 1024 / 1024 * 100) / 100
            }
          }, null, 2);
          
        } catch (error) {
          return JSON.stringify({
            status: "ERROR",
            message: error instanceof Error ? error.message : `${error}`
          }, null, 2);
        }
      }
    })
  };
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

async function getAllSourceFiles(): Promise<string[]> {
  const extensions = ['.ts', '.js', '.tsx', '.jsx', '.py', '.go', '.rs', '.cpp', '.c'];
  const sourceFiles: string[] = [];
  
  async function scanDirectory(dir: string) {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      
      for (const entry of entries) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules') {
          continue;
        }
        
        const fullPath = path.join(dir, entry.name);
        
        if (entry.isDirectory()) {
          await scanDirectory(fullPath);
        } else if (extensions.includes(path.extname(entry.name))) {
          sourceFiles.push(path.relative(PROJECT_ROOT, fullPath));
        }
      }
    } catch (error) {
      // Skip directories we can't read
    }
  }
  
  await scanDirectory(PROJECT_ROOT);
  return sourceFiles;
}

export async function indexFile(filePath: string): Promise<void> {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    await ensureChunkDir();
    
    const ast = parseFileAST(filePath, content);
    const chunkTypes = ["summary", "api", "invariant"] as const;
    
    // Generate file hash for ID consistency
    const fileHash = calculateHash(filePath);

    for (const chunkType of chunkTypes) {
      const cardId = `${path.basename(filePath)}-${chunkType}-${fileHash.slice(0, 8)}`;
      const cardPath = path.join(CHUNK_DIR, `${cardId}.json`);
      
      let chunkContent = "";
      if (chunkType === "summary") chunkContent = await generateSummaryChunk(content, filePath, ast);
      else if (chunkType === "api") chunkContent = await generateApiChunk(content, filePath, ast);
      else if (chunkType === "invariant") chunkContent = await generateInvariantChunk(content, filePath, ast);
      
      const chunkCard: ChunkCard = {
        id: cardId,
        file_path: filePath,
        chunk_type: chunkType,
        content: chunkContent,
        metadata: {
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          hash: calculateHash(chunkContent),
          dependencies: await extractDependencies(content, ast, filePath),
          symbols: extractSymbolsFromAST(ast, content) || extractSymbols(content, filePath),
          complexity_score: calculateComplexity(content)
        }
      };
      
      await fs.writeFile(cardPath, JSON.stringify(chunkCard, null, 2));
      
      // Sync to SQLite Index
      getDb().ingestChunkCard(chunkCard);
    }
  } catch (error) {
    log(`Failed to index file ${filePath}`, error);
  }
}

async function runBackgroundIndexing(taskId: string, indexingState: IndexingState): Promise<void> {
  try {
    const taskPath = path.join(PERF_DIR, `${taskId}.json`);
    let task = JSON.parse(await fs.readFile(taskPath, 'utf-8'));
    
    // Update task status
    task.status = "running";
    task.started_at = new Date().toISOString();
    await fs.writeFile(taskPath, JSON.stringify(task, null, 2));
    
    // Determine files to index
    const force_full = task.metadata?.force_full || false;
    let filesToIndex: string[] = [];
    
    if (force_full) {
      filesToIndex = await getAllSourceFiles();
    } else {
      // For incremental, we try to use git diff. If that fails or returns empty,
      // we might default to all files or just recent ones. For robustness here:
      try {
        const { stdout: gitDiff } = await runCmd(`git diff --name-only --since="${indexingState.last_indexed}"`);
        const changedFiles = gitDiff.split('\n').filter(Boolean);
        if (changedFiles.length > 0) {
          filesToIndex = changedFiles;
        } else {
           // If no changes detected by git, maybe we don't need to do anything?
           // But if forced or state is stale, maybe we should.
           // For background task simplicity, if not full, and no git changes, we index nothing or check simple timestamps.
           // Let's rely on getAllSourceFiles filtering if we wanted robust check.
           // Here, we'll just check timestamps of all source files against last_indexed.
           const allFiles = await getAllSourceFiles();
           filesToIndex = [];
           for (const f of allFiles) {
              const fp = path.join(PROJECT_ROOT, f);
              if (fsSync.existsSync(fp)) {
                 const stats = await fs.stat(fp);
                 if (stats.mtime.toISOString() > indexingState.last_indexed) {
                   filesToIndex.push(f);
                 }
              }
           }
        }
      } catch (e) {
        // Fallback to full scan if git fails
        filesToIndex = await getAllSourceFiles();
      }
    }

    const total = filesToIndex.length;
    let processed = 0;

    if (total === 0) {
      task.progress = 100;
      task.status = "completed";
      task.completed_at = new Date().toISOString();
      await fs.writeFile(taskPath, JSON.stringify(task, null, 2));
      return;
    }

    for (const file of filesToIndex) {
      const filePath = path.join(PROJECT_ROOT, file);
      if (fsSync.existsSync(filePath)) {
        await indexFile(filePath);
      }
      processed++;
      
      // Update progress periodically
      if (processed % 5 === 0 || processed === total) {
        const progress = Math.round((processed / total) * 100);
        task.progress = progress;
        await fs.writeFile(taskPath, JSON.stringify(task, null, 2));
        
        // Stream to TUI
        await tui.showProgress("Codebase Indexing", progress, `Processing: ${file}`);
      }
    }
    
    // Complete task
    task.status = "completed";
    task.completed_at = new Date().toISOString();
    task.progress = 100;
    await fs.writeFile(taskPath, JSON.stringify(task, null, 2));
    await tui.showSuccess("Indexing Complete", `Processed ${total} files.`);
    
  } catch (error) {
    // Update task with error
    const taskPath = path.join(PERF_DIR, `${taskId}.json`);
    try {
        if (fsSync.existsSync(taskPath)) {
            const task = JSON.parse(await fs.readFile(taskPath, 'utf-8'));
            task.status = "failed";
            task.error = error instanceof Error ? error.message : `${error}`;
            task.completed_at = new Date().toISOString();
            await fs.writeFile(taskPath, JSON.stringify(task, null, 2));
        }
    } catch (writeError) {
        log("Failed to update task error state", writeError);
    }
  }
}

function calculateMetricsSummary(metrics: PerformanceMetrics[]) {
  if (metrics.length === 0) {
    return {
      total_operations: 0,
      success_rate: 0,
      avg_duration_ms: 0,
      avg_memory_mb: 0
    };
  }
  
  const successCount = metrics.filter(m => m.success).length;
  const totalDuration = metrics.reduce((sum, m) => sum + m.duration_ms, 0);
  const totalMemory = metrics.reduce((sum, m) => sum + m.memory_usage_mb, 0);
  
  return {
    total_operations: metrics.length,
    success_rate: Math.round((successCount / metrics.length) * 100),
    avg_duration_ms: Math.round(totalDuration / metrics.length),
    avg_memory_mb: Math.round(totalMemory / metrics.length * 100) / 100,
    operations_by_type: metrics.reduce((acc, m) => {
      acc[m.operation] = (acc[m.operation] || 0) + 1;
      return acc;
    }, {} as Record<string, number>)
  };
}