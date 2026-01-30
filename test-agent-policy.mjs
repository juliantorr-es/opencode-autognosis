
        import { plugin } from "./dist/index.js";
        const p = plugin();
        const description = p.tools.git_preflight ? p.tools.git_preflight.description : '';
        console.log(JSON.stringify({ 
            hasPolicy: description.includes('AGENT USAGE POLICY'),
            hasWorkflow: description.includes('STANDARD WORKFLOW'),
            descriptionLength: description.length
        }));
    