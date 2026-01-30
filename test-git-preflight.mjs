
        import { plugin } from "./dist/index.js";
        const p = plugin();
        const tool = p.tools.git_preflight;
        console.log(JSON.stringify({ 
            exists: !!tool, 
            hasDescription: !!(tool && tool.description),
            hasExecute: !!(tool && tool.execute)
        }));
    