import { tool } from "@opencode-ai/plugin";
import { exec } from "node:child_process";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import * as crypto from "node:crypto";
import ts from "typescript";
import { getDb } from "./database.js";
import { Logger } from "./services/logger.js";

const execAsync = promisify(exec);
const PROJECT_ROOT = process.cwd();
const OPENCODE_DIR = path.join(PROJECT_ROOT, ".opencode");
export const CHUNK_DIR = path.join(OPENCODE_DIR, "chunks");
const CACHE_DIR = path.join(OPENCODE_DIR, "cache");

// Internal logging
function log(message: string, data?: unknown) {
  Logger.log("ChunkCards", message, data);
}

// =============================================================================
// TYPES AND INTERFACES
// =============================================================================

export interface ChunkCard {
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
}

interface ActiveSet {
  id: string;
  name: string;
  chunks: string[]; // Chunk card IDs
  context_window: number;
  priority: "high" | "medium" | "low";
  created_at: string;
  last_accessed: string;
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

export async function ensureChunkDir() {
  await fs.mkdir(CHUNK_DIR, { recursive: true });
}

export function calculateHash(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

export function calculateComplexity(content: string): number {
  // Simple complexity calculation based on code metrics
  const lines = content.split('\n').length;
  const cyclomaticComplexity = (content.match(/\b(if|while|for|switch|case|catch)\b/g) || []).length;
  const nestingDepth = Math.max(...content.split('\n').map(line => 
    (line.match(/^\s*/)?.[0]?.length || 0)
  ));
  
  return Math.min(100, (lines * 0.1) + (cyclomaticComplexity * 5) + (nestingDepth * 2));
}

export function extractSymbols(content: string, filePath: string = ''): string[] {
  // Extract function names, class names, and variable names
  const symbols: string[] = [];

  if (filePath) {
      const ext = path.extname(filePath);
      if (ext === '.cpp' || ext === '.c' || ext === '.h' || ext === '.hpp' || ext === '.cc') {
          const funcs = extractFunctionsCpp(content);
          const classes = extractClassesCpp(content);
          symbols.push(...funcs.map(f => f.name));
          symbols.push(...classes.map(c => c.name));
          return symbols;
      }
      if (ext === '.swift') {
          const funcs = extractFunctionsSwift(content);
          const classes = extractClassesSwift(content);
          symbols.push(...funcs.map(f => f.name));
          symbols.push(...classes.map(c => c.name));
          return symbols;
      }
  }
  
  // Functions
  const functionMatches = content.match(/(?:function|const|let|var)\s+(\w+)\s*=/g);
  if (functionMatches) {
    symbols.push(...functionMatches.map(m => m.split(/\s+/)[1]));
  }
  
  // Classes
  const classMatches = content.match(/class\s+(\w+)/g);
  if (classMatches) {
    symbols.push(...classMatches.map(m => m.split(/\s+/)[1]));
  }
  
  // Interfaces/Types
  const typeMatches = content.match(/(?:interface|type)\s+(\w+)/g);
  if (typeMatches) {
    symbols.push(...typeMatches.map(m => m.split(/\s+/)[1]));
  }
  
  return symbols.filter(s => s && s.length > 0);
}

// =============================================================================
// CHUNK CARDS IMPLEMENTATION
// =============================================================================

export function chunkCardsTools(): { [key: string]: any } {
  return {
    chunk_create_card: tool({
      description: "Create a Chunk Card for code analysis. Supports summary, API, and invariant card types with automatic metadata extraction.",
      args: {
        file_path: tool.schema.string().describe("Absolute path to the source file"),
        chunk_type: tool.schema.enum(["summary", "api", "invariant"]).describe("Type of chunk card to create"),
        content: tool.schema.string().optional().describe("Custom content (auto-generated if not provided)"),
        force_recreate: tool.schema.boolean().optional().default(false).describe("Force recreation even if card exists")
      },
      async execute({ file_path, chunk_type, content, force_recreate }) {
        log("Tool call: chunk_create_card", { file_path, chunk_type, force_recreate });
        
        try {
          await ensureChunkDir();
          
          // Validate file exists
          if (!fsSync.existsSync(file_path)) {
            return JSON.stringify({
              status: "ERROR",
              message: `File not found: ${file_path}`
            }, null, 2);
          }
          
          // Generate card ID
          const fileHash = calculateHash(file_path);
          const cardId = `${path.basename(file_path)}-${chunk_type}-${fileHash.slice(0, 8)}`;
          const cardPath = path.join(CHUNK_DIR, `${cardId}.json`);
          
          // Check if card already exists
          if (!force_recreate && fsSync.existsSync(cardPath)) {
            const existingCard = JSON.parse(await fs.readFile(cardPath, 'utf-8'));
            return JSON.stringify({
              status: "EXISTS",
              card: existingCard,
              message: "Card already exists. Use force_recreate=true to override."
            }, null, 2);
          }
          
          // Read source file if no custom content provided
          let sourceContent = content;
          if (!sourceContent) {
            sourceContent = await fs.readFile(file_path, 'utf-8');
          }

          // Parse AST for JS/TS files
          const ast = parseFileAST(file_path, sourceContent);
          
          // Generate chunk content based on type
          let chunkContent = "";
          switch (chunk_type) {
            case "summary":
              chunkContent = await generateSummaryChunk(sourceContent, file_path, ast);
              break;
            case "api":
              chunkContent = await generateApiChunk(sourceContent, file_path, ast);
              break;
            case "invariant":
              chunkContent = await generateInvariantChunk(sourceContent, file_path, ast);
              break;
          }
          
          // Create chunk card
          const chunkCard: ChunkCard = {
            id: cardId,
            file_path,
            chunk_type,
            content: chunkContent,
            metadata: {
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
              hash: calculateHash(chunkContent),
              dependencies: await extractDependencies(sourceContent, ast, file_path),
              symbols: extractSymbolsFromAST(ast, sourceContent) || extractSymbols(sourceContent, file_path),
              complexity_score: calculateComplexity(sourceContent)
            }
          };
          
          // Save chunk card
          await fs.writeFile(cardPath, JSON.stringify(chunkCard, null, 2));
          
          // Sync to SQLite Index
          getDb().ingestChunkCard(chunkCard);
          
          return JSON.stringify({
            status: "SUCCESS",
            card: chunkCard,
            saved_to: cardPath
          }, null, 2);
          
        } catch (error) {
          return JSON.stringify({
            status: "ERROR",
            message: error instanceof Error ? error.message : `${error}`
          }, null, 2);
        }
      }
    }),

    chunk_get_card: tool({
      description: "Retrieve a Chunk Card by ID or file path and type.",
      args: {
        card_id: tool.schema.string().optional().describe("Card ID to retrieve"),
        file_path: tool.schema.string().optional().describe("File path to search for cards"),
        chunk_type: tool.schema.enum(["summary", "api", "invariant"]).optional().describe("Filter by chunk type")
      },
      async execute({ card_id, file_path, chunk_type }) {
        log("Tool call: chunk_get_card", { card_id, file_path, chunk_type });
        
        try {
          await ensureChunkDir();
          
          if (card_id) {
            // Direct card lookup
            const cardPath = path.join(CHUNK_DIR, `${card_id}.json`);
            if (!fsSync.existsSync(cardPath)) {
              return JSON.stringify({
                status: "NOT_FOUND",
                message: `Card not found: ${card_id}`
              }, null, 2);
            }
            
            const card = JSON.parse(await fs.readFile(cardPath, 'utf-8'));
            return JSON.stringify({
              status: "SUCCESS",
              card
            }, null, 2);
          } else if (file_path) {
            // Search by file path
            const files = await fs.readdir(CHUNK_DIR);
            const matchingCards = [];
            
            for (const file of files) {
              if (file.endsWith('.json')) {
                const cardPath = path.join(CHUNK_DIR, file);
                const card = JSON.parse(await fs.readFile(cardPath, 'utf-8'));
                
                if (card.file_path === file_path && (!chunk_type || card.chunk_type === chunk_type)) {
                  matchingCards.push(card);
                }
              }
            }
            
            return JSON.stringify({
              status: "SUCCESS",
              cards: matchingCards,
              count: matchingCards.length
            }, null, 2);
          } else {
            return JSON.stringify({
              status: "ERROR",
              message: "Either card_id or file_path must be provided"
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

    chunk_list_cards: tool({
      description: "List all Chunk Cards with optional filtering and pagination.",
      args: {
        chunk_type: tool.schema.enum(["summary", "api", "invariant"]).optional().describe("Filter by chunk type"),
        file_pattern: tool.schema.string().optional().describe("Filter by file path pattern (regex)"),
        limit: tool.schema.number().optional().default(50).describe("Maximum number of cards to return"),
        offset: tool.schema.number().optional().default(0).describe("Number of cards to skip")
      },
      async execute({ chunk_type, file_pattern, limit, offset }) {
        log("Tool call: chunk_list_cards", { chunk_type, file_pattern, limit, offset });
        
        try {
          await ensureChunkDir();
          
          const files = await fs.readdir(CHUNK_DIR);
          const cards = [];
          
          for (const file of files) {
            if (file.endsWith('.json')) {
              const cardPath = path.join(CHUNK_DIR, file);
              const card = JSON.parse(await fs.readFile(cardPath, 'utf-8'));
              
              // Apply filters
              if (chunk_type && card.chunk_type !== chunk_type) continue;
              if (file_pattern && !new RegExp(file_pattern).test(card.file_path)) continue;
              
              cards.push(card);
            }
          }
          
          // Sort by creation date (newest first)
          cards.sort((a, b) => new Date(b.metadata.created_at).getTime() - new Date(a.metadata.created_at).getTime());
          
          // Apply pagination
          const paginatedCards = cards.slice(offset, offset + limit);
          
          return JSON.stringify({
            status: "SUCCESS",
            cards: paginatedCards,
            pagination: {
              total: cards.length,
              limit,
              offset,
              has_more: offset + limit < cards.length
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

    chunk_delete_card: tool({
      description: "Delete a Chunk Card by ID.",
      args: {
        card_id: tool.schema.string().describe("Card ID to delete")
      },
      async execute({ card_id }) {
        log("Tool call: chunk_delete_card", { card_id });
        
        try {
          const cardPath = path.join(CHUNK_DIR, `${card_id}.json`);
          
          if (!fsSync.existsSync(cardPath)) {
            return JSON.stringify({
              status: "NOT_FOUND",
              message: `Card not found: ${card_id}`
            }, null, 2);
          }
          
          await fs.unlink(cardPath);
          
          // Remove from SQLite Index
          getDb().deleteChunkCard(card_id);
          
          return JSON.stringify({
            status: "SUCCESS",
            message: `Card deleted: ${card_id}`
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
// CHUNK GENERATION HELPERS
// =============================================================================

export async function generateSummaryChunk(content: string, filePath: string, ast: ts.SourceFile | null): Promise<string> {
  const lines = content.split('\n');
  const fileName = path.basename(filePath);
  const fileExtension = path.extname(filePath);
  
  // Extract key information
  let functions: FunctionInfo[] = [];
  let classes: ClassInfo[] = [];
  let imports: string[] = [];
  let exports: string[] = [];

  if (ast) {
     functions = extractFunctionsFromAST(ast);
     classes = extractClassesFromAST(ast);
     imports = extractImportsFromAST(ast);
     exports = extractExportsFromAST(ast);
  } else if (fileExtension === '.cpp' || fileExtension === '.c' || fileExtension === '.h' || fileExtension === '.hpp' || fileExtension === '.cc') {
     functions = extractFunctionsCpp(content);
     classes = extractClassesCpp(content);
     imports = extractImportsCpp(content);
  } else if (fileExtension === '.swift') {
     functions = extractFunctionsSwift(content);
     classes = extractClassesSwift(content);
     imports = extractImportsSwift(content);
  } else {
     functions = extractFunctions(content);
     classes = extractClasses(content);
     imports = extractImports(content);
     exports = extractExports(content);
  }
  
  const summary = `# Summary: ${fileName}

## File Type
${fileExtension} - ${getFileTypeDescription(fileExtension)}

## Purpose
${extractPurpose(content)}

## Key Components
${functions.length > 0 ? `
### Functions (${functions.length})
${functions.map(fn => `- **${fn.name}**: ${fn.description}`).join('\n')}
` : ''}

${classes.length > 0 ? `
### Classes (${classes.length})
${classes.map(cls => `- **${cls.name}**: ${cls.description}`).join('\n')}
` : ''}

## Dependencies
${imports.length > 0 ? imports.map(imp => `- ${imp}`).join('\n') : 'No external dependencies'}

## Exports
${exports.length > 0 ? exports.map(exp => `- ${exp}`).join('\n') : 'No exports'}

## Complexity Metrics
- Lines of code: ${lines.length}
- Estimated complexity: ${calculateComplexity(content)}/100

## Notes
${extractNotes(content)}`;
  
  return summary;
}

export async function generateApiChunk(content: string, filePath: string, ast: ts.SourceFile | null): Promise<string> {
  let functions: FunctionInfo[] = [];
  let classes: ClassInfo[] = [];
  let interfaces: InterfaceInfo[] = [];
  let types: TypeInfo[] = [];

  const fileExtension = path.extname(filePath);

  if (ast) {
     functions = extractFunctionsFromAST(ast);
     classes = extractClassesFromAST(ast);
     interfaces = extractInterfacesFromAST(ast);
     types = extractTypesFromAST(ast);
  } else if (fileExtension === '.cpp' || fileExtension === '.c' || fileExtension === '.h' || fileExtension === '.hpp' || fileExtension === '.cc') {
     functions = extractFunctionsCpp(content);
     classes = extractClassesCpp(content);
     // C++ interfaces/types logic is complex, skipping for now
  } else if (fileExtension === '.swift') {
     functions = extractFunctionsSwift(content);
     classes = extractClassesSwift(content);
     // Swift protocols could map to interfaces
  } else {
     functions = extractFunctions(content);
     classes = extractClasses(content);
     interfaces = extractInterfaces(content);
     types = extractTypes(content);
  }
  
  const api = `# API Surface: ${path.basename(filePath)}

## Public Functions
${functions.filter(fn => fn.isExported).map(fn => `
### ${fn.name}
\`\`\`typescript
${fn.signature}
\`\`\`
${fn.description}
${fn.params.length > 0 ? `
**Parameters:**
${fn.params.map(p => `- \`${p.name}\`: ${p.type} - ${p.description}`).join('\n')}
` : ''}
${fn.returns ? `**Returns:** ${fn.returns}` : ''}
`).join('\n')}

## Classes
${classes.map(cls => `
### ${cls.name}
\`\`\`typescript
${cls.signature}
\`\`\`
${cls.description}
${cls.methods.length > 0 ? `
**Methods:**
${cls.methods.map(method => `- \`${method.name}\`: ${method.signature}`).join('\n')}
` : ''}
${cls.properties.length > 0 ? `
**Properties:**
${cls.properties.map(prop => `- \`${prop.name}\`: ${prop.type}`).join('\n')}
` : ''}
`).join('\n')}

## Interfaces
${interfaces.map(iface => `
### ${iface.name}
\`\`\`typescript
${iface.signature}
\`\`\`
${iface.description}
`).join('\n')}

## Types
${types.map(type => `
### ${type.name}
\`\`\`typescript
${type.signature}
\`\`\`
${type.description}
`).join('\n')}`;
  
  return api;
}

export async function generateInvariantChunk(content: string, filePath: string, ast: ts.SourceFile | null): Promise<string> {
  const invariants = extractInvariants(content);
  const constraints = extractConstraints(content);
  const assumptions = extractAssumptions(content);
  
  const invariant = `# Invariants: ${path.basename(filePath)}

## Core Invariants
${invariants.map(inv => `- **${inv.name}**: ${inv.description}`).join('\n')}

## Constraints
${constraints.map(con => `- **${con.name}**: ${con.description}`).join('\n')}

## Assumptions
${assumptions.map(ass => `- **${ass.name}**: ${ass.description}`).join('\n')}

## State Management
${extractStateManagement(content)}

## Error Handling
${extractErrorHandling(content)}

## Performance Considerations
${extractPerformanceConsiderations(content)}

## Security Considerations
${extractSecurityConsiderations(content)}`;
  
  return invariant;
}

// =============================================================================
// EXTRACTION HELPERS
// =============================================================================

function extractFunctions(content: string): FunctionInfo[] {
  const functions: FunctionInfo[] = [];
  const functionRegex = /(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)\s*:\s*([^;{]+)/g;
  let match;
  
  while ((match = functionRegex.exec(content)) !== null) {
    functions.push({
      name: match[1],
      signature: match[0],
      isExported: match[0].includes('export'),
      params: parseParameters(match[2]),
      returns: match[3]?.trim() || 'void',
      description: extractFunctionDescription(content, match[1])
    });
  }
  
  return functions;
}

function extractClasses(content: string): ClassInfo[] {
  const classes: ClassInfo[] = [];
  const classRegex = /(?:export\s+)?class\s+(\w+)(?:\s+extends\s+(\w+))?\s*{([^}]*)}/g;
  let match;
  
  while ((match = classRegex.exec(content)) !== null) {
    classes.push({
      name: match[1],
      signature: match[0],
      extends: match[2] || null,
      description: extractClassDescription(content, match[1]),
      methods: extractMethods(match[3]),
      properties: extractProperties(match[3])
    });
  }
  
  return classes;
}

function extractImports(content: string): string[] {
  const imports: string[] = [];
  const importRegex = /import\s+.*?\s+from\s+['"]([^'"]+)['"]/g;
  let match;
  
  while ((match = importRegex.exec(content)) !== null) {
    imports.push(match[1]);
  }
  
  return imports;
}

function extractExports(content: string): string[] {
  const exports: string[] = [];
  const exportRegex = /export\s+(?:const|let|var|function|class|interface|type)\s+(\w+)/g;
  let match;
  
  while ((match = exportRegex.exec(content)) !== null) {
    exports.push(match[1]);
  }
  
  return exports;
}

function extractInterfaces(content: string): InterfaceInfo[] {
  const interfaces: InterfaceInfo[] = [];
  const interfaceRegex = /(?:export\s+)?interface\s+(\w+)\s*{([^}]*)}/g;
  let match;
  
  while ((match = interfaceRegex.exec(content)) !== null) {
    interfaces.push({
      name: match[1],
      signature: match[0],
      description: extractInterfaceDescription(content, match[1])
    });
  }
  
  return interfaces;
}

function extractTypes(content: string): TypeInfo[] {
  const types: TypeInfo[] = [];
  const typeRegex = /(?:export\s+)?type\s+(\w+)\s*=\s*([^;]+)/g;
  let match;
  
  while ((match = typeRegex.exec(content)) !== null) {
    types.push({
      name: match[1],
      signature: match[0],
      description: extractTypeDescription(content, match[1])
    });
  }
  
  return types;
}

// Additional extraction helpers would be implemented here...
// For brevity, I'm including placeholder implementations

interface FunctionInfo {
  name: string;
  signature: string;
  isExported: boolean;
  params: Array<{ name: string; type: string; description: string }>;
  returns: string;
  description: string;
}

interface ClassInfo {
  name: string;
  signature: string;
  extends: string | null;
  description: string;
  methods: Array<{ name: string; signature: string }>;
  properties: Array<{ name: string; type: string }>;
}

interface InterfaceInfo {
  name: string;
  signature: string;
  description: string;
}

interface TypeInfo {
  name: string;
  signature: string;
  description: string;
}

function extractPurpose(content: string): string {
  // Extract purpose from comments or make an educated guess
  const purposeMatch = content.match(/\/\*\*[^*]*\*[^*]*\*\/\s*(?:function|class|const)/s);
  return purposeMatch ? "Documented purpose found in JSDoc" : "Purpose not explicitly documented";
}

function extractNotes(content: string): string {
  // Extract important notes from comments
  return "No specific notes found";
}

function parseParameters(params: string): Array<{ name: string; type: string; description: string }> {
  if (!params.trim()) return [];
  
  return params.split(',').map(param => {
    const [name, type] = param.trim().split(':').map(s => s.trim());
    return { name: name || '', type: type || 'any', description: '' };
  });
}

function extractFunctionDescription(content: string, functionName: string): string {
  // Extract JSDoc description for function
  const jsdocMatch = content.match(new RegExp(`\\/\\*\\*[^*]*\\*[^*]*\\*\\/\\s*(?:async\\s+)?function\\s+${functionName}`, 's'));
  return jsdocMatch ? "Function has JSDoc documentation" : "No documentation found";
}

function extractClassDescription(content: string, className: string): string {
  // Extract JSDoc description for class
  const jsdocMatch = content.match(new RegExp(`\\/\\*\\*[^*]*\\*[^*]*\\*\\/\\s*class\\s+${className}`, 's'));
  return jsdocMatch ? "Class has JSDoc documentation" : "No documentation found";
}

function extractMethods(classBody: string): Array<{ name: string; signature: string }> {
  // Extract methods from class body
  return [];
}

function extractProperties(classBody: string): Array<{ name: string; type: string }> {
  // Extract properties from class body
  return [];
}

function extractInterfaceDescription(content: string, interfaceName: string): string {
  return "Interface description not available";
}

function extractTypeDescription(content: string, typeName: string): string {
  return "Type description not available";
}

function extractInvariants(content: string): Array<{ name: string; description: string }> {
  const invariants: Array<{ name: string; description: string }> = [];
  // Look for validation checks that throw errors
  const throwMatches = content.match(/if\s*\(([^)]+)\)\s*throw\s*new\s*Error\(([^)]+)\)/g);
  if (throwMatches) {
     throwMatches.forEach(m => {
        invariants.push({ name: "Validation Check", description: m });
     });
  }
  // Look for assert calls
  const assertMatches = content.match(/assert\(([^,]+)(?:,\s*["']([^"']+)["'])?\)/g);
  if (assertMatches) {
    assertMatches.forEach(m => {
        invariants.push({ name: "Assertion", description: m });
     });
  }
  return invariants;
}

function extractConstraints(content: string): Array<{ name: string; description: string }> {
   const constraints: Array<{ name: string; description: string }> = [];
   // Look for UPPERCASE constants which usually denote limits/config
   const constMatches = content.match(/const\s+([A-Z_][A-Z0-9_]*)\s*=\s*([^;]+)/g);
   if (constMatches) {
      constMatches.forEach(m => {
         const parts = m.split('=');
         constraints.push({ name: parts[0].replace('const', '').trim(), description: parts[1].trim() });
      });
   }
   return constraints;
}

function extractAssumptions(content: string): Array<{ name: string; description: string }> {
  const assumptions: Array<{ name: string; description: string }> = [];
  // Look for comments indicating assumptions
  const commentMatches = content.match(/\/\/\s*(TODO|FIXME|ASSUME|NOTE):\s*(.+)/g);
  if (commentMatches) {
     commentMatches.forEach(m => {
        assumptions.push({ name: "Code Annotation", description: m.replace(/\/\/\s*/, '').trim() });
     });
  }
  return assumptions;
}

function extractStateManagement(content: string): string {
  const patterns = [];
  if (content.includes('useState')) patterns.push("React useState hook");
  if (content.includes('useReducer')) patterns.push("React useReducer hook");
  if (content.includes('this.state')) patterns.push("Class component state");
  if (content.includes('redux') || content.includes('dispatch')) patterns.push("Redux/Flux pattern");
  if (content.includes('mobx') || content.includes('observable')) patterns.push("MobX pattern");
  
  return patterns.length > 0 ? `Detected patterns: ${patterns.join(', ')}` : "No explicit state management patterns detected";
}

function extractErrorHandling(content: string): string {
  const tryCount = (content.match(/try\s*\{/g) || []).length;
  const catchCount = (content.match(/catch\s*(\(|{)/g) || []).length;
  const throwCount = (content.match(/throw\s+new\s+Error/g) || []).length;
  
  if (tryCount === 0 && throwCount === 0) return "No explicit error handling patterns detected";
  
  return `Error handling metrics: ${tryCount} try-catch blocks, ${throwCount} throw statements`;
}

function extractPerformanceConsiderations(content: string): string {
  const patterns = [];
  if (content.includes('useMemo')) patterns.push("Uses React.useMemo");
  if (content.includes('useCallback')) patterns.push("Uses React.useCallback");
  if (content.match(/await\s+Promise\.all/)) patterns.push("Uses parallel execution (Promise.all)");
  if (content.match(/for\s*\(.*;.*;.*\)/)) patterns.push("Contains explicit loops");
  
  return patterns.length > 0 ? `Performance patterns: ${patterns.join(', ')}` : "No obvious performance optimization patterns detected";
}

function extractSecurityConsiderations(content: string): string {
  const risks = [];
  if (content.includes('innerHTML')) risks.push("Potential XSS risk (innerHTML usage)");
  if (content.includes('eval(')) risks.push("Critical security risk (eval usage)");
  if (content.includes('dangerouslySetInnerHTML')) risks.push("Explicit React XSS risk");
  
  return risks.length > 0 ? `Security alerts: ${risks.join(', ')}` : "No obvious security risks detected via static analysis";
}

function getFileTypeDescription(extension: string): string {
  const descriptions: Record<string, string> = {
    '.ts': 'TypeScript source file',
    '.js': 'JavaScript source file',
    '.tsx': 'TypeScript React component',
    '.jsx': 'JavaScript React component',
    '.py': 'Python source file',
    '.go': 'Go source file',
    '.rs': 'Rust source file',
    '.cpp': 'C++ source file',
    '.c': 'C source file'
  };
  
  return descriptions[extension] || 'Unknown file type';
}

export async function extractDependencies(content: string, ast: ts.SourceFile | null = null, filePath: string = ''): Promise<string[]> {
  // Extract dependency information from imports
  if (ast) {
    return extractImportsFromAST(ast);
  }
  
  if (filePath) {
      const ext = path.extname(filePath);
      if (ext === '.cpp' || ext === '.c' || ext === '.h' || ext === '.hpp' || ext === '.cc') {
          return extractImportsCpp(content);
      }
      if (ext === '.swift') {
          return extractImportsSwift(content);
      }
  }
  
  return extractImports(content);
}

// =============================================================================
// AST EXTRACTION HELPERS
// =============================================================================

export function parseFileAST(filePath: string, content: string): ts.SourceFile | null {
  if (filePath.endsWith('.ts') || filePath.endsWith('.tsx') || filePath.endsWith('.js') || filePath.endsWith('.jsx')) {
    return ts.createSourceFile(
      filePath,
      content,
      ts.ScriptTarget.Latest,
      true
    );
  }
  return null;
}

function extractFunctionsFromAST(sourceFile: ts.SourceFile): FunctionInfo[] {
  const functions: FunctionInfo[] = [];

  function visit(node: ts.Node) {
    if (ts.isFunctionDeclaration(node) && node.name) {
      functions.push({
        name: node.name.text,
        signature: node.getText(sourceFile).split('{')[0].trim(),
        isExported: isNodeExported(node),
        params: node.parameters.map(p => ({
          name: p.name.getText(sourceFile),
          type: p.type ? p.type.getText(sourceFile) : 'any',
          description: ''
        })),
        returns: node.type ? node.type.getText(sourceFile) : 'void',
        description: getJSDocDescription(node, sourceFile)
      });
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return functions;
}

function extractClassesFromAST(sourceFile: ts.SourceFile): ClassInfo[] {
  const classes: ClassInfo[] = [];

  function visit(node: ts.Node) {
    if (ts.isClassDeclaration(node) && node.name) {
      const methods: Array<{ name: string; signature: string }> = [];
      const properties: Array<{ name: string; type: string }> = [];
      
      node.members.forEach(member => {
        if (ts.isMethodDeclaration(member) && member.name) {
          methods.push({
            name: member.name.getText(sourceFile),
            signature: member.getText(sourceFile).split('{')[0].trim()
          });
        } else if (ts.isPropertyDeclaration(member) && member.name) {
          properties.push({
            name: member.name.getText(sourceFile),
            type: member.type ? member.type.getText(sourceFile) : 'any'
          });
        }
      });

      classes.push({
        name: node.name.text,
        signature: node.getText(sourceFile).split('{')[0].trim(),
        extends: node.heritageClauses?.find(h => h.token === ts.SyntaxKind.ExtendsKeyword)?.types[0].expression.getText(sourceFile) || null,
        description: getJSDocDescription(node, sourceFile),
        methods,
        properties
      });
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return classes;
}

function extractInterfacesFromAST(sourceFile: ts.SourceFile): InterfaceInfo[] {
  const interfaces: InterfaceInfo[] = [];

  function visit(node: ts.Node) {
    if (ts.isInterfaceDeclaration(node)) {
      interfaces.push({
        name: node.name.text,
        signature: node.getText(sourceFile).split('{')[0].trim(),
        description: getJSDocDescription(node, sourceFile)
      });
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return interfaces;
}

function extractTypesFromAST(sourceFile: ts.SourceFile): TypeInfo[] {
  const types: TypeInfo[] = [];

  function visit(node: ts.Node) {
    if (ts.isTypeAliasDeclaration(node)) {
      types.push({
        name: node.name.text,
        signature: node.getText(sourceFile).split('=')[0].trim(),
        description: getJSDocDescription(node, sourceFile)
      });
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return types;
}

function extractImportsFromAST(sourceFile: ts.SourceFile): string[] {
  const imports: string[] = [];
  
  function visit(node: ts.Node) {
    if (ts.isImportDeclaration(node)) {
      const moduleSpecifier = node.moduleSpecifier;
      if (ts.isStringLiteral(moduleSpecifier)) {
        imports.push(moduleSpecifier.text);
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return imports;
}

function extractExportsFromAST(sourceFile: ts.SourceFile): string[] {
  const exports: string[] = [];

  function visit(node: ts.Node) {
    if (isNodeExported(node)) {
      if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) && node.name) {
        exports.push(node.name.text);
      } else if (ts.isVariableStatement(node)) {
        node.declarationList.declarations.forEach(decl => {
          if (ts.isIdentifier(decl.name)) {
            exports.push(decl.name.text);
          }
        });
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return exports;
}

export function extractSymbolsFromAST(sourceFile: ts.SourceFile | null, content: string): string[] | null {
  if (!sourceFile) return null;
  const symbols: string[] = [];
  
  function visit(node: ts.Node) {
    if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) && node.name) {
      symbols.push(node.name.text);
    } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      symbols.push(node.name.text);
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return symbols;
}

function isNodeExported(node: ts.Node): boolean {
  return (
    (ts.getCombinedModifierFlags(node as ts.Declaration) & ts.ModifierFlags.Export) !== 0 ||
    (!!node.parent && node.parent.kind === ts.SyntaxKind.SourceFile && ts.isExportAssignment(node))
  );
}

function getJSDocDescription(node: ts.Node, sourceFile: ts.SourceFile): string {
  const jsDocTags = (node as any).jsDoc;
  if (jsDocTags && jsDocTags.length > 0) {
    return jsDocTags[0].comment || "Documented in JSDoc";
  }
  return "No documentation found";
}

// =============================================================================
// C++ EXTRACTION HELPERS
// =============================================================================

function extractFunctionsCpp(content: string): FunctionInfo[] {
  const functions: FunctionInfo[] = [];
  // Regex for C++ functions: returnType name(params) {
  // Simplistic approximation
  const regex = /((?:[\w:<>_]+\s+)+)(\w+)\s*\(([^)]*)\)\s*(?:const|noexcept|override|final)*\s*\{/g;
  let match;
  while ((match = regex.exec(content)) !== null) {
    const returnType = match[1].trim();
    // Skip if it looks like a control structure
    if (['if', 'for', 'while', 'switch', 'catch'].includes(match[2])) continue;
    
    functions.push({
      name: match[2],
      signature: `${returnType} ${match[2]}(${match[3]})`,
      isExported: true, // Assuming public/header
      params: match[3].split(',').filter(Boolean).map(p => {
        const parts = p.trim().split(/\s+/);
        const name = parts.pop() || '';
        return { name, type: parts.join(' '), description: '' };
      }),
      returns: returnType,
      description: "C++ Function"
    });
  }
  return functions;
}

function extractClassesCpp(content: string): ClassInfo[] {
  const classes: ClassInfo[] = [];
  const regex = /(class|struct)\s+(\w+)(?:\s*:\s*(?:public|private|protected)\s+([^{]+))?\s*\{/g;
  let match;
  while ((match = regex.exec(content)) !== null) {
    classes.push({
      name: match[2],
      signature: match[0].trim(),
      extends: match[3] ? match[3].trim() : null,
      description: `C++ ${match[1]}`,
      methods: [], // Deep parsing requires more complex logic
      properties: []
    });
  }
  return classes;
}

function extractImportsCpp(content: string): string[] {
  const imports: string[] = [];
  const regex = /#include\s*[<"]([^>"]+)[>"]/g;
  let match;
  while ((match = regex.exec(content)) !== null) {
    imports.push(match[1]);
  }
  return imports;
}

// =============================================================================
// SWIFT EXTRACTION HELPERS
// =============================================================================

function extractFunctionsSwift(content: string): FunctionInfo[] {
  const functions: FunctionInfo[] = [];
  // Regex for Swift functions: func name(params) -> ReturnType {
  const regex = /(?:public|private|internal|fileprivate|open)?\s*func\s+(\w+)\s*\(([^)]*)\)(?:\s*->\s*([^{]+))?\s*\{/g;
  let match;
  while ((match = regex.exec(content)) !== null) {
    functions.push({
      name: match[1],
      signature: match[0].split('{')[0].trim(),
      isExported: !match[0].includes('private') && !match[0].includes('fileprivate'),
      params: match[2].split(',').filter(Boolean).map(p => {
         const parts = p.trim().split(':');
         return { name: parts[0].trim(), type: parts[1]?.trim() || 'Any', description: '' };
      }),
      returns: match[3]?.trim() || 'Void',
      description: "Swift Function"
    });
  }
  return functions;
}

function extractClassesSwift(content: string): ClassInfo[] {
  const classes: ClassInfo[] = [];
  const regex = /(?:public|private|internal|fileprivate|open)?\s*(class|struct|enum|extension|protocol)\s+(\w+)(?:\s*:\s*([^{]+))?\s*\{/g;
  let match;
  while ((match = regex.exec(content)) !== null) {
    classes.push({
      name: match[2],
      signature: match[0].trim(),
      extends: match[3] ? match[3].trim() : null,
      description: `Swift ${match[1]}`,
      methods: [],
      properties: []
    });
  }
  return classes;
}

function extractImportsSwift(content: string): string[] {
  const imports: string[] = [];
  const regex = /import\s+(\w+)/g;
  let match;
  while ((match = regex.exec(content)) !== null) {
    imports.push(match[1]);
  }
  return imports;
}