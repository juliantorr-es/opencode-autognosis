import { systemTools } from "./system-tools.js";

export default function plugin(): { tools: { [key: string]: any } } {
  return {
    tools: {
      ...systemTools(),
    },
  };
}