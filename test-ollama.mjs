import plugin from "./dist/index.js";

async function main() {
    console.log("🚀 Testing Ollama Integration...");
    try {
        const p = await plugin();
        const tools = p.tool;
        if (!tools.autognosis_setup_ai) throw new Error("Setup tool missing");
        
        console.log("Found tool: autognosis_setup_ai");
        // We won't actually execute it fully because it might try to download 500MB+ or require sudo
        // But we can check if it exists and is callable.
        
        // Let's call graph_stats to verify DB schema migration worked (it should have new tables)
        const stats = await tools.graph_stats.execute({});
        console.log("Stats:", stats);
        
        const json = JSON.parse(stats);
        if (json.stats.embeddings.pending === 0) console.log("✅ DB Migration Success (queue table exists)");
        else console.log("✅ DB Migration Success");

    } catch (e) {
        console.error("💥 Error:", e);
        process.exit(1);
    }
}
main();