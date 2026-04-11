# mantle-mcp Server Instructions

Mantle L2 tools for AI agents. Read chain state, simulate transactions, and build unsigned payloads.

## Rules

### 1. Never Hold Private Keys

`mantle-mcp` never signs and never broadcasts transactions. All build tools return unsigned payloads only.

### 2. Verify Addresses Through Registry/Token Resolution

Before any transaction-building path, resolve/validate addresses with:

- `mantle_resolveAddress`
- `mantle_validateAddress`
- `mantle_resolveToken` (with canonical token-list cross-check)

### 3. Simulate Before Presenting

Always present a fresh simulation result before any signing step.

### 4. Present `human_summary` Before Signing

Every transaction-building tool must return and display `human_summary` prior to user confirmation/signing.

### 5. MNT is the Gas Token

Mantle gas estimates and native balances are denominated in MNT (not ETH).

### 6. Never Fabricate Data

If price/address/simulation data cannot be trusted, return typed errors or explicit null/low-confidence outputs instead of guessed values.
