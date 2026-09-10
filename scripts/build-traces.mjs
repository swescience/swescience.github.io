import fs, { mkdtempSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";

const repoRoot = path.resolve(new URL("..", import.meta.url).pathname);
const runsRoot = process.env.TRACE_RUNS_ROOT ?? "/Users/fnlp/workspace/agent/opus-test/runs";
const benchmarkRoot = path.dirname(runsRoot);
const reportsRoot = path.join(benchmarkRoot, "reports");
const gptSelectionFile = path.join(repoRoot, "scripts/data/gpt-run-selection.json");
const gptMacPrimaryRoot = process.env.GPT_MAC_PRIMARY_ROOT ?? "/Users/fnlp/workspace/agent/my_science_bench";
const gptMacPlatformRoot = process.env.GPT_MAC_PLATFORM_ROOT ?? "/Users/fnlp/workspace/agent/my_science_bench_platform_amd64";
const gptWslArchive = process.env.GPT_WSL_ARCHIVE ?? "/Users/fnlp/Downloads/wsl_selected_runs_without_agent_verifier.tar.gz";
const gptWslRunsRoot = process.env.GPT_WSL_RUNS_ROOT ?? null;
let gptExtractedRunsRoot = null;
const obsoleteOutputRoot = path.join(repoRoot, "public/traces/opus-5-max-ucloud");
const uniformTracesRoot = process.env.UNIFORM_TRACES_ROOT
  ?? "/Users/fnlp/Downloads/gpt56_sol_kimi_k3_ds_v4_pro_max_uniform_traces_20260901";

const tokenUsageFiles = {
  opus: process.env.OPUS_TOKEN_USAGE_FILE
    ?? path.join(reportsRoot, "ucloud-opus-max-002-120-audit/token_usage_by_run.csv"),
  glm: process.env.GLM_TOKEN_USAGE_FILE
    ?? path.join(reportsRoot, "glm-5.2-max-with_auxiliary-002-120-audit/token_usage_by_run.csv"),
};

const localResultRoots = {
  kimi: process.env.KIMI_RESULTS_ROOT
    ?? path.join(uniformTracesRoot, "kimi-k3-max"),
  deepseek: process.env.DEEPSEEK_RESULTS_ROOT
    ?? path.join(uniformTracesRoot, "deepseek-v4-pro-max"),
  gpt: process.env.GPT_RESULTS_ROOT
    ?? path.join(uniformTracesRoot, "gpt-5.6-sol-max"),
};

function readJson(file) {
  const text = fs.readFileSync(file, "utf8");
  try {
    return JSON.parse(text);
  } catch (error) {
    // Kimi's exported stream can contain bare non-finite numeric values in a
    // few tool-output fragments; treat those fragments as JSON nulls.
    const normalized = text.replace(/(^|[,\[:])\s*-?(?:Infinity|NaN)(?=\s*[,\]}])/g, "$1null");
    if (normalized === text) throw error;
    return JSON.parse(normalized);
  }
}

function runArtifact(runRoot, name) {
  const candidates = [path.join(runRoot, "logs", name), path.join(runRoot, name)];
  const file = candidates.find((candidate) => fs.existsSync(candidate));
  if (!file) throw new Error(`Missing ${name} under selected run ${runRoot}`);
  return file;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        field += character;
      }
    } else if (character === '"') {
      quoted = true;
    } else if (character === ",") {
      row.push(field);
      field = "";
    } else if (character === "\n") {
      row.push(field.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += character;
    }
  }
  if (field.length || row.length) {
    row.push(field.replace(/\r$/, ""));
    rows.push(row);
  }
  const [headers, ...records] = rows;
  return records.filter((record) => record.some(Boolean)).map((record) => Object.fromEntries(headers.map((header, index) => [header, record[index] ?? ""])));
}

function numericOrNull(value) {
  if (value === undefined || value === null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function firstValue(row, keys) {
  for (const key of keys) {
    if (row[key] !== undefined && row[key] !== "") return row[key];
  }
  return null;
}

function readTokenUsage(file) {
  if (!fs.existsSync(file)) throw new Error(`Missing token usage source: ${file}`);
  const rows = file.endsWith(".json")
    ? (readJson(file).tasks ?? []).map((task) => ({
      task_id: task.task_id,
      ...task.usage,
    }))
    : parseCsv(fs.readFileSync(file, "utf8"));
  if (rows.length !== 119) throw new Error(`Expected 119 token usage rows in ${file}, found ${rows.length}`);
  const usageByTask = new Map();
  for (const row of rows) {
    const taskId = String(firstValue(row, ["task_id", "task"]) ?? "").replace(/^task_/, "").padStart(3, "0");
    if (!/^\d{3}$/.test(taskId)) throw new Error(`Token usage source has invalid task id in ${file}`);
    if (usageByTask.has(taskId)) throw new Error(`Token usage source has duplicate task ${taskId}: ${file}`);
    usageByTask.set(taskId, {
      input_tokens: numericOrNull(firstValue(row, ["input_tokens", "input"])),
      output_tokens: numericOrNull(firstValue(row, ["output_tokens", "output"])),
      total_tokens: numericOrNull(firstValue(row, ["total_tokens", "total"])),
      cache_read_tokens: numericOrNull(firstValue(row, ["cache_read_tokens", "cache_read"])),
      cache_creation_tokens: numericOrNull(firstValue(row, ["cache_creation_tokens", "cache_create"])),
      call_count: numericOrNull(firstValue(row, ["call_count", "calls"])),
      cost_usd: numericOrNull(firstValue(row, ["cost_usd"])),
      source_trial_id: firstValue(row, ["trial_id"]),
      source_run_path: firstValue(row, ["trial_root", "run_dir"]),
    });
  }
  if (usageByTask.size !== 119) throw new Error(`Token usage source has duplicate or missing tasks: ${file}`);
  return usageByTask;
}

const taskCsv = parseCsv(fs.readFileSync(path.join(repoRoot, "data/tasks.csv"), "utf8"));
const taskById = new Map(taskCsv.map((task) => [task.task_id, task]));
if (taskCsv.length !== 119 || taskById.size !== 119) throw new Error("data/tasks.csv must contain 119 unique published tasks");

function sanitizeText(value, runRoot) {
  return String(value ?? "")
    .replaceAll(runRoot, "<run>")
    .replace(/\/Users\/[^\s/]+\/workspace\/agent\/opus-test/g, "<host-workspace>")
    .replace(/\/mnt\/shared-storage-user\/[A-Za-z0-9_./-]+/g, "<source-workspace>")
    .replace(/\/workspace\/task_\d+/g, "/workspace/task")
    .replace(/\/app\/private_tests\/task_\d+/g, "/verifier/private_tests")
    .replace(/\/claude-home\//g, "<agent-home>/")
    .replaceAll("linux/amd64", "<redacted>")
    .replace(/api\.modelverse\.cn/gi, "<redacted>")
    .replace(/[a-z0-9.-]+\.sii\.edu\.cn/gi, "<redacted>")
    .replace(/host\.docker\.internal(?::\d+)?/gi, "<redacted>")
    .replace(/science-bench-official-gateway-[a-z0-9-]+(?::\d+)?/gi, "<redacted>")
    .replace(/\b(ANTHROPIC_AUTH_TOKEN|CODEX_ACCESS_TOKEN|SCIENCE_BENCH_GATEWAY_TOKEN)\s*=\s*[^\s]+/g, "$1=<redacted>")
    .replace(/\bartifacts\/model\.patch\b/gi, "<patch-omitted>")
    .replace(/\bmodel\.patch\b/gi, "<patch-omitted>")
    .replace(/\bUCloud\b/g, "<redacted>")
    .replace(/\b((?:ANTHROPIC|OPENAI|HF|HUGGINGFACE|DOCKER)[A-Z0-9_]*_API_KEY)\s*=\s*[^\s]+/gi, "$1=<redacted>")
    .replace(/\b(?:sk|rk)-[A-Za-z0-9_-]{12,}\b/g, "<redacted>");
}

function fullText(value, runRoot) {
  return { text: sanitizeText(value, runRoot), truncated: false };
}

function reasoningText(item) {
  if (typeof item?.thinking === "string" && item.thinking) return item.thinking;
  if (typeof item?.text === "string" && item.text) return item.text;
  const collect = (value) => {
    if (!Array.isArray(value)) return [];
    return value.map((block) => {
      if (typeof block === "string") return block;
      if (!block || typeof block !== "object") return "";
      return typeof block.text === "string" ? block.text : "";
    }).filter(Boolean);
  };

  // Codex may retain a readable content block alongside an opaque encrypted payload.
  // Prefer the full content and use summary text only when content is absent.
  const content = collect(item?.content);
  if (content.length) return content.join("\n\n");
  return collect(item?.summary).join("\n\n");
}

function reasoningFields(item) {
  const text = reasoningText(item);
  if (!text) {
    const encrypted = typeof item?.encrypted_content === "string" && item.encrypted_content.length > 0;
    return { redacted: true, reasoningStatus: encrypted ? "encrypted" : "unavailable" };
  }
  // Readable reasoning is intentionally preserved without sanitization or
  // truncation; the viewer must show the model's original thought text.
  return { text, truncated: false, redacted: false, reasoningStatus: "readable" };
}

function safeInput(input, runRoot) {
  if (!input || typeof input !== "object") return null;
  const copy = (value) => {
    if (typeof value === "string") return sanitizeText(value, runRoot);
    if (Array.isArray(value)) return value.map(copy);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, copy(nested)]));
    return value;
  };
  return copy(input);
}

function resultContent(block) {
  if (!block) return "";
  if (typeof block === "string") return block;
  if (Array.isArray(block)) return block.map(resultContent).filter(Boolean).join("\n");
  if (typeof block === "object") {
    if (typeof block.content === "string") return block.content;
    if (Array.isArray(block.content)) return resultContent(block.content);
    if (typeof block.text === "string") return block.text;
  }
  return "";
}

function eventTimestamp(event) {
  const timestamp = event?.timestamp;
  if (!timestamp) return null;
  const time = Date.parse(timestamp);
  return Number.isFinite(time) ? time : null;
}

function normalizeTimestamp(value) {
  if (!value) return null;
  if (typeof value === "number" || /^\d+(?:\.\d+)?$/.test(String(value))) {
    const epoch = Number(value);
    if (Number.isFinite(epoch)) return new Date(epoch < 1e12 ? epoch * 1000 : epoch).toISOString();
  }
  const normalized = String(value).replace(/NZ$/, "Z");
  const time = Date.parse(normalized);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function findFiles(root, predicate) {
  if (!fs.existsSync(root)) return [];
  const files = [];
  const pending = [root];
  while (pending.length) {
    const directory = pending.pop();
    const entries = fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(file);
      else if (predicate(file, entry.name)) files.push(file);
    }
  }
  return files.sort();
}

function codexRolloutFiles(runRoot) {
  const homeRoots = [
    path.join(runRoot, ".codex-home"),
    path.join(runRoot, "artifacts/.codex-home"),
    path.join(runRoot, "artifacts/codex-home"),
    path.join(runRoot, "raw_session"),
  ];
  return homeRoots
    .flatMap((root) => findFiles(root, (_file, name) => /^rollout-.*\.jsonl$/.test(name)))
    .filter((file, index, files) => files.findIndex((candidate) => path.basename(candidate) === path.basename(file)) === index);
}

function rolloutMessageText(item) {
  return (item?.content ?? [])
    .map((block) => typeof block?.text === "string" ? block.text : "")
    .join("");
}

function rolloutCommand(item) {
  if (typeof item?.arguments !== "string") return "";
  try {
    const argumentsObject = JSON.parse(item.arguments);
    return typeof argumentsObject?.cmd === "string" ? argumentsObject.cmd : "";
  } catch {
    return "";
  }
}

function rolloutCustomCommands(item) {
  if (item?.type !== "custom_tool_call" || typeof item.input !== "string") return [];
  const commands = [];
  const pattern = /\bcmd\s*:\s*("(?:\\.|[^"\\])*")/g;
  for (const match of item.input.matchAll(pattern)) {
    try {
      commands.push(JSON.parse(match[1]));
    } catch {
      // An unparsable command cannot be matched to the canonical trajectory.
    }
  }
  return commands;
}

// The canonical Codex trajectory omits per-event timestamps, while the local
// rollout stream retains them. Keep readable reasoning and a typed timestamp
// queue so normalized events can recover their actual elapsed times.
function readCodexRolloutTimeline(runRoot, includeCustomTools = false) {
  const rolloutFiles = codexRolloutFiles(runRoot);
  const anchors = [];
  const messages = [];
  const commands = [];
  const patches = [];
  const planUpdates = [];
  const seenReasoning = new Set();
  let visibleAnchor = 0;
  let firstTimestamp = null;

  for (const file of rolloutFiles) {
    const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
    lines.forEach((line, lineIndex) => {
      if (!line) return;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      const timestamp = normalizeTimestamp(event.timestamp);
      if (timestamp && firstTimestamp === null) firstTimestamp = timestamp;
      if (event.type !== "response_item" || !event.payload) return;
      const item = event.payload;
      if (item.type === "reasoning") {
        const identity = item.id ?? `${file}:${lineIndex}`;
        if (!seenReasoning.has(identity)) {
          seenReasoning.add(identity);
          anchors.push({ position: visibleAnchor, timestamp, fields: reasoningFields(item) });
        }
      } else if (item.type === "message" && item.role === "assistant") {
        messages.push({ timestamp, text: rolloutMessageText(item) });
        visibleAnchor += 1;
      } else if (item.type === "function_call") {
        if (item.name === "update_plan") {
          planUpdates.push({ timestamp });
        } else if (item.name === "exec_command") {
          const command = rolloutCommand(item);
          (command.includes("apply_patch") ? patches : commands).push({ timestamp, command });
          visibleAnchor += 1;
        } else {
          commands.push({ timestamp, command: rolloutCommand(item) });
          visibleAnchor += 1;
        }
      } else if (includeCustomTools && item.type === "custom_tool_call") {
        const customCommands = rolloutCustomCommands(item);
        if (/\btools\.apply_patch\s*\(/.test(item.input ?? "")) {
          patches.push({ timestamp, command: item.input, remaining: 1 });
          visibleAnchor += 1;
        } else if (customCommands.length) {
          for (const command of customCommands) {
            commands.push({ timestamp, command });
            visibleAnchor += 1;
          }
        } else if (/\bexec_command\b/.test(item.input ?? "")) {
          commands.push({ timestamp, command: "" });
          visibleAnchor += 1;
        } else if (/\bupdate_plan\b/.test(item.input ?? "")) {
          planUpdates.push({ timestamp });
        }
      }
    });
  }

  return { firstTimestamp, anchors, messages, commands, patches, planUpdates };
}

function normalizeClaudeEvents(events, runRoot) {
  const normalized = [];
  const toolItems = new Map();
  const firstTimestamp = events.map(eventTimestamp).find((time) => time !== null) ?? 0;
  let lastTimestamp = firstTimestamp;

  const add = (event) => {
    const sourceTimestamp = eventTimestamp(event.source);
    if (sourceTimestamp !== null) lastTimestamp = sourceTimestamp;
    const timestamp = sourceTimestamp ?? lastTimestamp;
    const item = {
      id: `event-${normalized.length + 1}`,
      sequence: normalized.length + 1,
      kind: event.kind,
      timestamp: event.source?.timestamp ?? null,
      elapsedSec: Math.max(0, Number(((timestamp - firstTimestamp) / 1000).toFixed(3))),
    };
    for (const [key, value] of Object.entries(event)) {
      if (key !== "source" && value !== undefined) item[key] = value;
    }
    normalized.push(item);
    return item;
  };

  for (const event of events) {
    if (event.type === "tool_progress") continue;

    if (event.type === "system") {
      if (event.subtype === "init") {
        add({
          kind: "lifecycle",
          source: event,
          label: "Session start",
          details: {
            cwd: "/workspace/task",
            model: event.model,
            tools: event.tools ?? [],
          },
        });
      }
      continue;
    }

    if (event.type === "assistant") {
      for (const block of event.message?.content ?? []) {
        if (block.type === "tool_use") {
          const item = add({
            kind: "tool",
            source: event,
            toolUseId: block.id,
            name: block.name,
            input: safeInput(block.input, runRoot),
            omitResult: Object.values(block.input ?? {}).some((value) => typeof value === "string" && /(?:^|\/)artifacts\/model\.patch\b/.test(value)),
          });
          toolItems.set(block.id, item);
        } else if (block.type === "thinking") {
          const fields = reasoningFields(block);
          // Claude-compatible exports may contain empty thinking markers around
          // real blocks. They carry neither plaintext nor encrypted content and
          // should not become misleading "unavailable" cards in the viewer.
          if (fields.reasoningStatus === "unavailable") continue;
          add({
            kind: "thinking",
            source: event,
            label: "Reasoning block",
            ...fields,
          });
        } else if (block.type === "text") {
          const text = fullText(block.text, runRoot);
          add({
            kind: "assistant",
            source: event,
            text: text.text,
            truncated: text.truncated,
          });
        }
      }
      continue;
    }

    if (event.type === "user") {
      const blocks = event.message?.content ?? [];
      let attached = false;
      for (const block of blocks) {
        if (block.type !== "tool_result") continue;
        const item = toolItems.get(block.tool_use_id);
        if (!item) continue;
        const rawResult = resultContent(block.content);
        const result = item.omitResult || /^diff --git /m.test(rawResult)
          ? { text: "[agent patch content omitted from the published trace]", truncated: false }
          : fullText(rawResult, runRoot);
        item.result = {
          isError: Boolean(block.is_error),
          text: result.text,
          truncated: result.truncated,
        };
        attached = true;
      }
      if (!attached && typeof event.tool_use_result === "string") {
        const item = [...toolItems.values()].at(-1);
        if (item) {
          const result = item.omitResult || /^diff --git /m.test(event.tool_use_result)
            ? { text: "[agent patch content omitted from the published trace]", truncated: false }
            : fullText(event.tool_use_result, runRoot);
          item.result = { isError: false, text: result.text, truncated: result.truncated };
          attached = true;
        }
      }
      if (!attached && blocks.length) {
        const text = fullText(resultContent(blocks), runRoot);
        add({ kind: "message", source: event, text: text.text, truncated: text.truncated });
      }
      continue;
    }

    if (event.type === "result") {
      const text = fullText(event.result, runRoot);
      add({
        kind: "final",
        source: event,
        text: text.text,
        truncated: text.truncated,
        stopReason: event.stop_reason ?? null,
      });
    }
  }

  return normalized.map((event) => {
    const output = { ...event };
    delete output.omitResult;
    return output;
  });
}

function readKimiTimeline(runRoot) {
  const thinking = [];
  const assistantTexts = [];
  const toolCalls = [];
  const toolResults = [];
  const wireFiles = findFiles(path.join(runRoot, "raw_session"), (_file, name) => name === "wire.jsonl");
  const wireTimes = [];

  for (const file of wireFiles) {
    const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
    lines.forEach((line, lineIndex) => {
      if (!line) return;
      let wrapper;
      try {
        wrapper = JSON.parse(line);
      } catch {
        return;
      }
      const event = wrapper?.event ?? wrapper;
      if (!event || typeof event !== "object") return;
      const timestamp = normalizeTimestamp(wrapper.time ?? event.timestamp);
      const sourceOrder = Number.isFinite(Number(lineIndex)) ? lineIndex : 0;
      if (timestamp) wireTimes.push(timestamp);
      if (event.type === "content.part") {
        const part = event.part ?? {};
        if (part.type === "text" && typeof part.text === "string" && part.text) {
          assistantTexts.push({ text: part.text, timestamp, sourceOrder });
        }
      } else if (event.type === "tool.call") {
        toolCalls.push({
          id: event.toolCallId ?? event.id ?? null,
          name: event.name ?? "Tool",
          timestamp,
          sourceOrder,
        });
      } else if (event.type === "tool.result") {
        toolResults.push({
          id: event.toolCallId ?? event.id ?? null,
          timestamp,
          sourceOrder,
        });
      }
    });
  }

  const thinkingPath = path.join(runRoot, "thinking.jsonl");
  if (fs.existsSync(thinkingPath)) {
    const lines = fs.readFileSync(thinkingPath, "utf8").split(/\r?\n/);
    lines.forEach((line, lineIndex) => {
      if (!line) return;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        return;
      }
      if (typeof record.thinking !== "string" || !record.thinking) return;
      thinking.push({
        timestamp: normalizeTimestamp(record.time),
        sourceOrder: numericOrNull(record.source_event_index) ?? lineIndex,
        fields: reasoningFields({ text: record.thinking }),
      });
    });
  }

  const firstTimestamp = wireTimes.sort()[0] ?? thinking.find((record) => record.timestamp)?.timestamp ?? null;
  return { firstTimestamp, thinking, assistantTexts, toolCalls, toolResults };
}

function normalizeKimiEvents(events, runRoot, timeline = {}) {
  const normalized = [];
  const toolItems = new Map();
  let activeTool = null;
  const assistantContentIndexes = events
    .map((event, index) => event?.role === "assistant" && event.content ? index : -1)
    .filter((index) => index >= 0);
  const lastAssistantContent = assistantContentIndexes.at(-1);

  const assistantRecords = (timeline.assistantTexts ?? []).map((record) => ({ ...record, used: false }));
  const toolCallRecords = (timeline.toolCalls ?? []).map((record) => ({ ...record, used: false }));
  const toolResultRecords = (timeline.toolResults ?? []).map((record) => ({ ...record, used: false }));
  const firstTime = eventTimestamp({ timestamp: timeline.firstTimestamp });
  let fallbackOrder = 100000;

  const add = (event, timing = {}) => {
    const item = {
      id: `event-${normalized.length + 1}`,
      sequence: normalized.length + 1,
      kind: event.kind,
      timestamp: normalizeTimestamp(timing.timestamp),
      elapsedSec: firstTime !== null && eventTimestamp({ timestamp: timing.timestamp }) !== null
        ? Math.max(0, Number(((eventTimestamp({ timestamp: timing.timestamp }) - firstTime) / 1000).toFixed(3)))
        : null,
      __sourceOrder: timing.sourceOrder ?? fallbackOrder++,
    };
    for (const [key, value] of Object.entries(event)) {
      if (key !== "kind" && value !== undefined) item[key] = value;
    }
    normalized.push(item);
    return item;
  };

  const consume = (records, matcher) => {
    const index = records.findIndex((record) => !record.used && matcher(record));
    if (index < 0) return null;
    records[index].used = true;
    return records[index];
  };

  add({
    kind: "lifecycle",
    label: "Session start",
    details: { cwd: "/workspace/task", model: "Kimi-K3", tools: ["Read", "Bash", "Edit"] },
  }, { timestamp: timeline.firstTimestamp, sourceOrder: -1 });

  const parseArguments = (value) => {
    if (typeof value !== "string" || !value) return {};
    try {
      return JSON.parse(value);
    } catch {
      return { arguments: value };
    }
  };

  events.forEach((event, eventIndex) => {
    if (!event || typeof event !== "object") return;
    if (event.role === "assistant") {
      activeTool = null;
      if (event.content) {
        const output = fullText(event.content, runRoot);
        const record = consume(assistantRecords, (candidate) => candidate.text === event.content)
          ?? consume(assistantRecords, () => true);
        add({
          kind: eventIndex === lastAssistantContent ? "final" : "assistant",
          text: output.text,
          truncated: output.truncated,
        }, record ?? {});
      }
      for (const call of event.tool_calls ?? []) {
        const functionCall = call.function ?? {};
        const input = parseArguments(functionCall.arguments);
        const record = consume(toolCallRecords, (candidate) => candidate.id === call.id)
          ?? consume(toolCallRecords, (candidate) => candidate.name === functionCall.name)
          ?? consume(toolCallRecords, () => true);
        const item = add({
          kind: "tool",
          toolUseId: call.id ?? null,
          name: functionCall.name ?? "Tool",
          input: safeInput(input, runRoot),
          omitResult: Object.values(input).some((value) => typeof value === "string" && /(?:^|\/)model\.patch\b/.test(value)),
        }, record ?? {});
        toolItems.set(call.id, item);
        activeTool = item;
      }
      return;
    }

    if (event.role === "tool") {
      const item = toolItems.get(event.tool_call_id) ?? activeTool;
      if (!item) {
        const output = fullText(event.content, runRoot);
        add({ kind: "message", label: "Tool result", text: output.text, truncated: output.truncated });
        return;
      }
      const rawResult = resultContent(event.content);
      const resultRecord = consume(toolResultRecords, (candidate) => candidate.id === event.tool_call_id)
        ?? consume(toolResultRecords, () => true);
      const output = item.omitResult || /^diff --git /m.test(rawResult)
        ? { text: "[agent patch content omitted from the published trace]", truncated: false }
        : fullText(rawResult, runRoot);
      item.result = {
        isError: false,
        text: output.text,
        truncated: output.truncated,
        ...(resultRecord?.timestamp ? { timestamp: resultRecord.timestamp } : {}),
      };
      activeTool = item;
      return;
    }

    if (event.type === "text") {
      const output = fullText(event.text, runRoot);
      if (activeTool && !activeTool.result) {
        activeTool.result = { isError: false, text: output.text, truncated: output.truncated };
      } else if (activeTool && activeTool.result) {
        activeTool.result.text += `\n${output.text}`;
      } else if (output.text) {
        const record = consume(assistantRecords, (candidate) => candidate.text === event.text)
          ?? consume(assistantRecords, () => true);
        add({ kind: "message", label: "Tool output", text: output.text, truncated: output.truncated }, record ?? {});
      }
    }
  });

  for (const record of timeline.thinking ?? []) {
    add({ kind: "thinking", label: "Reasoning block", ...record.fields }, record);
  }

  const kindPriority = { lifecycle: 0, thinking: 1, assistant: 2, tool: 3, message: 4, final: 5 };
  normalized.sort((left, right) => left.__sourceOrder - right.__sourceOrder
    || (kindPriority[left.kind] ?? 9) - (kindPriority[right.kind] ?? 9)
    || left.sequence - right.sequence);
  return normalized.map((event, index) => {
    const output = { ...event };
    delete output.omitResult;
    delete output.__sourceOrder;
    output.id = `event-${index + 1}`;
    output.sequence = index + 1;
    return output;
  });
}

function shellCommandBody(command) {
  const value = String(command ?? "").trim();
  const match = value.match(/^\/usr\/bin\/bash -lc\s+([\s\S]+)$/);
  if (!match) return value;
  const body = match[1].trim();
  if (body.startsWith('"')) {
    try {
      return JSON.parse(body);
    } catch {
      return body;
    }
  }
  if (body.startsWith("'") && body.endsWith("'")) return body.slice(1, -1).replaceAll("'\\''", "'");
  return body;
}

function commandFingerprint(command) {
  return shellCommandBody(command)
    .replace(/^cd \/workspace\/task(?:_\d+)? && /, "")
    .replace(/\s+/g, " ")
    .trim();
}

function commandsEquivalent(left, right) {
  const leftFingerprint = commandFingerprint(left);
  const rightFingerprint = commandFingerprint(right);
  return Boolean(leftFingerprint && rightFingerprint)
    && (leftFingerprint === rightFingerprint
      || leftFingerprint.includes(rightFingerprint)
      || rightFingerprint.includes(leftFingerprint));
}

function normalizeCodexEvents(events, runRoot, model, timeline = {}) {
  const completed = events.filter((event) => event.type === "item.completed");
  const lastAgentMessage = completed.findLastIndex((event) => event.item?.type === "agent_message");
  const normalized = [];
  const reasoningAnchors = timeline.injectedReasoning ?? timeline.anchors ?? [];
  const sourceReasoning = timeline.anchors ?? [];
  const messageRecords = (timeline.messages ?? []).map((record) => ({ ...record, used: false }));
  const commandRecords = (timeline.commands ?? []).map((record) => ({ ...record, used: false }));
  const patchRecords = (timeline.patches ?? []).map((record) => ({ ...record, used: false }));
  const firstTimestamp = timeline.firstTimestamp ?? null;
  const firstTime = eventTimestamp({ timestamp: firstTimestamp });
  let reasoningIndex = 0;
  let sourceReasoningIndex = 0;
  let visibleAnchor = 0;

  const timingFields = (timestamp) => {
    const normalizedTimestamp = normalizeTimestamp(timestamp);
    const time = eventTimestamp({ timestamp: normalizedTimestamp });
    return {
      timestamp: normalizedTimestamp,
      elapsedSec: firstTime !== null && time !== null
        ? Math.max(0, Number(((time - firstTime) / 1000).toFixed(3)))
        : null,
    };
  };

  const add = (kind, fields = {}, timestamp = null) => {
    normalized.push({
      id: `event-${normalized.length + 1}`,
      sequence: normalized.length + 1,
      kind,
      ...timingFields(timestamp),
      ...fields,
    });
  };

  const consume = (records, matcher, fallback = true) => {
    let index = records.findIndex((record) => !record.used && matcher(record));
    if (index < 0 && fallback) index = records.findIndex((record) => !record.used);
    if (index < 0) return null;
    records[index].used = true;
    return records[index];
  };

  const consumePatch = (paths) => {
    let record = patchRecords.find((candidate) => candidate.remaining > 0 && paths.some((file) => candidate.command.includes(file)));
    if (!record) record = patchRecords.find((candidate) => candidate.remaining > 0);
    if (!record) return null;
    record.remaining -= 1;
    return record;
  };

  const flushReasoning = () => {
    while (reasoningIndex < reasoningAnchors.length && reasoningAnchors[reasoningIndex].position <= visibleAnchor) {
      const reasoning = reasoningAnchors[reasoningIndex];
      add("thinking", { label: "Reasoning block", ...reasoning.fields }, reasoning.timestamp);
      reasoningIndex += 1;
    }
  };

  const addAnchored = (kind, fields = {}, timestamp = null) => {
    flushReasoning();
    add(kind, fields, timestamp);
    visibleAnchor += 1;
  };

  add("lifecycle", {
    label: "Session start",
    details: { cwd: "/workspace/task", model, tools: ["Shell", "File edit"] },
  }, firstTimestamp);

  completed.forEach((event, completedIndex) => {
    const item = event.item ?? {};
    flushReasoning();
    if (item.type === "agent_message") {
      const output = fullText(item.text, runRoot);
      const record = consume(messageRecords, (candidate) => candidate.text === item.text);
      addAnchored(completedIndex === lastAgentMessage ? "final" : "assistant", {
        text: output.text,
        truncated: output.truncated,
      }, record?.timestamp ?? null);
      return;
    }

    if (item.type === "reasoning") {
      const record = sourceReasoning[sourceReasoningIndex++] ?? null;
      add("thinking", { label: "Reasoning block", ...reasoningFields(item) }, record?.timestamp ?? null);
      return;
    }

    if (item.type === "command_execution") {
      const record = consume(commandRecords, (candidate) => commandsEquivalent(candidate.command, item.command));
      const omitResult = /(?:^|\/)artifacts\/model\.patch\b/.test(item.command ?? "");
      const rawResult = String(item.aggregated_output ?? "");
      const result = omitResult || /^diff --git /m.test(rawResult)
        ? { text: "[agent patch content omitted from the published trace]", truncated: false }
        : fullText(rawResult, runRoot);
      addAnchored("tool", {
        toolUseId: item.id ?? null,
        name: "Shell",
        input: { command: fullText(item.command, runRoot).text },
        result: {
          isError: item.status === "failed" || (typeof item.exit_code === "number" && item.exit_code !== 0),
          text: result.text,
          truncated: result.truncated,
        },
      }, record?.timestamp ?? null);
      return;
    }

    if (item.type === "file_change") {
      const paths = (item.changes ?? []).map((change) => change.path).filter(Boolean);
      const record = consumePatch(paths);
      addAnchored("tool", {
        toolUseId: item.id ?? null,
        name: "File edit",
        input: {
          paths: (item.changes ?? []).map((change) => sanitizeText(change.path, runRoot)).join(", "),
        },
        result: { isError: item.status === "failed", text: item.status ?? "completed", truncated: false },
      }, record?.timestamp ?? null);
      return;
    }

    if (item.type === "todo_list") {
      const text = (item.items ?? []).map((todo) => `${todo.completed ? "[x]" : "[ ]"} ${todo.text}`).join("\n");
      const output = fullText(text, runRoot);
      const record = (timeline.planUpdates ?? []).at(-1);
      addAnchored("message", { label: "Plan update", text: output.text, truncated: output.truncated }, record?.timestamp ?? null);
      return;
    }

    if (item.type === "error") {
      const output = fullText(item.message, runRoot);
      add("message", { label: "Runtime notice", text: output.text, truncated: output.truncated });
    }
  });

  flushReasoning();
  while (reasoningIndex < reasoningAnchors.length) {
    const reasoning = reasoningAnchors[reasoningIndex];
    add("thinking", { label: "Reasoning block", ...reasoning.fields }, reasoning.timestamp);
    reasoningIndex += 1;
  }

  return normalized;
}

function parseEvaluation(verifierLog, trial, runRoot) {
  const summaryLine = verifierLog.split(/\r?\n/).find((line) => line.startsWith("SCI_BENCH_EVAL_SUMMARY="));
  let summary = null;
  try {
    summary = summaryLine ? JSON.parse(summaryLine.slice("SCI_BENCH_EVAL_SUMMARY=".length)) : null;
  } catch {
    summary = null;
  }

  const metric = (value) => value ? {
    name: value.name ?? null,
    kind: value.kind ?? null,
    collected: value.collected ?? null,
    passed: value.passed ?? null,
    failed: value.failed ?? null,
    skipped: value.skipped ?? null,
    allPassed: value.all_passed ?? null,
    returnCode: value.return_code ?? null,
  } : null;

  const publicMetric = metric(summary?.public);
  const privateMetric = metric(summary?.private);
  const compactLog = verifierLog
    .split(/\r?\n/)
    .filter((line) => line.startsWith("[science-bench]"))
    .join("\n");

  return {
    public: publicMetric,
    private: privateMetric,
    reward: summary?.reward ?? (trial.verifier?.return_code === 0 ? 1 : 0),
    scoreMode: summary?.score_mode ?? "private_only",
    verifierReturnCode: trial.verifier?.return_code ?? null,
    logSummary: compactLog,
    verifierLog: sanitizeText(verifierLog, runRoot),
  };
}

function eventCounts(events) {
  return events.reduce((counts, event) => {
    counts[event.kind] = (counts[event.kind] ?? 0) + 1;
    return counts;
  }, {});
}

function ensureGptWslRunsRoot() {
  if (gptWslRunsRoot) {
    if (!fs.existsSync(gptWslRunsRoot)) throw new Error(`GPT_WSL_RUNS_ROOT does not exist: ${gptWslRunsRoot}`);
    return gptWslRunsRoot;
  }
  if (!fs.existsSync(gptWslArchive)) {
    throw new Error(`GPT WSL source is unavailable. Set GPT_WSL_RUNS_ROOT to an extracted archive or GPT_WSL_ARCHIVE to the tarball (missing ${gptWslArchive}).`);
  }
  if (!gptExtractedRunsRoot) {
    gptExtractedRunsRoot = mkdtempSync(path.join(tmpdir(), "swe-science-gpt-"));
    execFileSync("tar", ["-xzf", gptWslArchive, "-C", gptExtractedRunsRoot], { stdio: "inherit" });
  }
  return gptExtractedRunsRoot;
}

function locateGptRun(entry) {
  const root = entry.source === "mac-primary"
    ? gptMacPrimaryRoot
    : entry.source === "mac-platform-amd64"
      ? gptMacPlatformRoot
      : ensureGptWslRunsRoot();
  const taskRoot = path.join(root, entry.source === "wsl-archive" ? `task_${entry.sourceTaskDir}` : "runs", ...(entry.source === "wsl-archive" ? [] : [`task_${entry.sourceTaskDir}`]));
  const expected = entry.runName ? path.join(taskRoot, entry.runName) : null;
  if (expected && fs.existsSync(expected)) return expected;
  if (!fs.existsSync(taskRoot)) throw new Error(`Missing GPT task directory: ${taskRoot}`);
  const candidates = fs.readdirSync(taskRoot)
    .filter((name) => fs.existsSync(path.join(taskRoot, name, "trial.json")))
    .filter((name) => !name.includes("without_auxiliary"));
  if (candidates.length === 1) return path.join(taskRoot, candidates[0]);
  const rerun = candidates.find((name) => name.includes("rerun"));
  if (rerun) return path.join(taskRoot, rerun);
  throw new Error(`Missing or ambiguous GPT run ${entry.runName} in ${taskRoot}`);
}

const baseExperiments = [
  {
    id: "claude-opus-5-max",
    label: "Claude Opus 5 Max",
    model: "Claude Opus 5",
    harness: "Claude Code",
    parser: "claude",
    outputDir: "claude-opus-5-max",
    auditFile: path.join(reportsRoot, "ucloud-opus-max-002-120-audit/selected_runs.json"),
    tokenUsageFile: tokenUsageFiles.opus,
  },
  {
    id: "gpt-5-6-sol-max",
    label: "GPT-5.6-sol Max",
    model: "GPT-5.6-sol",
    harness: "Codex",
    parser: "codex",
    outputDir: "gpt-5-6-sol-max",
    resultsRoot: localResultRoots.gpt,
  },
  {
    id: "gpt-6-astra-max",
    label: "GPT-6 Astra Max",
    model: "GPT-6 Astra",
    harness: "Codex",
    parser: "codex",
    customToolTimeline: true,
    outputDir: "gpt-6-astra-max",
    auditFile: path.join(reportsRoot, "gpt-6-astra-official-max-withaux-002-120-audit/selected_runs_and_token_usage.json"),
    tokenUsageFile: path.join(reportsRoot, "gpt-6-astra-official-max-withaux-002-120-audit/selected_runs_and_token_usage.json"),
  },
  {
    id: "deepseek-v4-pro-max",
    label: "DeepSeek-V4-Pro Max",
    model: "DeepSeek-V4-Pro",
    harness: "Claude Code",
    parser: "claude",
    outputDir: "deepseek-v4-pro-max",
    resultsRoot: localResultRoots.deepseek,
  },
  {
    id: "kimi-k3-max",
    label: "Kimi-K3 Max",
    model: "Kimi-K3",
    harness: "Kimi Code",
    parser: "kimi",
    outputDir: "kimi-k3-max",
    resultsRoot: localResultRoots.kimi,
  },
  {
    id: "glm-5-2-max",
    label: "GLM-5.2 Max",
    model: "GLM-5.2",
    harness: "Codex",
    parser: "codex",
    outputDir: "glm-5-2-max",
    auditFile: path.join(reportsRoot, "glm-5.2-max-with_auxiliary-002-120-audit/selected_runs_and_evidence.json"),
    tokenUsageFile: tokenUsageFiles.glm,
  },
  {
    id: "qwen3-8-27b-xhigh",
    label: "Qwen3.8-27B xhigh",
    model: "Qwen3.8-27B",
    harness: "Claude Code",
    parser: "claude",
    outputDir: "qwen3-8-27b-xhigh",
    auditFile: path.join(reportsRoot, "qwen3.8-27b-responses-withaux-002-120-audit/selected_runs_and_token_usage.json"),
  },
];

// GPT-5.6-sol xhigh runs remain available as an explicit opt-in input for a
// later release, but are excluded from the default publication tree.
const optionalExperiments = [
  {
    id: "gpt-5-6-sol-xhigh",
    label: "GPT-5.6-sol xhigh",
    model: "GPT-5.6-sol",
    harness: "Codex",
    parser: "codex",
    outputDir: "gpt-5-6-sol-xhigh",
    selectionFile: gptSelectionFile,
  },
];
const publishGptXhigh = process.env.PUBLISH_GPT_XHIGH === "1";
const experiments = publishGptXhigh ? [...baseExperiments, ...optionalExperiments] : baseExperiments;

function selectedRunMap(experiment) {
  if (experiment.selectionFile) {
    const selection = readJson(experiment.selectionFile);
    if (Array.isArray(selection.entries)) {
      if (selection.entries.length !== 119) throw new Error(`Expected 119 GPT run selections in ${experiment.selectionFile}`);
      return new Map(selection.entries.map((entry) => [entry.legacyTaskId, entry]));
    }
    const macPrimary = new Set(selection.macPrimaryTaskIds ?? []);
    const macPlatform = new Set(selection.macPlatformTaskIds ?? []);
    const entries = [];
    for (let legacy = 2; legacy <= 120; legacy += 1) {
      const legacyTaskId = String(legacy).padStart(3, "0");
      const source = macPrimary.has(legacyTaskId) ? "mac-primary" : macPlatform.has(legacyTaskId) ? "mac-platform-amd64" : "wsl-archive";
      const sourceTaskDir = selection.wslTaskDirOverrides?.[legacyTaskId] ?? legacyTaskId;
      let runName = null;
      if (source === "mac-primary") runName = `codex-gpt-5.6-sol-${legacyTaskId}-xhigh-1`;
      if (source === "mac-platform-amd64") runName = selection.macPlatformRunOverrides?.[legacyTaskId]
        ?? `gpt-5.6-sol-xhigh-with_auxiliary-${legacyTaskId}-withaux-gpt-5.6-sol-xhigh-fair-20260801T0815Z`;
      if (source === "wsl-archive") runName = selection.wslRunOverrides?.[legacyTaskId] ?? null;
      entries.push({ publishedTaskId: legacyTaskId === "120" ? "001" : legacyTaskId, legacyTaskId, source, sourceTaskDir, runName });
    }
    return new Map(entries.map((entry) => [entry.legacyTaskId, entry]));
  }
  if (experiment.resultsRoot) {
    if (!fs.existsSync(experiment.resultsRoot)) throw new Error(`Missing ${experiment.id} results directory: ${experiment.resultsRoot}`);
    const directories = fs.readdirSync(experiment.resultsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^task_\d{3}$/.test(entry.name))
      .map((entry) => entry.name);
    if (directories.length !== 120) throw new Error(`Expected 120 ${experiment.id} task directories in ${experiment.resultsRoot}`);
    const selected = new Map();
    for (const directory of directories) {
      const taskId = directory.replace(/^task_/, "");
      const result = readJson(path.join(experiment.resultsRoot, directory, "result.json"));
      const currentScope = String(result.current_release_scope_001_119);
      const historicalScope = String(result.historical_eval_scope_002_120);
      if (taskId === "001" && (currentScope !== "true" || historicalScope !== "false")) {
        throw new Error(`${experiment.id} task_001 does not have current-release-only scope`);
      }
      if (taskId === "120" && (currentScope !== "false" || historicalScope !== "true")) {
        throw new Error(`${experiment.id} task_120 does not have historical-only scope`);
      }
      if (Number(taskId) >= 2 && Number(taskId) <= 119 && (currentScope !== "true" || historicalScope !== "true")) {
        throw new Error(`${experiment.id} task_${taskId} is not shared by both evaluation scopes`);
      }
      if (taskId !== "001") selected.set(taskId, path.join(experiment.resultsRoot, directory));
    }
    if (selected.size !== 119 || selected.has("001") || !selected.has("120")) {
      throw new Error(`${experiment.id} results do not contain exactly the historical 002-120 scope`);
    }
    return selected;
  }
  if (!experiment.auditFile) return null;
  const selected = readJson(experiment.auditFile);
  const entries = Array.isArray(selected) ? selected : selected.tasks;
  if (!Array.isArray(entries) || entries.length !== 119) throw new Error(`Expected 119 selected runs in ${experiment.auditFile}`);
  return new Map(entries.map((entry) => {
    const runPath = entry.trial_root ?? entry.run_path ?? entry.run_dir;
    const taskId = entry.task_id ?? entry.task;
    if (!runPath) throw new Error(`Selected run has no path for task ${taskId}`);
    return [String(taskId).replace(/^task_/, ""), path.isAbsolute(runPath) ? runPath : path.join(benchmarkRoot, runPath)];
  }));
}

function locateSelectedRun(experiment, legacyTaskId, runMap) {
  const selected = experiment.locateRun ? null : runMap.get(legacyTaskId);
  const runRoot = experiment.locateRun
    ? experiment.locateRun(legacyTaskId)
    : experiment.selectionFile
      ? locateGptRun(selected)
      : selected;
  if (!runRoot || !fs.existsSync(runRoot)) throw new Error(`Missing selected ${experiment.id} run for task ${legacyTaskId}`);
  return runRoot;
}

function buildTask(experiment, legacyTaskId, runMap, tokenUsageMap) {
  const runRoot = locateSelectedRun(experiment, legacyTaskId, runMap);
  const trial = readJson(runArtifact(runRoot, "trial.json"));
  const trajectory = readJson(runArtifact(runRoot, "trajectory.json"));
  const verifierLog = fs.readFileSync(runArtifact(runRoot, "verifier.log"), "utf8");
  const publishedTaskId = legacyTaskId === "120" ? "001" : legacyTaskId;
  const publishedTask = taskById.get(publishedTaskId);
  if (!publishedTask) throw new Error(`Missing published task ${publishedTaskId} in data/tasks.csv`);
  const trajectoryHasReasoning = trajectory.events?.some((event) => event?.item?.type === "reasoning");
  const codexTimeline = experiment.parser === "codex" ? readCodexRolloutTimeline(runRoot, experiment.customToolTimeline) : null;
  const kimiTimeline = experiment.parser === "kimi" ? readKimiTimeline(runRoot) : null;
  const events = experiment.parser === "codex"
    ? normalizeCodexEvents(trajectory.events ?? [], runRoot, experiment.model, {
      ...(codexTimeline ?? {}),
      injectedReasoning: trajectoryHasReasoning ? [] : (codexTimeline?.anchors ?? []),
    })
    : experiment.parser === "kimi"
      ? normalizeKimiEvents(trajectory.events ?? [], runRoot, kimiTimeline ?? {})
    : normalizeClaudeEvents(trajectory.events ?? [], runRoot);
  const directUsage = trial.agent_run?.usage ?? {};
  const trajectoryUsage = trajectory.events?.findLast((event) => event?.type === "turn.completed" && event.usage)?.usage ?? {};
  const tokenUsage = tokenUsageMap?.get(legacyTaskId) ?? null;
  const inputTokens = directUsage.input_tokens ?? trajectoryUsage.input_tokens ?? null;
  const outputTokens = directUsage.output_tokens ?? trajectoryUsage.output_tokens ?? null;
  const usage = {
    input_tokens: tokenUsage?.input_tokens ?? inputTokens,
    output_tokens: tokenUsage?.output_tokens ?? outputTokens,
    total_tokens: tokenUsage?.total_tokens ?? directUsage.total_tokens ?? trajectoryUsage.total_tokens ?? (inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null),
    cache_read_tokens: tokenUsage?.cache_read_tokens ?? directUsage.cache_read_tokens ?? trajectoryUsage.cache_read_tokens ?? trajectoryUsage.cached_input_tokens ?? null,
    cache_creation_tokens: tokenUsage?.cache_creation_tokens ?? directUsage.cache_creation_tokens ?? trajectoryUsage.cache_creation_tokens ?? null,
    call_count: tokenUsage?.call_count ?? directUsage.call_count ?? trajectoryUsage.call_count ?? null,
    cost_usd: tokenUsage?.cost_usd ?? directUsage.cost_usd ?? trajectoryUsage.cost_usd ?? null,
    reasoning_output_tokens: directUsage.reasoning_output_tokens ?? trajectoryUsage.reasoning_output_tokens ?? null,
  };
  const timings = trial.timings ?? {};
  const counts = eventCounts(events);
  const evaluation = parseEvaluation(verifierLog, trial, runRoot);

  return {
    version: 1,
    task: {
      publishedTaskId,
      title: publishedTask.title,
      domain: publishedTask.domain || null,
      language: publishedTask.language || null,
      sourceRepository: publishedTask.repository_url || null,
    },
    run: {
      id: `${experiment.id}-${publishedTaskId}`,
      model: trial.agent_run?.model ?? experiment.model,
      harness: experiment.harness,
    },
    summary: {
      status: trial.timings?.workflow?.status ?? null,
      agentReturnCode: trial.agent_run?.return_code ?? null,
      workflowReturnCode: trial.timings?.workflow?.return_code ?? null,
      agentDurationSec: timings.agent?.duration_sec ?? null,
      verifierDurationSec: timings.verifier?.duration_sec ?? null,
      workflowDurationSec: timings.workflow?.duration_sec ?? null,
      startedAt: normalizeTimestamp(timings.workflow?.started_at),
      finishedAt: normalizeTimestamp(timings.workflow?.finished_at),
      rawEventCount: trajectory.event_count ?? trajectory.events?.length ?? 0,
      normalizedEventCount: events.length,
      eventCounts: counts,
      toolCounts: events.filter((event) => event.kind === "tool").reduce((tools, event) => {
        tools[event.name] = (tools[event.name] ?? 0) + 1;
        return tools;
      }, {}),
    },
    usage: {
      inputTokens: usage.input_tokens ?? null,
      outputTokens: usage.output_tokens ?? null,
      totalTokens: usage.total_tokens ?? null,
      cacheReadTokens: usage.cache_read_tokens ?? null,
      cacheCreationTokens: usage.cache_creation_tokens ?? null,
      callCount: usage.call_count ?? null,
      costUsd: usage.cost_usd ?? null,
      reasoningOutputTokens: usage.reasoning_output_tokens ?? null,
    },
    evaluation,
    events,
  };
}

fs.rmSync(obsoleteOutputRoot, { recursive: true, force: true });

const registry = [];
for (const experiment of experiments) {
  const outputRoot = path.join(repoRoot, "public/traces", experiment.outputDir);
  const runMap = selectedRunMap(experiment);
  fs.rmSync(outputRoot, { recursive: true, force: true });
  fs.mkdirSync(outputRoot, { recursive: true });

  const tasks = [];
  const tokenUsageMap = experiment.tokenUsageFile ? readTokenUsage(experiment.tokenUsageFile) : null;
  for (let legacy = 2; legacy <= 120; legacy += 1) {
    const legacyTaskId = String(legacy).padStart(3, "0");
    const task = buildTask(experiment, legacyTaskId, runMap, tokenUsageMap);
    const file = `task-${task.task.publishedTaskId}.json`;
    fs.writeFileSync(path.join(outputRoot, file), `${JSON.stringify(task)}\n`);
    tasks.push({
      ...task.task,
      run: { id: task.run.id, model: task.run.model, harness: task.run.harness },
      summary: task.summary,
      usage: task.usage,
      evaluation: {
        public: task.evaluation.public,
        private: task.evaluation.private,
        reward: task.evaluation.reward,
        scoreMode: task.evaluation.scoreMode,
      },
      file,
    });
  }

  tasks.sort((a, b) => a.publishedTaskId.localeCompare(b.publishedTaskId));
  const index = {
    version: 1,
    generatedAt: tasks.map((task) => task.summary.finishedAt).filter(Boolean).sort().at(-1) ?? null,
    experiment: { id: experiment.id, label: experiment.label, harness: experiment.harness },
    taskCount: tasks.length,
    tasks,
  };
  fs.writeFileSync(path.join(outputRoot, "index.json"), `${JSON.stringify(index)}\n`);
  registry.push({ id: experiment.id, label: experiment.label, harness: experiment.harness, path: experiment.outputDir, taskCount: tasks.length });
  console.log(`Wrote ${tasks.length} ${experiment.label} trace records.`);
}

fs.writeFileSync(path.join(repoRoot, "public/traces/index.json"), `${JSON.stringify({ version: 1, experiments: registry }, null, 2)}\n`);
