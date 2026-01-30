
        import plugin from "./dist/index.js";
        const p = await plugin();
        const testTools = ['test_run_contract', 'test_integration_parallel', 'test_performance_benchmark', 'test_validate_patches'];
        const results = {};
        for (const toolName of testTools) {
            results[toolName] = !!p.tool[toolName];
        }
        console.log(JSON.stringify(results));
    