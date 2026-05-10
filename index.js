const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY;
const GENIEMAP_TOKEN = process.env.GENIEMAP_TOKEN;
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

// Conversation history per user
const conversations = {};

async function sendMessage(chatId, text) {
  await axios.post(`${TELEGRAM_API}/sendMessage`, {
    chat_id: chatId,
    text: text,
    parse_mode: "Markdown",
  }).catch(() => {
    // Retry without markdown if formatting fails
    axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id: chatId,
      text: text,
    });
  });
}

async function sendTyping(chatId) {
  await axios.post(`${TELEGRAM_API}/sendChatAction`, {
    chat_id: chatId,
    action: "typing",
  }).catch(() => {});
}

async function genieMapFetch(endpoint, params = {}) {
  const url = new URL(`https://api.geniemap.net/v1${endpoint}`);
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== "") url.searchParams.set(k, v);
  });
  const res = await axios.get(url.toString(), {
    headers: {
      Authorization: `Bearer ${GENIEMAP_TOKEN}`,
      Accept: "application/json",
    },
    timeout: 10000,
  });
  return res.data;
}

const SYSTEM_PROMPT = `You are the Palladium Group Real Estate AI assistant, integrated with the GenieMap UAE property database. You help real estate agents and management pull live property data, project info, areas, and neighborhoods across the UAE.

You have access to GenieMap API tools:
- get_areas: List UAE areas (with optional search query)
- get_projects: List UAE off-plan projects (with optional search, area_id, developer filters)
- get_neighborhoods: List neighborhoods (with optional search)
- get_project_detail: Get full details of a specific project by ID
- get_area_detail: Get full details of a specific area by ID

When a user asks about properties, projects, areas, or developers:
1. Use the appropriate tool to fetch live data
2. Present results in a clean, readable format
3. Include key details: name, location, developer, price range, status where available
4. Always offer to filter or search further

You support both English and Arabic. Be concise but informative. You represent Palladium Group Real Estate professionally.

Current date: ${new Date().toLocaleDateString("en-AE", { timeZone: "Asia/Dubai" })}`;

const TOOLS = [
  {
    name: "get_areas",
    description: "Get list of UAE real estate areas from GenieMap. Use when user asks about areas, locations, or zones.",
    input_schema: {
      type: "object",
      properties: {
        search: { type: "string", description: "Search term to filter areas by name" },
        page: { type: "integer", description: "Page number", default: 1 },
      },
    },
  },
  {
    name: "get_projects",
    description: "Get list of UAE real estate projects. Use when user asks about projects, developments, off-plan properties.",
    input_schema: {
      type: "object",
      properties: {
        search: { type: "string", description: "Search by project name or developer" },
        page: { type: "integer", description: "Page number", default: 1 },
      },
    },
  },
  {
    name: "get_neighborhoods",
    description: "Get list of UAE neighborhoods. Use when user asks about neighborhoods or communities.",
    input_schema: {
      type: "object",
      properties: {
        search: { type: "string", description: "Search term to filter neighborhoods" },
        page: { type: "integer", description: "Page number", default: 1 },
      },
    },
  },
  {
    name: "get_project_detail",
    description: "Get detailed information about a specific project by its ID.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "integer", description: "Project ID from GenieMap" },
      },
      required: ["id"],
    },
  },
  {
    name: "get_area_detail",
    description: "Get detailed information about a specific area by its ID.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "integer", description: "Area ID from GenieMap" },
      },
      required: ["id"],
    },
  },
];

async function executeTool(toolName, toolInput) {
  try {
    switch (toolName) {
      case "get_areas":
        return await genieMapFetch("/areas", { search: toolInput.search, page: toolInput.page || 1 });
      case "get_projects":
        return await genieMapFetch("/projects", { search: toolInput.search, page: toolInput.page || 1 });
      case "get_neighborhoods":
        return await genieMapFetch("/neighborhoods", { search: toolInput.search, page: toolInput.page || 1 });
      case "get_project_detail":
        return await genieMapFetch(`/projects/${toolInput.id}`);
      case "get_area_detail":
        return await genieMapFetch(`/areas/${toolInput.id}`);
      default:
        return { error: "Unknown tool" };
    }
  } catch (err) {
    return { error: err.message || "Failed to fetch data from GenieMap" };
  }
}

async function askClaude(chatId, userMessage) {
  if (!conversations[chatId]) conversations[chatId] = [];

  conversations[chatId].push({ role: "user", content: userMessage });

  // Keep last 20 messages to avoid token overflow
  if (conversations[chatId].length > 20) {
    conversations[chatId] = conversations[chatId].slice(-20);
  }

  let messages = [...conversations[chatId]];

  // Agentic loop — Claude may call multiple tools
  for (let i = 0; i < 5; i++) {
    const response = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model: "claude-sonnet-4-20250514",
        max_tokens: 2000,
        system: SYSTEM_PROMPT,
        tools: TOOLS,
        messages: messages,
      },
      {
        headers: {
          "x-api-key": ANTHROPIC_KEY,
          "anthropic-version": "2023-06-01",
          "Content-Type": "application/json",
        },
        timeout: 30000,
      }
    );

    const data = response.data;
    const stopReason = data.stop_reason;

    // Add assistant response to message history
    messages.push({ role: "assistant", content: data.content });

    if (stopReason === "end_turn") {
      // Extract final text
      const textBlock = data.content.find((b) => b.type === "text");
      const finalText = textBlock?.text || "Done.";

      // Save to conversation history
      conversations[chatId] = messages;

      return finalText;
    }

    if (stopReason === "tool_use") {
      // Execute all tool calls
      const toolUseBlocks = data.content.filter((b) => b.type === "tool_use");
      const toolResults = [];

      for (const toolUse of toolUseBlocks) {
        const result = await executeTool(toolUse.name, toolUse.input);
        toolResults.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: JSON.stringify(result),
        });
      }

      messages.push({ role: "user", content: toolResults });
      continue;
    }

    break;
  }

  conversations[chatId] = messages;
  return "I processed your request but couldn't generate a final response. Please try again.";
}

// Webhook endpoint
app.post("/webhook", async (req, res) => {
  res.sendStatus(200); // Always respond to Telegram immediately

  const update = req.body;
  if (!update.message?.text) return;

  const chatId = update.message.chat.id;
  const text = update.message.text;
  const firstName = update.message.from?.first_name || "there";

  // Handle commands
  if (text === "/start") {
    await sendMessage(chatId,
      `👋 Welcome ${firstName}!\n\nI'm the *Palladium Property Intelligence Bot* powered by GenieMap + Claude AI.\n\n` +
      `I can help you:\n` +
      `• 🏢 Search UAE real estate projects\n` +
      `• 📍 Find areas and neighborhoods\n` +
      `• 🔍 Get project details and availability\n` +
      `• 💬 Answer property questions in Arabic or English\n\n` +
      `Just ask me anything — e.g:\n` +
      `_"Show me projects in Dubai Marina"_\n` +
      `_"What areas are available in Abu Dhabi?"_\n` +
      `_"Tell me about JVC neighborhood"`
    );
    return;
  }

  if (text === "/clear") {
    conversations[chatId] = [];
    await sendMessage(chatId, "✅ Conversation cleared. Start fresh!");
    return;
  }

  if (text === "/help") {
    await sendMessage(chatId,
      `*Palladium Bot Commands:*\n\n` +
      `/start - Welcome message\n` +
      `/clear - Clear conversation history\n` +
      `/help - Show this help\n\n` +
      `*Example queries:*\n` +
      `• "Projects in Business Bay"\n` +
      `• "Off-plan in Yas Island"\n` +
      `• "Neighborhoods in Sharjah"\n` +
      `• "ابحث عن مشاريع في دبي مارينا"`
    );
    return;
  }

  try {
    await sendTyping(chatId);
    const reply = await askClaude(chatId, text);
    await sendMessage(chatId, reply);
  } catch (err) {
    console.error("Error:", err.message);
    await sendMessage(chatId, "⚠️ Something went wrong. Please try again in a moment.");
  }
});

app.get("/", (req, res) => res.send("Palladium Property Bot is running ✅"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Bot server running on port ${PORT}`));
