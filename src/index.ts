import { systemTools } from "./system-tools.js";

export default function plugin() {
  return {
    tools: {
      ...systemTools(),
    },
  };
}
