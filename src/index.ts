import { unifiedTools } from "./unified-api.js";

export const AutognosisPlugin = async () => {
  return {
    tool: {
      ...unifiedTools(),
    },
  };
};

export default AutognosisPlugin;