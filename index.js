const express = require(“express”);
const axios = require(“axios”);

const app = express();
app.use(express.json());

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY;
const GENIEMAP_TOKEN = process.env.GENIEMAP_TOKEN;
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

const conversations = {};

async function sendMessage(chatId, text) {
try {
await axios.post(`${TELEGRAM_API}/sendMessage`, {
chat_id: chatId,
text: text,
parse_mode: “Markdown”,
});
} catch (e) {
try {
await axios.post(`${TELEGRAM_API}/sendMessage`, {
chat_id: chatId,
text: text.replace(/[*_`]/g, “”),
});
} catch (e2) {
console.log(“sendMessage failed:”, e2.message);
}
}
}

async function sendTyping(chatId) {
try {
await axios.post(`${TELEGRAM_API}/sendChatAction`, {
chat_id: chatId,
action: “typing”,
});
} catch (e) {}
}

async function genieMapFetch(endpoint, params = {}) {
const url = new URL(`https://api.geniemap.net/v1${endpoint}`);
Object.entries(params).forEach(([k, v]) => {
if (v !== undefined && v !== “”) url.searchParams.set(k, v);
});
const res = await axios.get(url.toString(), {
headers: {
Authorization: `Bearer ${GENIEMAP_TOKEN}`,
Accept: “application/json”,
},
timeout: 10000,
});
return res.data;
}

const SYSTEM_PROMPT = `You are the Palladium Group Real Estate AI assistant, integrated with the GenieMap UAE property database. You help real estate agents pull live UAE property data.

You have access to these GenieMap tools:

- get_areas: List UAE areas
- get_projects: List UAE off-plan projects
- get_neighborhoods: List neighborhoods
- get_project_detail: Get full details of a project by ID
- get_area_detail: Get full details of an area by ID

When asked about properties, projects, areas or developers, use the tools to fetch live data. Present results cleanly. Support English and Arabic. Be concise and professional.`;

const TOOLS = [
{
name: “get_areas”,
description: “Get list of UAE real estate areas from GenieMap.”,
input_schema: {
type: “object”,
properties: {
search: { type: “string”, description: “Search term” },
page: { type: “integer”, description: “Page number” },
},
},
},
{
name: “get_projects”,
description: “Get list of UAE real estate projects.”,
input_schema: {
type: “object”,
properties: {
search: { type: “string”, description: “Search term” },
page: { type: “integer”, description: “Page number” },
},
},
},
{
name: “get_neighborhoods”,
description: “Get list of UAE neighborhoods.”,
input_schema: {
type: “object”,
properties: {
search: { type: “string”, description: “Search term” },
page: { type: “integer”, description: “Page number” },
},
},
},
{
name: “get_project_detail”,
description: “Get detailed info about a specific project by ID.”,
input_schema: {
type: “object”,
properties: {
id: { type: “integer”, description: “Project ID” },
},
required: [“id”],
},
},
{
name: “get_area_detail”,
description: “Get detailed info about a specific area by ID.”,
input_schema: {
type: “object”,
properties: {
id: { type: “integer”, description: “Area ID” },
},
required: [“id”],
},
},
];

async function executeTool(toolName, toolInput) {
try {
switch (toolName) {
case “get_areas”:
return await genieMapFetch(”/areas”, { search: toolInput.search, page: toolInput.page || 1 });
case “get_projects”:
return await genieMapFetch(”/projects”, { search: toolInput.search, page: toolInput.page || 1 });
case “get_neighborhoods”:
return await genieMapFetch(”/neighborhoods”, { search: toolInput.search, page: toolInput.page || 1 });
case “get_project_detail”:
return await genieMapFetch(`/projects/${toolInput.id}`);
case “get_area_detail”:
return await genieMapFetch(`/areas/${toolInput.id}`);
default:
return { error: “Unknown tool” };
}
} catch (err) {
console.log(“Tool error:”, toolName, err.message);
return { error: err.message, note: “GenieMap API may require IP whitelisting” };
}
}

async function askClaude(chatId, userMessage) {
if (!conversations[chatId]) conversations[chatId] = [];
conversations[chatId].push({ role: “user”, content: userMessage });
if (conversations[chatId].length > 20) {
conversations[chatId] = conversations[chatId].slice(-20);
}

let messages = […conversations[chatId]];

for (let i = 0; i < 5; i++) {
const response = await axios.post(
“https://api.anthropic.com/v1/messages”,
{
model: “claude-sonnet-4-20250514”,
max_tokens: 2000,
system: SYSTEM_PROMPT,
tools: TOOLS,
messages: messages,
},
{
headers: {
“x-api-key”: ANTHROPIC_KEY,
“anthropic-version”: “2023-06-01”,
“Content-Type”: “application/json”,
},
timeout: 30000,
}
);

```
const data = response.data;
messages.push({ role: "assistant", content: data.content });

if (data.stop_reason === "end_turn") {
  const textBlock = data.content.find((b) => b.type === "text");
  conversations[chatId] = messages;
  return textBlock?.text || "Done.";
}

if (data.stop_reason === "tool_use") {
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
```

}

conversations[chatId] = messages;
return “I processed your request. Please try again.”;
}

app.post(”/webhook”, async (req, res) => {
res.sendStatus(200);

try {
const update = req.body;
if (!update.message?.text) return;

```
const chatId = update.message.chat.id;
const text = update.message.text;
const firstName = update.message.from?.first_name || "there";

console.log(`Message from ${chatId}: ${text.slice(0, 50)}`);

if (text === "/start") {
  await sendMessage(chatId,
    `👋 Welcome ${firstName}!\n\nI'm the *Palladium Property Bot* powered by GenieMap + Claude AI.\n\nAsk me anything:\n• "Show projects in Dubai Marina"\n• "What areas are in Abu Dhabi?"\n• "Find neighborhoods in JVC"\n\nType /help for commands.`
  );
  return;
}

if (text === "/clear") {
  conversations[chatId] = [];
  await sendMessage(chatId, "✅ Conversation cleared!");
  return;
}

if (text === "/help") {
  await sendMessage(chatId,
    `*Commands:*\n/start - Welcome\n/clear - Clear history\n/help - Help\n\n*Examples:*\n• Projects in Business Bay\n• Areas in Dubai\n• Neighborhoods in Sharjah\n• مشاريع في دبي مارينا`
  );
  return;
}

await sendTyping(chatId);
const reply = await askClaude(chatId, text);
await sendMessage(chatId, reply);
```

} catch (err) {
console.log(“Webhook error:”, err.message);
}
});

app.get(”/”, (req, res) => res.send(“Palladium Property Bot is running ✅”));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Bot running on port ${PORT}`));
