Mnemosyne — Third-Party Open Source Notices
============================================

This project incorporates code and concepts from the following open-source
projects, each licensed under MIT unless otherwise noted:

1. LiteLLM
   Repository: https://github.com/BerriAI/litellm
   Copyright (c) 2023 BerriAI
   License: MIT
   Usage: Model Gateway infrastructure

2. mcp-gateway (by eznix86)
   Repository: https://github.com/eznix86/mcp-gateway
   Copyright (c) 2025 eznix86
   License: MIT
   Usage: MCP Gateway foundation
   Modifications: Added lazy loading, dynamic registration, skill documents

3. ai-gateway (by cp50)
   Repository: https://github.com/cp50/ai-gateway
   Copyright (c) 2025 cp50
   License: MIT
   Usage: Routing logic reference
   Modifications: Adapted Welford's algorithm for provider health scoring

4. twig-memory (衔枝)
   Repository: https://github.com/qimingjiu/twig-memory
   Copyright (c) 2026 qimingjiu
   License: MIT
   Usage: Narrative Memory Engine
   Modifications: Integrated as HTTP service within Mnemosyne runtime

5. LangGraph
   Repository: https://github.com/langchain-ai/langgraph
   Copyright (c) 2024 LangChain, Inc.
   License: MIT
   Usage: Agent orchestration framework

6. RedisVL
   Repository: https://github.com/redis/redis-vl-python
   Copyright (c) Redis
   License: BSD-3-Clause
   Usage: Semantic cache implementation

7. Qdrant
   Repository: https://github.com/qdrant/qdrant
   Copyright (c) Qdrant Team
   License: Apache-2.0
   Usage: Optional vector database for knowledge graph

8. Bifrost (by Maxim AI)
   Repository: https://github.com/maximhq/bifrost
   Copyright (c) 2025 Maxim AI
   License: Apache-2.0
   Usage: Reference architecture for LLM + MCP dual gateway

---

Academic References
-------------------

- "Consolidator: Learning Persistent Routed Memory Across Context Boundaries"
  arXiv:2608.11701 (August 2026)

- "SCOUT: Selective Context Optimization for Efficient Tool-Augmented LLMs"
  arXiv:2608.23992 (August 2026)

- "Intent-Based Routing for AI Gateways in 5G Networks"
  arXiv:2608.22644 (August 2026)
