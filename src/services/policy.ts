import * as fsSync from "node:fs";
import * as path from "node:path";
import { Logger } from "./logger.js";

export interface PolicyViolation {
  file: string;
  line: number;
  message: string;
  severity: "error" | "warning";
}

export class PolicyEngine {
  private rules = [
    {
      name: "No Debug Logs",
      pattern: /console\.(log|debug|info)\(/,
      message: "Direct console logging is forbidden in production code.",
      severity: "error" as const
    },
    {
      name: "No TODO Debt",
      pattern: /\/\/\s*TODO/,
      message: "New TODOs must be linked to a ticket ID.",
      severity: "warning" as const
    },
    {
      name: "Forbidden Eval",
      pattern: /eval\(/,
      message: "Use of 'eval' is strictly forbidden for security reasons.",
      severity: "error" as const
    }
  ];

  public checkContent(file: string, content: string): PolicyViolation[] {
    const violations: PolicyViolation[] = [];
    const lines = content.split('\n');

    for (const rule of this.rules) {
      lines.forEach((line, index) => {
        if (rule.pattern.test(line)) {
          violations.push({
            file,
            line: index + 1,
            message: rule.message,
            severity: rule.severity
          });
        }
      });
    }
    return violations;
  }

  public checkDiff(diff: string): PolicyViolation[] {
    // Check only added lines in diffs
    const addedLines = diff.split('\n').filter(l => l.startsWith('+') && !l.startsWith('+++'));
    const violations: PolicyViolation[] = [];
    
    for (const rule of this.rules) {
      if (rule.pattern.test(addedLines.join('\n'))) {
        violations.push({
          file: "diff",
          line: 0,
          message: `[Policy: ${rule.name}] ${rule.message}`,
          severity: rule.severity
        });
      }
    }
    return violations;
  }
}

export const policyEngine = new PolicyEngine();
