A short, concise breakdown of how **Prompts**, **Skills**, and **Tools** work together in MiniCodi to create a robust, modular AI assistant:

### 1. Prompts (The "What to Say")
* **What they are**: Pre-written, categorized text templates (e.g., "Security Audit", "Code Cleanup").
* **Purpose**: Ensure consistent, high-quality AI responses without typing the same instructions repeatedly. 
* **How it works**: Stored as simple JSON. Clicking one injects the text directly into your chat input or system prompt.

### 2. Skills (The "What to Do")
* **What they are**: Small, self-contained JavaScript functions that perform local actions or modify the app’s state (e.g., "Mobile Debugger", "Context Fragmentation Guard").
* **Purpose**: Extend the app's actual capabilities beyond just generating text. 
* **How it works**: Defined in a registry. When executed, they run local code (like injecting a console script) and can dynamically update the AI's system prompt so the AI *knows* the skill was used, preventing hallucinated tool calls.

### 3. Tools (The "How it Works")
* **What they are**: Standalone utility classes or API wrappers (e.g., `GitHubClient`, `ZipParser`, `GroqClient`).
* **Purpose**: Handle the heavy lifting of data fetching, parsing, and external communication.
* **How it works**: Skills and the main `App` class call these tools to get data (like reading a file from GitHub) so the AI has accurate, real-time context.

---

### 💡 The Synergy (The "Agent Loop")
1. **Tool** fetches the code.
2. **Skill** compacts that code to prevent context fragmentation and tells the AI, "I have summarized the files."
3. **Prompt** provides the exact lens (e.g., "Review for security") through which the AI analyzes that summarized data. 

This separation keeps `index.html` clean, prevents context bloat, and guarantees the AI only "uses" tools that actually exist in your code. 
