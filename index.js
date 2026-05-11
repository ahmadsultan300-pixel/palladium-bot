const express = require("express");
const axios = require("axios");
const app = express();
app.use(express.json());
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY;
const GENIEMAP_TOKEN = process.env.GENIEMAP_TOKEN;
const TELEGRAM_API = "https://api.telegram.org/bot" + TELEGRAM_TOKEN;
const conversations = {};
async function sendMessage(chatId, text) {
  try { await axios.post(TELEGRAM_API + "/sendMessage", { chat_id: chatId, text: text }); }
  catch (e) {}
}
async function sendTyping(chatId) {
  try { await axios.post(TELEGRAM_API + "/sendChatAction", { chat_id: chatId, action: "typing" }); }
  catch (e) {}
}
async function genieMapFetch(endpoint, params) {
  if (!params) params = {};
  var url = "https://api.geniemap.net/v1" + endpoint;
  var q = [];
  Object.keys(params).forEach(function(k) { if (params[k]) q.push(k + "=" + params[k]); });
  if (q.length) url = url + "?" + q.join("&");
  var res = await axios.get(url, { headers: { Authorization: "Bearer " + GENIEMAP_TOKEN, Accept: "application/json" }, timeout: 10000 });
  return res.data;
}
var TOOLS = [
  { name: "get_areas", description: "Get UAE areas", input_schema: { type: "object", properties: { search: { type: "string" }, page: { type: "integer" } } } },
  { name: "get_projects", description: "Get UAE projects", input_schema: { type: "object", properties: { search: { type: "string" }, page: { type: "integer" } } } },
  { name: "get_neighborhoods", description: "Get UAE neighborhoods", input_schema: { type: "object", properties: { search: { type: "string" }, page: { type: "integer" } } } },
  { name: "get_project_detail", description: "Get project detail by ID", input_schema: { type: "object", properties: { id: { type: "integer" } }, required: ["id"] } },
  { name: "get_area_detail", description: "Get area detail by ID", input_schema: { type: "object", properties: { id: { type: "integer" } }, required: ["id"] } }
];
async function executeTool(name, input) {
  try {
    if (name === "get_areas") return await genieMapFetch("/areas", { search: input.search, page: input.page || 1 });
    if (name === "get_projects") return await genieMapFetch("/projects", { search: input.search, page: input.page || 1 });
    if (name === "get_neighborhoods") return await genieMapFetch("/neighborhoods", { search: input.search, page: input.page || 1 });
    if (name === "get_project_detail") return await genieMapFetch("/projects/" + input.id);
    if (name === "get_area_detail") return await genieMapFetch("/areas/" + input.id);
    return { error: "Unknown tool" };
  } catch (err) { return { error: err.message }; }
}
async function askClaude(chatId, userMessage) {
  if (!conversations[chatId]) conversations[chatId] = [];
  conversations[chatId].push({ role: "user", content: userMessage });
  if (conversations[chatId].length > 20) conversations[chatId] = conversations[chatId].slice(-20);
  var messages = conversations[chatId].slice();
  var SYSTEM = "You are Palladium Group Real Estate AI assistant with GenieMap UAE property data. Use tools to fetch live data when asked about projects, areas, or neighborhoods. Support English and Arabic.";
  for (var i = 0; i < 5; i++) {
    var res = await axios.post("https://api.anthropic.com/v1/messages", { model: "claude-sonnet-4-20250514", max_tokens: 2000, system: SYSTEM, tools: TOOLS, messages: messages }, { headers: { "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01", "Content-Type": "application/json" }, timeout: 30000 });
    var data = res.data;
    messages.push({ role: "assistant", content: data.content });
    if (data.stop_reason === "end_turn") {
      var t = data.content.find(function(b) { return b.type === "text"; });
      conversations[chatId] = messages;
      return t ? t.text : "Done.";
    }
