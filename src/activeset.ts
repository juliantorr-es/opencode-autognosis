import { tool } from "@opencode-ai/plugin";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";

const PROJECT_ROOT = process.cwd();
const OPENCODE_DIR = path.join(PROJECT_ROOT, ".opencode");
const ACTIVESET_DIR = path.join(OPENCODE_DIR, "activesets");

// Internal logging
function log(message: string, data?: unknown) {
  console.error(`[ActiveSet] ${message}`, data || '');
}

// =============================================================================
// TYPES AND INTERFACES
// =============================================================================

interface ActiveSet {
  id: string;
  name: string;
  chunks: string[]; // Chunk card IDs
  context_window: number;
  priority: "high" | "medium" | "low";
  created_at: string;
  last_accessed: string;
  metadata: {
    description?: string;
    tags?: string[];
    session_id?: string;
    agent_id?: string;
  };
}

interface WorkingMemory {
  current_set: string | null;
  history: Array<{
    set_id: string;
    action: "created" | "loaded" | "updated" | "closed";
    timestamp: string;
  }>;
  capacity: number;
  usage: number;
}

// =============================================================================
// HELPERS
// =============================================================================

async function ensureActiveSetDir() {
  await fs.mkdir(ACTIVESET_DIR, { recursive: true });
}

function generateActiveSetId(): string {
  return `activeset-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
}

function calculateContextUsage(chunks: string[]): number {
  // Simple calculation - in real implementation this would consider actual chunk sizes
  return chunks.length * 100; // Assume 100 tokens per chunk
}

async function loadActiveSet(setId: string): Promise<ActiveSet | null> {
  try {
    const setPath = path.join(ACTIVESET_DIR, `${setId}.json`);
    if (!fsSync.existsSync(setPath)) {
      return null;
    }
    
    const content = await fs.readFile(setPath, 'utf-8');
    return JSON.parse(content);
  } catch (error) {
    return null;
  }
}

async function saveActiveSet(activeSet: ActiveSet): Promise<void> {
  const setPath = path.join(ACTIVESET_DIR, `${activeSet.id}.json`);
  await fs.writeFile(setPath, JSON.stringify(activeSet, null, 2));
}

async function loadWorkingMemory(): Promise<WorkingMemory> {
  const memoryPath = path.join(ACTIVESET_DIR, "working-memory.json");
  
  try {
    if (fsSync.existsSync(memoryPath)) {
      const content = await fs.readFile(memoryPath, 'utf-8');
      return JSON.parse(content);
    }
  } catch (error) {
    // Fall through to default
  }
  
  // Default working memory
  return {
    current_set: null,
    history: [],
    capacity: 10000, // 10k tokens capacity
    usage: 0
  };
}

async function saveWorkingMemory(memory: WorkingMemory): Promise<void> {
  const memoryPath = path.join(ACTIVESET_DIR, "working-memory.json");
  await fs.writeFile(memoryPath, JSON.stringify(memory, null, 2));
}

// =============================================================================
// ACTIVESET MANAGEMENT TOOLS
// =============================================================================

export function activeSetTools(): { [key: string]: any } {
  return {
    activeset_create: tool({
      description: "Create a new ActiveSet for working memory management. Organizes chunk cards for focused context.",
      args: {
        name: tool.schema.string().describe("Human-readable name for the ActiveSet"),
        chunk_ids: tool.schema.array(tool.schema.string()).optional().describe("Initial chunk card IDs to include"),
        context_window: tool.schema.number().optional().default(4000).describe("Maximum context window size in tokens"),
        priority: tool.schema.enum(["high", "medium", "low"]).optional().default("medium").describe("Priority level"),
        description: tool.schema.string().optional().describe("Optional description of the ActiveSet purpose"),
        tags: tool.schema.array(tool.schema.string()).optional().describe("Optional tags for categorization")
      },
      async execute({ name, chunk_ids, context_window, priority, description, tags }) {
        log("Tool call: activeset_create", { name, chunk_ids, context_window, priority });
        
        try {
          await ensureActiveSetDir();
          
          const activeSet: ActiveSet = {
            id: generateActiveSetId(),
            name,
            chunks: chunk_ids || [],
            context_window,
            priority,
            created_at: new Date().toISOString(),
            last_accessed: new Date().toISOString(),
            metadata: {
              description,
              tags,
              session_id: `session-${Date.now()}`,
              agent_id: "agent-4"
            }
          };
          
          // Save the ActiveSet
          await saveActiveSet(activeSet);
          
          // Update working memory
          const memory = await loadWorkingMemory();
          memory.history.push({
            set_id: activeSet.id,
            action: "created",
            timestamp: new Date().toISOString()
          });
          memory.current_set = activeSet.id;
          memory.usage = calculateContextUsage(activeSet.chunks);
          await saveWorkingMemory(memory);
          
          return JSON.stringify({
            status: "SUCCESS",
            activeset: activeSet,
            working_memory: {
              current_set: activeSet.id,
              usage: memory.usage,
              capacity: memory.capacity
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

    activeset_load: tool({
      description: "Load an existing ActiveSet into working memory. Makes it the current active context.",
      args: {
        set_id: tool.schema.string().describe("ActiveSet ID to load"),
        reset_access_time: tool.schema.boolean().optional().default(true).describe("Update last_accessed timestamp")
      },
      async execute({ set_id, reset_access_time }) {
        log("Tool call: activeset_load", { set_id, reset_access_time });
        
        try {
          const activeSet = await loadActiveSet(set_id);
          
          if (!activeSet) {
            return JSON.stringify({
              status: "NOT_FOUND",
              message: `ActiveSet not found: ${set_id}`
            }, null, 2);
          }
          
          // Update access time if requested
          if (reset_access_time) {
            activeSet.last_accessed = new Date().toISOString();
            await saveActiveSet(activeSet);
          }
          
          // Update working memory
          const memory = await loadWorkingMemory();
          memory.history.push({
            set_id: activeSet.id,
            action: "loaded",
            timestamp: new Date().toISOString()
          });
          memory.current_set = activeSet.id;
          memory.usage = calculateContextUsage(activeSet.chunks);
          await saveWorkingMemory(memory);
          
          return JSON.stringify({
            status: "SUCCESS",
            activeset: activeSet,
            working_memory: {
              current_set: activeSet.id,
              usage: memory.usage,
              capacity: memory.capacity
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

    activeset_add_chunks: tool({
      description: "Add chunk cards to the current ActiveSet. Manages context window capacity.",
      args: {
        chunk_ids: tool.schema.array(tool.schema.string()).describe("Chunk card IDs to add"),
        set_id: tool.schema.string().optional().describe("Specific ActiveSet ID (uses current if not provided)"),
        enforce_capacity: tool.schema.boolean().optional().default(true).describe("Enforce context window limits")
      },
      async execute({ chunk_ids, set_id, enforce_capacity }) {
        log("Tool call: activeset_add_chunks", { chunk_ids, set_id, enforce_capacity });
        
        try {
          // Determine which ActiveSet to use
          const memory = await loadWorkingMemory();
          const targetSetId = set_id || memory.current_set;
          
          if (!targetSetId) {
            return JSON.stringify({
              status: "ERROR",
              message: "No ActiveSet specified and no current ActiveSet loaded"
            }, null, 2);
          }
          
          const activeSet = await loadActiveSet(targetSetId);
          if (!activeSet) {
            return JSON.stringify({
              status: "NOT_FOUND",
              message: `ActiveSet not found: ${targetSetId}`
            }, null, 2);
          }
          
          // Check capacity constraints
          const newChunks = [...activeSet.chunks, ...chunk_ids];
          const newUsage = calculateContextUsage(newChunks);
          
          if (enforce_capacity && newUsage > activeSet.context_window) {
            return JSON.stringify({
              status: "CAPACITY_EXCEEDED",
              message: `Adding chunks would exceed context window. Current: ${calculateContextUsage(activeSet.chunks)}, Proposed: ${newUsage}, Limit: ${activeSet.context_window}`,
              current_usage: calculateContextUsage(activeSet.chunks),
              proposed_usage: newUsage,
              limit: activeSet.context_window
            }, null, 2);
          }
          
          // Add chunks (removing duplicates)
          const uniqueChunks = Array.from(new Set(newChunks));
          activeSet.chunks = uniqueChunks;
          activeSet.last_accessed = new Date().toISOString();
          
          await saveActiveSet(activeSet);
          
          // Update working memory if this is the current set
          if (memory.current_set === activeSet.id) {
            memory.usage = calculateContextUsage(activeSet.chunks);
            memory.history.push({
              set_id: activeSet.id,
              action: "updated",
              timestamp: new Date().toISOString()
            });
            await saveWorkingMemory(memory);
          }
          
          return JSON.stringify({
            status: "SUCCESS",
            activeset: activeSet,
            added_chunks: chunk_ids,
            total_chunks: activeSet.chunks.length,
            usage: {
              tokens: calculateContextUsage(activeSet.chunks),
              window: activeSet.context_window,
              utilization: `${Math.round((calculateContextUsage(activeSet.chunks) / activeSet.context_window) * 100)}%`
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

    activeset_remove_chunks: tool({
      description: "Remove chunk cards from the current ActiveSet.",
      args: {
        chunk_ids: tool.schema.array(tool.schema.string()).describe("Chunk card IDs to remove"),
        set_id: tool.schema.string().optional().describe("Specific ActiveSet ID (uses current if not provided)")
      },
      async execute({ chunk_ids, set_id }) {
        log("Tool call: activeset_remove_chunks", { chunk_ids, set_id });
        
        try {
          // Determine which ActiveSet to use
          const memory = await loadWorkingMemory();
          const targetSetId = set_id || memory.current_set;
          
          if (!targetSetId) {
            return JSON.stringify({
              status: "ERROR",
              message: "No ActiveSet specified and no current ActiveSet loaded"
            }, null, 2);
          }
          
          const activeSet = await loadActiveSet(targetSetId);
          if (!activeSet) {
            return JSON.stringify({
              status: "NOT_FOUND",
              message: `ActiveSet not found: ${targetSetId}`
            }, null, 2);
          }
          
          // Remove chunks
          const originalLength = activeSet.chunks.length;
          activeSet.chunks = activeSet.chunks.filter(chunkId => !chunk_ids.includes(chunkId));
          activeSet.last_accessed = new Date().toISOString();
          
          await saveActiveSet(activeSet);
          
          // Update working memory if this is the current set
          if (memory.current_set === activeSet.id) {
            memory.usage = calculateContextUsage(activeSet.chunks);
            memory.history.push({
              set_id: activeSet.id,
              action: "updated",
              timestamp: new Date().toISOString()
            });
            await saveWorkingMemory(memory);
          }
          
          return JSON.stringify({
            status: "SUCCESS",
            activeset: activeSet,
            removed_chunks: chunk_ids,
            removed_count: originalLength - activeSet.chunks.length,
            remaining_chunks: activeSet.chunks.length,
            usage: {
              tokens: calculateContextUsage(activeSet.chunks),
              window: activeSet.context_window,
              utilization: `${Math.round((calculateContextUsage(activeSet.chunks) / activeSet.context_window) * 100)}%`
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

    activeset_get_current: tool({
      description: "Get the currently loaded ActiveSet and working memory status.",
      args: {
        include_chunks: tool.schema.boolean().optional().default(true).describe("Include chunk details in response")
      },
      async execute({ include_chunks }) {
        log("Tool call: activeset_get_current", { include_chunks });
        
        try {
          const memory = await loadWorkingMemory();
          
          if (!memory.current_set) {
            return JSON.stringify({
              status: "NO_CURRENT_SET",
              working_memory: memory,
              message: "No ActiveSet currently loaded"
            }, null, 2);
          }
          
          const activeSet = await loadActiveSet(memory.current_set);
          if (!activeSet) {
            return JSON.stringify({
              status: "CURRENT_SET_NOT_FOUND",
              working_memory: memory,
              message: `Current ActiveSet not found: ${memory.current_set}`
            }, null, 2);
          }
          
          const response = {
            status: "SUCCESS",
            activeset: activeSet,
            working_memory: memory,
            usage: {
              tokens: calculateContextUsage(activeSet.chunks),
              window: activeSet.context_window,
              utilization: `${Math.round((calculateContextUsage(activeSet.chunks) / activeSet.context_window) * 100)}%`
            }
          };
          
          return JSON.stringify(response, null, 2);
          
        } catch (error) {
          return JSON.stringify({
            status: "ERROR",
            message: error instanceof Error ? error.message : `${error}`
          }, null, 2);
        }
      }
    }),

    activeset_list: tool({
      description: "List all available ActiveSets with optional filtering.",
      args: {
        priority_filter: tool.schema.enum(["high", "medium", "low"]).optional().describe("Filter by priority level"),
        limit: tool.schema.number().optional().default(20).describe("Maximum number of sets to return"),
        include_usage: tool.schema.boolean().optional().default(true).describe("Include usage statistics")
      },
      async execute({ priority_filter, limit, include_usage }) {
        log("Tool call: activeset_list", { priority_filter, limit, include_usage });
        
        try {
          await ensureActiveSetDir();
          
          const files = await fs.readdir(ACTIVESET_DIR);
          const activeSets = [];
          
          for (const file of files) {
            if (file.endsWith('.json') && file !== 'working-memory.json') {
              try {
                const setPath = path.join(ACTIVESET_DIR, file);
                const activeSet = JSON.parse(await fs.readFile(setPath, 'utf-8'));
                
                // Apply priority filter if specified
                if (priority_filter && activeSet.priority !== priority_filter) {
                  continue;
                }
                
                const setInfo = {
                  ...activeSet,
                  usage: include_usage ? {
                    tokens: calculateContextUsage(activeSet.chunks),
                    window: activeSet.context_window,
                    utilization: `${Math.round((calculateContextUsage(activeSet.chunks) / activeSet.context_window) * 100)}%`
                  } : undefined
                };
                
                activeSets.push(setInfo);
              } catch (error) {
                // Skip corrupted files
                continue;
              }
            }
          }
          
          // Sort by last accessed (most recent first)
          activeSets.sort((a, b) => new Date(b.last_accessed).getTime() - new Date(a.last_accessed).getTime());
          
          // Apply limit
          const limitedSets = activeSets.slice(0, limit);
          
          return JSON.stringify({
            status: "SUCCESS",
            activesets: limitedSets,
            total_count: activeSets.length,
            returned_count: limitedSets.length,
            filters: {
              priority: priority_filter,
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

    activeset_delete: tool({
      description: "Delete an ActiveSet. Cannot delete the currently loaded set.",
      args: {
        set_id: tool.schema.string().describe("ActiveSet ID to delete")
      },
      async execute({ set_id }) {
        log("Tool call: activeset_delete", { set_id });
        
        try {
          // Check if it's the current set
          const memory = await loadWorkingMemory();
          if (memory.current_set === set_id) {
            return JSON.stringify({
              status: "ERROR",
              message: "Cannot delete the currently loaded ActiveSet. Load a different set first."
            }, null, 2);
          }
          
          const setPath = path.join(ACTIVESET_DIR, `${set_id}.json`);
          if (!fsSync.existsSync(setPath)) {
            return JSON.stringify({
              status: "NOT_FOUND",
              message: `ActiveSet not found: ${set_id}`
            }, null, 2);
          }
          
          await fs.unlink(setPath);
          
          return JSON.stringify({
            status: "SUCCESS",
            message: `ActiveSet deleted: ${set_id}`
          }, null, 2);
          
        } catch (error) {
          return JSON.stringify({
            status: "ERROR",
            message: error instanceof Error ? error.message : `${error}`
          }, null, 2);
        }
      }
    }),

    activeset_close: tool({
      description: "Close the current ActiveSet (unload from working memory).",
      args: {
        clear_history: tool.schema.boolean().optional().default(false).describe("Clear working memory history")
      },
      async execute({ clear_history }) {
        log("Tool call: activeset_close", { clear_history });
        
        try {
          const memory = await loadWorkingMemory();
          
          if (!memory.current_set) {
            return JSON.stringify({
              status: "NO_CURRENT_SET",
              message: "No ActiveSet currently loaded"
            }, null, 2);
          }
          
          const closedSetId = memory.current_set;
          
          // Update working memory
          memory.history.push({
            set_id: closedSetId,
            action: "closed",
            timestamp: new Date().toISOString()
          });
          
          memory.current_set = null;
          memory.usage = 0;
          
          if (clear_history) {
            memory.history = [];
          }
          
          await saveWorkingMemory(memory);
          
          return JSON.stringify({
            status: "SUCCESS",
            closed_set: closedSetId,
            working_memory: memory
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