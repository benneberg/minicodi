# MiniCodi Architecture

This document outlines the technical architecture, data flow, and design patterns of MiniCodi. The primary design goal is to maintain a **zero-build, single-file deployable core** while enabling modular extensibility for prompts, skills, and tools.

## 1. High-Level Overview

MiniCodi is a Vanilla JavaScript Single Page Application (SPA). It avoids frameworks (React, Vue) to ensure maximum portability, fast load times, and easy debugging. State and persistence are handled entirely client-side.

```text
┌─────────────────────────────────────────────────────────────┐
│                        UI Layer                             │
│  (Vanilla JS DOM Manipulation, CSS Variables, Bottom Nav)   │
└───────────────────────────┬─────────────────────────────────┘
                            │
┌───────────────────────────▼─────────────────────────────────┐
│                      App Controller                         │
│  (Class `App`: Manages state, routing, chat logic, events)  │
└───────┬──────────────────────┬──────────────────────┬───────┘
        │                      │                      │
┌───────▼───────┐    ┌─────────▼────────┐   ┌────────▼────────┐
│ IndexedDB     │    │ LLM Clients      │   │ GitHub Client   │
│ (Persistence) │    │ (Groq, OpenRouter│   │ (REST API Wrapper)
└───────────────┘    └──────────────────┘   └─────────────────┘
```
## 2. Core Components
### 2.1. Data Layer (class DB)Uses the native IndexedDB API for robust, asynchronous local storage. It manages four object stores:projects: Metadata (name, description, stack, timestamps).messages: Chat history, linked to projectId via an index for fast retrieval.files: Snippets or full files extracted from chats or ZIP uploads.settings: Key-value pairs for API keys, preferences, and toggles.
### 2.2. Service LayerGitHub: A lightweight wrapper around the GitHub REST API. Handles authentication (via Personal Access Token), fetching user repos, reading file contents (with Base64 decoding), and fetching commit history.GroqClient / OpenRouterClient: Handles model listing and streaming chat completions. Uses fetch with ReadableStream to provide real-time typing effects in the UI.
### 2.3. UI & State Management (class App)Routing: Handled via CSS class toggling (.active) on .panel elements, triggered by the bottom navigation bar.Markdown Rendering: A custom, lightweight renderMd() function sanitizes and converts basic Markdown (code blocks, bold, lists, links) to HTML without heavy dependencies like marked.js.State: Held in memory within the App instance (this.currentProjectId, this.messages, this.activeTools) and synced to IndexedDB on mutation.
### 3. Extensibility Pattern: The Registry ModelTo add features like "Skills" or "Prompt Libraries" without bloating index.html, MiniCodi uses a Registry Pattern. Instead of hardcoding UI and logic, external JSON or JS files define capabilities:

```
// Example: /skills/context-guard.js
const SKILL_CONTEXT_GUARD = {
  id: 'context-guard',
  name: 'Context Fragmentation Guard',
  description: 'Compacts current project files to prevent token overflow.',
  execute: async (appInstance) => {
    // Logic to read IndexedDB, summarize, and inject into chat
  }
};

```
---
The App class can dynamically load these registries at runtime, render them in a "Library" UI, and bind their execute functions to button clicks. This guarantees tool-binding: the AI's system prompt is dynamically updated with the descriptions of loaded skills, preventing hallucinated tool calls.
## 4. Security ConsiderationsAPI Keys: Stored only in the user's local IndexedDB. Never transmitted to any server other than the respective LLM provider's API endpoint.XSS Prevention: All user-generated content and file names are passed through an esc() (HTML escape) function before being injected into the DOM.CORS: GitHub API and LLM API calls are made directly from the browser. Users must ensure their API providers allow browser-based requests (OpenRouter and Groq generally support this with proper keys).
## 5. Future RoadmapDynamic Module Loading: Refactor index.html to fetch /skills/*.js and /prompts/*.json dynamically on boot.Web Workers: Move heavy operations (e.g., ZIP parsing, large file summarization) to Web Workers to keep the main thread responsive.Observability: Add a local "Dev Mode" log panel to track token usage, API latency, and tool execution traces.
### 3. The App class can dynamically load these registries at runtime, render them in a "Library" UI, and bind their execute functions to button clicks. This guarantees tool-binding: the AI's system prompt is dynamically updated with the descriptions of loaded skills, preventing hallucinated tool calls.4. Security ConsiderationsAPI Keys: Stored only in the user's local IndexedDB. Never transmitted to any server other than the respective LLM provider's API endpoint.XSS Prevention: All user-generated content and file names are passed through an esc() (HTML escape) function before being injected into the DOM.CORS: GitHub API and LLM API calls are made directly from the browser. Users must ensure their API providers allow browser-based requests (OpenRouter and Groq generally support this with proper keys).5. Future RoadmapDynamic Module Loading: Refactor index.html to fetch /skills/*.js and /prompts/*.json dynamically on boot.Web Workers: Move heavy operations (e.g., ZIP parsing, large file summarization) to Web Workers to keep the main thread responsive.Observability: Add a local "Dev Mode" log panel to track token usage, API latency, and tool execution traces.

```text
minicodi/
│
├──  The App class can dynamically load these registries at runtime, render them in a "Library" UI, and bind their execute functions to button clicks. This guarantees tool-binding: the AI's system prompt is dynamically updated with the descriptions of loaded skills, preventing hallucinated tool calls.4. Security ConsiderationsAPI Keys: Stored only in the user's local IndexedDB. Never transmitted to any server other than the respective LLM provider's API endpoint.XSS Prevention: All user-generated content and file names are passed through an esc() (HTML escape) function before being injected into the DOM.CORS: GitHub API and LLM API calls are made directly from the browser. Users must ensure their API providers allow browser-based requests (OpenRouter and Groq generally support this with proper keys).5. Future RoadmapDynamic Module Loading: Refactor index.html to fetch /skills/*.js and /prompts/*.json dynamically on boot.Web Workers: Move heavy operations (e.g., ZIP parsing, large file summarization) to Web Workers to keep the main thread responsive.Observability: Add a local "Dev Mode" log panel to track token usage, API latency, and tool execution traces.         # The core, working single-page application
│
├── docs/
│   ├── ARCHITECTURE.md        # (Provided above) Deep technical breakdown
│   ├── CONTRIBUTING.md        # Guidelines for adding new skills/prompts
│   └── API_REFERENCE.md       # Details on Groq/OpenRouter/GitHub integrations
│
├── prompts/                   # JSON files for reusable AI prompts
│   ├── index.json             # Registry mapping all available prompts
│   ├── security-audit.json    # Specific prompt for vulnerability scanning
│   ├── production-ready.json  # Specific prompt for DevOps/readiness review
│   └── code-cleanup.json      # Specific prompt for refactoring/DRY principles
│
├── skills/                    # JS modules that extend app functionality
│   ├── index.js               # Registry that exports all available skills
│   ├── mobile-debugger.js     # Injects Eruda/vConsole for mobile dev
│   ├── context-guard.js       # Summarizes IndexedDB state to prevent token overflow
│   └── test-generator.js      # Scaffolds unit test plans based on open files
│
├── tools/                     # Standalone utility classes (can be extracted from index.html later)
│   ├── github-client.js       # GitHub REST API wrapper
│   ├── llm-clients.js         # Groq and OpenRouter streaming wrappers
│   └── zip-parser.js          # JSZip utility for local project loading
│
├── assets/                    # Static resources
│   ├── icons/                 # SVG icons (if you want to externalize them from the HTML)
│   └── themes/                # Future CSS theme variations
│
├── .gitignore
└── README.md # (Provided above) Main project overview
```



