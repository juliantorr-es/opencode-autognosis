import { z } from "zod";
import { type AgentProfile, type RunEval, AgentRank } from "./schemas.js";

/**
 * Access Tier Module (Non-Kernel)
 * Handles the logic for MMR scaling, rank promotions, and tool allowances.
 */
export const PolicyModule = {
    calculateNewMMR(currentMMR: number, runEval: RunEval): number {
        const complexityMultiplier = runEval.evidence_ids.length > 0 ? 1.5 : 0.5;
        let delta = runEval.mmr_delta * complexityMultiplier;
        if (runEval.breakdown.safety < 0.5) delta -= 100;
        return Math.max(0, currentMMR + delta);
    },

    determineRank(mmr: number): z.infer<typeof AgentRank> {
        if (mmr < 1000) return "wood";
        if (mmr < 2000) return "bronze";
        if (mmr < 3000) return "silver";
        if (mmr < 4000) return "gold";
        if (mmr < 5000) return "platinum";
        if (mmr < 6000) return "emerald";
        if (mmr < 7000) return "diamond";
        if (mmr < 8000) return "master";
        return "challenger";
    },

    getAllowedTools(rank: string): string[] {
        const base = ["code_search", "code_read", "code_status", "code_job"];
        const analysis = [...base, "code_analyze", "code_context"];
        const mutation = [...analysis, "code_propose"];
        const kernel = [...mutation, "code_setup", "code_contract", "code_skill", "code_trace"];

        if (["wood", "bronze"].includes(rank)) return base;
        if (["silver", "gold"].includes(rank)) return analysis;
        if (["platinum", "emerald"].includes(rank)) return mutation;
        return kernel;
    }
};

export const policyEngine = {
    checkDiff(diff: string): any[] {
        // Placeholder for policy engine diff checking
        return [];
    }
};