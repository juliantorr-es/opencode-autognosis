import { tool } from "@opencode-ai/plugin";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { Logger } from "./services/logger.js";

const PROJECT_ROOT = process.cwd();
const OPENCODE_DIR = path.join(PROJECT_ROOT, ".opencode");
const CHUNK_DIR = path.join(OPENCODE_DIR, "chunks");
const MODULE_DIR = path.join(OPENCODE_DIR, "modules");

// Internal logging
function log(message: string, data?: unknown) {
  Logger.log("ModuleSummaries", message, data);
}

// =============================================================================
// TYPES AND INTERFACES
// =============================================================================

interface ChunkCard {
  id: string;
  file_path: string;
  chunk_type: "summary" | "api" | "invariant";
  content: string;
  metadata: {
    created_at: string;
    updated_at: string;
    hash: string;
    dependencies: string[];
    symbols: string[];
    complexity_score: number;
  };
}

interface ModuleSummary {
  module_id: string;
  file_path: string;
  chunk_cards: ChunkCard[];
  hierarchy: {
    summary_level: string;
    signature_level: string;
    implementation_level: string;
  };
  relationships: {
    imports: string[];
    exports: string[];
    dependents: string[];
  };
  metrics: {
    total_chunks: number;
    complexity_score: number;
    api_surface: number;
  };
  synthesis_metadata: {
    created_at: string;
    updated_at: string;
    version: string;
    synthesis_method: string;
  };
}

interface HierarchicalReasoning {
  module_id: string;
  reasoning_levels: {
    summary: {
      purpose: string;
      key_concepts: string[];
      high_level_structure: string;
    };
    signature: {
      public_api: string[];
      interfaces: string[];
      contracts: string[];
    };
    implementation: {
      internal_structure: string;
      algorithms: string[];
      data_flow: string;
    };
  };
  cross_references: {
    related_modules: string[];
    shared_symbols: string[];
    dependency_graph: string;
  };
}

// =============================================================================
// HELPERS
// =============================================================================

async function ensureModuleDir() {
  await fs.mkdir(MODULE_DIR, { recursive: true });
}

async function loadChunkCard(cardId: string): Promise<ChunkCard | null> {
  try {
    const cardPath = path.join(CHUNK_DIR, `${cardId}.json`);
    if (!fsSync.existsSync(cardPath)) {
      return null;
    }
    
    const content = await fs.readFile(cardPath, 'utf-8');
    return JSON.parse(content);
  } catch (error) {
    return null;
  }
}

async function findChunkCardsForFile(filePath: string): Promise<ChunkCard[]> {
  const cards: ChunkCard[] = [];
  
  try {
    const files = await fs.readdir(CHUNK_DIR);
    
    for (const file of files) {
      if (file.endsWith('.json')) {
        try {
          const cardPath = path.join(CHUNK_DIR, file);
          const card = JSON.parse(await fs.readFile(cardPath, 'utf-8'));
          
          if (card.file_path === filePath) {
            cards.push(card);
          }
        } catch (error) {
          // Skip corrupted files
          continue;
        }
      }
    }
  } catch (error) {
    // Return empty list if directory doesn't exist
  }
  
  return cards;
}

function generateModuleId(filePath: string): string {
  const relativePath = path.relative(PROJECT_ROOT, filePath);
  const hash = crypto.createHash('md5').update(relativePath).digest('hex').slice(0, 8);
  return `module-${relativePath.replace(/[^a-zA-Z0-9]/g, '-')}-${hash}`;
}

function calculateModuleMetrics(chunkCards: ChunkCard[]) {
  const totalChunks = chunkCards.length;
  const complexityScore = chunkCards.reduce((sum, card) => sum + card.metadata.complexity_score, 0) / totalChunks;
  const apiSurface = chunkCards.filter(card => card.chunk_type === 'api').length;
  
  return {
    total_chunks: totalChunks,
    complexity_score: Math.round(complexityScore * 100) / 100,
    api_surface: apiSurface
  };
}

function extractRelationships(chunkCards: ChunkCard[]) {
  const allDependencies = new Set<string>();
  const allExports = new Set<string>();
  const allSymbols = new Set<string>();
  
  chunkCards.forEach(card => {
    card.metadata.dependencies.forEach(dep => allDependencies.add(dep));
    card.metadata.symbols.forEach(symbol => allSymbols.add(symbol));
    
    // Extract exports from API chunks
    if (card.chunk_type === 'api') {
      const exports = extractExportsFromContent(card.content);
      exports.forEach(exp => allExports.add(exp));
    }
  });
  
  return {
    imports: Array.from(allDependencies),
    exports: Array.from(allExports),
    dependents: [] // Would need cross-module analysis to populate
  };
}

function extractExportsFromContent(content: string): string[] {
  const exports: string[] = [];
  
  // Match export statements
  const exportMatches = content.match(/export\s+(?:const|let|var|function|class|interface|type)\s+(\w+)/g);
  if (exportMatches) {
    exports.push(...exportMatches.map(match => match.split(/\s+/)[2]));
  }
  
  return exports;
}

function synthesizeHierarchy(chunkCards: ChunkCard[]) {
  const summaryCard = chunkCards.find(card => card.chunk_type === 'summary');
  const apiCard = chunkCards.find(card => card.chunk_type === 'api');
  const invariantCard = chunkCards.find(card => card.chunk_type === 'invariant');
  
  return {
    summary_level: summaryCard?.content || "No summary available",
    signature_level: apiCard?.content || "No API documentation available",
    implementation_level: invariantCard?.content || "No invariant analysis available"
  };
}

// =============================================================================
// MODULE SUMMARIES TOOLS
// =============================================================================

export function moduleSummariesTools(): { [key: string]: any } {
  return {
    module_synthesize: tool({
      description: "Synthesize a Module Summary from existing Chunk Cards. Creates hierarchical understanding of the module.",
      args: {
        file_path: tool.schema.string().describe("File path to synthesize module summary for"),
        force_resynthesize: tool.schema.boolean().optional().default(false).describe("Force re-synthesis even if summary exists"),
        include_reasoning: tool.schema.boolean().optional().default(true).describe("Include hierarchical reasoning analysis")
      },
      async execute({ file_path, force_resynthesize, include_reasoning }) {
        log("Tool call: module_synthesize", { file_path, force_resynthesize, include_reasoning });
        
        try {
          await ensureModuleDir();
          
          // Validate file exists
          if (!fsSync.existsSync(file_path)) {
            return JSON.stringify({
              status: "ERROR",
              message: `File not found: ${file_path}`
            }, null, 2);
          }
          
          const moduleId = generateModuleId(file_path);
          const modulePath = path.join(MODULE_DIR, `${moduleId}.json`);
          
          // Check if module summary already exists
          if (!force_resynthesize && fsSync.existsSync(modulePath)) {
            const existingModule = JSON.parse(await fs.readFile(modulePath, 'utf-8'));
            return JSON.stringify({
              status: "EXISTS",
              module_summary: existingModule,
              message: "Module summary already exists. Use force_resynthesize=true to override."
            }, null, 2);
          }
          
          // Find chunk cards for this file
          const chunkCards = await findChunkCardsForFile(file_path);
          
          if (chunkCards.length === 0) {
            return JSON.stringify({
              status: "NO_CHUNKS",
              message: `No chunk cards found for file: ${file_path}. Create chunk cards first.`,
              file_path,
              module_id: moduleId
            }, null, 2);
          }
          
          // Create module summary
          const moduleSummary: ModuleSummary = {
            module_id: moduleId,
            file_path,
            chunk_cards: chunkCards,
            hierarchy: synthesizeHierarchy(chunkCards),
            relationships: extractRelationships(chunkCards),
            metrics: calculateModuleMetrics(chunkCards),
            synthesis_metadata: {
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
              version: "1.0.0",
              synthesis_method: "chunk_card_synthesis"
            }
          };
          
          // Save module summary
          await fs.writeFile(modulePath, JSON.stringify(moduleSummary, null, 2));
          
          const response: any = {
            status: "SUCCESS",
            module_summary: moduleSummary,
            saved_to: modulePath
          };
          
          // Include hierarchical reasoning if requested
          if (include_reasoning) {
            response.reasoning = await generateHierarchicalReasoning(moduleSummary);
          }
          
          return JSON.stringify(response, null, 2);
          
        } catch (error) {
          return JSON.stringify({
            status: "ERROR",
            message: error instanceof Error ? error.message : `${error}`
          }, null, 2);
        }
      }
    }),

    module_get_summary: tool({
      description: "Retrieve a Module Summary by file path or module ID.",
      args: {
        file_path: tool.schema.string().optional().describe("File path to get summary for"),
        module_id: tool.schema.string().optional().describe("Module ID to retrieve"),
        include_reasoning: tool.schema.boolean().optional().default(false).describe("Include hierarchical reasoning")
      },
      async execute({ file_path, module_id, include_reasoning }) {
        log("Tool call: module_get_summary", { file_path, module_id, include_reasoning });
        
        try {
          let targetModuleId = module_id;
          
          if (file_path && !module_id) {
            targetModuleId = generateModuleId(file_path);
          }
          
          if (!targetModuleId) {
            return JSON.stringify({
              status: "ERROR",
              message: "Either file_path or module_id must be provided"
            }, null, 2);
          }
          
          const modulePath = path.join(MODULE_DIR, `${targetModuleId}.json`);
          
          if (!fsSync.existsSync(modulePath)) {
            return JSON.stringify({
              status: "NOT_FOUND",
              message: `Module summary not found: ${targetModuleId}`,
              module_id: targetModuleId
            }, null, 2);
          }
          
          const moduleSummary = JSON.parse(await fs.readFile(modulePath, 'utf-8'));
          
          const response: any = {
            status: "SUCCESS",
            module_summary: moduleSummary
          };
          
          // Include hierarchical reasoning if requested
          if (include_reasoning) {
            response.reasoning = await generateHierarchicalReasoning(moduleSummary);
          }
          
          return JSON.stringify(response, null, 2);
          
        } catch (error) {
          return JSON.stringify({
            status: "ERROR",
            message: error instanceof Error ? error.message : `${error}`
          }, null, 2);
        }
      }
    }),

    module_list_summaries: tool({
      description: "List all available Module Summaries with optional filtering.",
      args: {
        file_pattern: tool.schema.string().optional().describe("Filter by file path pattern (regex)"),
        limit: tool.schema.number().optional().default(20).describe("Maximum number of summaries to return"),
        include_metrics: tool.schema.boolean().optional().default(true).describe("Include module metrics")
      },
      async execute({ file_pattern, limit, include_metrics }) {
        log("Tool call: module_list_summaries", { file_pattern, limit, include_metrics });
        
        try {
          await ensureModuleDir();
          
          const files = await fs.readdir(MODULE_DIR);
          const summaries = [];
          
          for (const file of files) {
            if (file.endsWith('.json')) {
              try {
                const modulePath = path.join(MODULE_DIR, file);
                const summary = JSON.parse(await fs.readFile(modulePath, 'utf-8'));
                
                // Apply file pattern filter if specified
                if (file_pattern && !new RegExp(file_pattern).test(summary.file_path)) {
                  continue;
                }
                
                const summaryInfo = {
                  module_id: summary.module_id,
                  file_path: summary.file_path,
                  created_at: summary.synthesis_metadata.created_at,
                  updated_at: summary.synthesis_metadata.updated_at,
                  chunk_count: summary.chunk_cards.length
                };
                
                if (include_metrics) {
                  Object.assign(summaryInfo, summary.metrics);
                }
                
                summaries.push(summaryInfo);
              } catch (error) {
                // Skip corrupted files
                continue;
              }
            }
          }
          
          // Sort by updated date (most recent first)
          summaries.sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());
          
          // Apply limit
          const limitedSummaries = summaries.slice(0, limit);
          
          return JSON.stringify({
            status: "SUCCESS",
            summaries: limitedSummaries,
            total_count: summaries.length,
            returned_count: limitedSummaries.length,
            filters: {
              file_pattern,
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

    module_hierarchical_reasoning: tool({
      description: "Generate detailed hierarchical reasoning for a module across summary, signature, and implementation levels.",
      args: {
        module_id: tool.schema.string().describe("Module ID to analyze"),
        reasoning_depth: tool.schema.enum(["shallow", "medium", "deep"]).optional().default("medium").describe("Depth of reasoning analysis")
      },
      async execute({ module_id, reasoning_depth }) {
        log("Tool call: module_hierarchical_reasoning", { module_id, reasoning_depth });
        
        try {
          const modulePath = path.join(MODULE_DIR, `${module_id}.json`);
          
          if (!fsSync.existsSync(modulePath)) {
            return JSON.stringify({
              status: "NOT_FOUND",
              message: `Module summary not found: ${module_id}`
            }, null, 2);
          }
          
          const moduleSummary = JSON.parse(await fs.readFile(modulePath, 'utf-8'));
          const reasoning = await generateHierarchicalReasoning(moduleSummary, reasoning_depth);
          
          return JSON.stringify({
            status: "SUCCESS",
            module_id,
            reasoning_depth,
            reasoning,
            generated_at: new Date().toISOString()
          }, null, 2);
          
        } catch (error) {
          return JSON.stringify({
            status: "ERROR",
            message: error instanceof Error ? error.message : `${error}`
          }, null, 2);
        }
      }
    }),

    module_cross_reference: tool({
      description: "Find cross-references and relationships between modules.",
      args: {
        module_id: tool.schema.string().describe("Module ID to analyze"),
        reference_depth: tool.schema.number().optional().default(2).describe("How many levels of references to follow"),
        include_symbols: tool.schema.boolean().optional().default(true).describe("Include shared symbol analysis")
      },
      async execute({ module_id, reference_depth, include_symbols }) {
        log("Tool call: module_cross_reference", { module_id, reference_depth, include_symbols });
        
        try {
          const modulePath = path.join(MODULE_DIR, `${module_id}.json`);
          
          if (!fsSync.existsSync(modulePath)) {
            return JSON.stringify({
              status: "NOT_FOUND",
              message: `Module summary not found: ${module_id}`
            }, null, 2);
          }
          
          const moduleSummary = JSON.parse(await fs.readFile(modulePath, 'utf-8'));
          const crossReferences = await generateCrossReferences(moduleSummary, reference_depth, include_symbols);
          
          return JSON.stringify({
            status: "SUCCESS",
            module_id,
            reference_depth,
            cross_references: crossReferences,
            generated_at: new Date().toISOString()
          }, null, 2);
          
        } catch (error) {
          return JSON.stringify({
            status: "ERROR",
            message: error instanceof Error ? error.message : `${error}`
          }, null, 2);
        }
      }
    }),

    module_delete_summary: tool({
      description: "Delete a Module Summary.",
      args: {
        module_id: tool.schema.string().describe("Module ID to delete")
      },
      async execute({ module_id }) {
        log("Tool call: module_delete_summary", { module_id });
        
        try {
          const modulePath = path.join(MODULE_DIR, `${module_id}.json`);
          
          if (!fsSync.existsSync(modulePath)) {
            return JSON.stringify({
              status: "NOT_FOUND",
              message: `Module summary not found: ${module_id}`
            }, null, 2);
          }
          
          await fs.unlink(modulePath);
          
          return JSON.stringify({
            status: "SUCCESS",
            message: `Module summary deleted: ${module_id}`
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
// HIERARCHICAL REASONING GENERATION
// =============================================================================

async function generateHierarchicalReasoning(moduleSummary: ModuleSummary, depth: string = "medium"): Promise<HierarchicalReasoning> {
  const chunkCards = moduleSummary.chunk_cards;
  const summaryCard = chunkCards.find(card => card.chunk_type === 'summary');
  const apiCard = chunkCards.find(card => card.chunk_type === 'api');
  const invariantCard = chunkCards.find(card => card.chunk_type === 'invariant');
  
  const reasoning: HierarchicalReasoning = {
    module_id: moduleSummary.module_id,
    reasoning_levels: {
      summary: {
        purpose: extractPurposeFromSummary(summaryCard?.content || ""),
        key_concepts: extractKeyConcepts(summaryCard?.content || ""),
        high_level_structure: extractHighLevelStructure(summaryCard?.content || "")
      },
      signature: {
        public_api: extractPublicApi(apiCard?.content || ""),
        interfaces: extractInterfaces(apiCard?.content || ""),
        contracts: extractContracts(apiCard?.content || "")
      },
      implementation: {
        internal_structure: extractInternalStructure(invariantCard?.content || ""),
        algorithms: extractAlgorithms(invariantCard?.content || ""),
        data_flow: extractDataFlow(invariantCard?.content || "")
      }
    },
    cross_references: {
      related_modules: await findRelatedModules(moduleSummary),
      shared_symbols: moduleSummary.relationships.exports,
      dependency_graph: generateDependencyGraph(moduleSummary)
    }
  };
  
  return reasoning;
}

async function generateCrossReferences(moduleSummary: ModuleSummary, depth: number, includeSymbols: boolean) {
  // This would analyze other modules to find relationships
  // For now, return a placeholder implementation
  return {
    direct_dependencies: moduleSummary.relationships.imports,
    dependents: moduleSummary.relationships.dependents,
    shared_symbols: includeSymbols ? moduleSummary.relationships.exports : [],
    related_modules: [],
    analysis_depth: depth
  };
}

// =============================================================================
// REASONING EXTRACTION HELPERS
// =============================================================================

function extractPurposeFromSummary(summaryContent: string): string {
  const purposeMatch = summaryContent.match(/## Purpose\s*\n\s*(.+?)(?=\n\n|\n#|$)/s);
  return purposeMatch ? purposeMatch[1].trim() : "Purpose not explicitly documented";
}

function extractKeyConcepts(summaryContent: string): string[] {
  const concepts: string[] = [];
  
  // Extract from Key Components section
  const componentsMatch = summaryContent.match(/## Key Components\s*\n(.+?)(?=\n\n|\n#|$)/s);
  if (componentsMatch) {
    const lines = componentsMatch[1].split('\n');
    lines.forEach(line => {
      const match = line.match(/-\s*\*\*([^*]+)\*\*:\s*(.+)/);
      if (match) {
        concepts.push(match[1]);
      }
    });
  }
  
  return concepts;
}

function extractHighLevelStructure(summaryContent: string): string {
  // Extract structural information from summary
  return "High-level structure analysis not implemented";
}

function extractPublicApi(apiContent: string): string[] {
  const apis: string[] = [];
  
  // Extract public functions
  const functionMatches = apiContent.match(/###\s+(\w+)\s*\n/g);
  if (functionMatches) {
    apis.push(...functionMatches.map(match => match.replace(/###\s+/, '').trim()));
  }
  
  return apis;
}

function extractInterfaces(apiContent: string): string[] {
  const interfaces: string[] = [];
  
  // Extract interfaces
  const interfaceMatches = apiContent.match(/###\s+(\w+)\s*\n/g);
  if (interfaceMatches) {
    interfaces.push(...interfaceMatches.map(match => match.replace(/###\s+/, '').trim()));
  }
  
  return interfaces;
}

function extractContracts(apiContent: string): string[] {
  // Extract contracts/invariants
  return [];
}

function extractInternalStructure(invariantContent: string): string {
  return "Internal structure analysis not implemented";
}

function extractAlgorithms(invariantContent: string): string[] {
  return [];
}

function extractDataFlow(invariantContent: string): string {
  return "Data flow analysis not implemented";
}

async function findRelatedModules(moduleSummary: ModuleSummary): Promise<string[]> {
  // This would search for other modules that reference this module
  return [];
}

function generateDependencyGraph(moduleSummary: ModuleSummary): string {
  return `Dependency graph for ${moduleSummary.module_id} not implemented`;
}