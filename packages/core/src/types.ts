export interface Tool {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required: string[];
  };
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

export interface Resource {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
}

export type Network = "mainnet" | "sepolia";
