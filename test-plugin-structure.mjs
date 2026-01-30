
        import { plugin } from "./dist/index.js";
        const p = plugin();
        const toolNames = Object.keys(p.tools);
        console.log(JSON.stringify({ count: toolNames.length, tools: toolNames.sort() }));
    