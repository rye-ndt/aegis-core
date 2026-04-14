# Technical Specification: Deterministic Intent Routing & Dual-Schema Extraction

## 1. Core Architecture: The Dual-Schema Model
Every tool must define two distinct schemas. This separates what the user says from what the blockchain needs.

* **`requiredFields` (Human-Readable):** * **Purpose:** The exact parameters the LLM needs to extract from the user's natural language prompt.
    * **Structure:** A JSON object defining field names, expected data types, and enum lists if applicable.
    * **Rule:** Field names here **must** belong to a strict, pre-defined enum list (e.g., `fromTokenSymbol`, `toTokenSymbol`). We use these enum names to trigger specific background resolvers.
* **`finalSchema` (Machine-Readable):**
    * **Purpose:** The exact parameters required to build the on-chain transaction or execute the tool.
    * **Structure:** Same format as above, but uses absolute values (e.g., `from_token_address`, `raw_amount_wei`). It cannot be filled by the LLM directly; it is populated by our background resolvers.

## 2. Supported Intent Commands
These slash commands bypass general chat and map directly to specific tools in the database:
* `/money` (View portfolio/balances)
* `/buy` (Swap default base token for target token)
* `/sell` (Swap target token for default base token)
* `/convert` (Swap Token A for Token B)
* `/topup` (Trigger fiat on-ramp)
* `/dca` (Schedule recurring automated swaps)

## 3. Standardized Enums & Resolvers
For every field extracted in the `requiredFields` schema, there must be a mapped **Resolver Function** that converts it into the data needed for the `finalSchema`. 

Additionally, system-level addresses (like the current user's wallet) share resolver infrastructure to minimize code duplication.

| `requiredFields` Enum | What the LLM Extracts | Resolver Procedure | `finalSchema` Output |
| :--- | :--- | :--- | :--- |
| `fromTokenSymbol` | "USDC", "USDT" | Queries database for the symbol. If multiple matches exist, triggers disambiguation. Returns the contract address. | `from_token_address` (0x...) |
| `toTokenSymbol` | "AVAX", "RON" | Queries database for the symbol. If multiple matches exist, triggers disambiguation. Returns the contract address. | `to_token_address` (0x...) |
| `readableAmount` | "5", "half", "all" | Fetches token decimals from DB (using the resolved token address), converts the human number into BigInt. | `raw_amount` (Wei) |
| `userHandle` | "@rye_ndt" | Queries MTProto for Telegram ID, then queries Privy for the associated EVM wallet address. | `recipient_address` (0x...) |

**Current User Address Resolution:** To obtain the current user's sender address (e.g., `sender_address` for the `finalSchema`), do not prompt the LLM. Instead, inject the session's Telegram ID directly into the exact same MTProto/Privy resolver logic used by `userHandle` to securely fetch their Smart Contract Account (SCA) address.

## 4. The Execution Pipeline

### Phase 1: Routing
1. **Intercept:** Check if the incoming user message starts with a recognized intent command.
2. **Fallback:** If no command is found, route to the standard conversational LLM.
3. **Map to Tool:** Extract the command enum and query the database to retrieve the associated Tool and its `requiredFields` schema.
4. **Session State:** Open a conversation loop, storing all subsequent messages until the intent completes or fails.

### Phase 2: LLM Extraction Loop (Max 10 Turns)
1. **Prompt the LLM:** Send the conversation history and the `requiredFields` schema to the LLM. Force structured JSON output using OpenAI/Zod formatting.
2. **Evaluate JSON:**
    * If **complete**, proceed to Phase 3.
    * If **incomplete**, the LLM must return a JSON response containing the half-filled schema and a `question` field (e.g., *"Which token do you want to spend?"*).
3. **Prompt User:** Send the `question` string to the user on Telegram. Wait for their reply, append it to the history, and repeat Phase 2.
4. **Timeout:** If the schema is not filled after 10 cycles, abort the process, clear the state, and ask the user to start over.

### Phase 3: Data Resolution Loop (Max 10 Turns)
1. **System Injections:** Resolve the current user's address using their session Telegram ID via the user handle resolver and append it to the context payload.
2. **Trigger Resolvers:** Iterate through the populated `requiredFields` object. Fire the specific resolver function mapped to each enum key (`fromTokenSymbol`, `toTokenSymbol`, `readableAmount`, `userHandle`).
3. **Disambiguation (Sub-Loop):** If a token resolver hits an ambiguous result (e.g., querying "RON" returns three different token contracts):
    * Pause resolution.
    * Send a numbered list of options to the user on Telegram (e.g., *"1. RON (Mainnet), 2. RON (Bridged)"*).
    * Wait for the user to reply with a number selection.
    * **Timeout:** If disambiguation takes more than 10 cycles, abort the process and reset.
4. **Compile Payload:** Once all resolvers successfully return data, merge the original `requiredFields`, the injected system variables, and the newly resolved machine-readable data into a single, comprehensive JSON payload.

### Phase 4: Finalization
1. **Populate `finalSchema`:** Use the compiled payload to fill the exact requirements of the tool's `finalSchema`.
2. **Log & Confirm:** Send the fully populated `finalSchema` JSON back to the user as a Telegram message for final confirmation before executing the on-chain transaction.