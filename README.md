# MiniCodi

**MiniCodi** is a lightweight, privacy-focused, single-page AI development assistant designed for rapid repository reviews, maintenance, and coding tasks. Built as a vanilla HTML/CSS/JS application, it requires no build step, no backend, and runs entirely in your browser.

## ✨ Core Features

- **Local-First & Private**: All projects, chat histories, and files are stored securely in your browser's IndexedDB. Nothing is sent to external servers except explicit LLM API requests.
- **Multi-Provider LLM Support**: Native integration with **Groq** and **OpenRouter**. Easily switch between models (e.g., Llama 3, Claude Sonnet, Gemini) via the UI.
- **GitHub Integration**: Connect your GitHub account to browse repositories, read file contents directly into the chat context, and view commit history.
- **Local Project Support**: Upload `.zip` files of local projects to parse and store them directly in the browser for AI-assisted review.
- **Role-Based AI Personas**: Switch between General, Frontend Expert, Backend Expert, Code Reviewer, and Architect modes for tailored responses.
- **Mobile-Optimized**: Responsive, touch-friendly UI with a bottom navigation bar, designed to work seamlessly on mobile devices.

## 🚀 Quick Start

1. Clone or download this repository.
2. Open `dev/index.html` directly in your web browser (or serve it via GitHub Pages / a local static server).
3. Go to the **Settings** tab and add your **Groq** or **OpenRouter** API key.
4. Create a new **Project**, select a model, and start chatting!

## 🛠️ Development & Extension

MiniCodi is designed to be extended. While the core application lives in `dev/index.html`, the architecture supports modular expansion via:
- `/prompts`: Reusable, categorized system prompts for audits and reviews.
- `/skills`: JavaScript modules that extend app capabilities (e.g., mobile debugging, context compaction).
- `/tools`: Standalone utility classes (e.g., GitHub API wrappers, ZIP parsers).

See [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) for a deep dive into the codebase structure and extension patterns.

## 📄 License

MIT License. Feel free to use, modify, and distribute for your personal or professional workflows.
