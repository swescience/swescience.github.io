import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(new URL("..", import.meta.url).pathname);
const benchmarkRoot = process.env.BENCHMARK_ROOT ?? "/Users/fnlp/workspace/agent/opus-test";
const uniformTracesRoot = process.env.UNIFORM_TRACES_ROOT
  ?? "/Users/fnlp/Downloads/gpt56_sol_kimi_k3_ds_v4_pro_max_uniform_traces_20260901";

const paths = {
  opus: process.env.OPUS_SELECTION_FILE
    ?? path.join(benchmarkRoot, "reports/ucloud-opus-max-002-120-audit/selected_runs.json"),
  astra: process.env.ASTRA_SELECTION_FILE
    ?? path.join(benchmarkRoot, "reports/gpt-6-astra-official-max-withaux-002-120-audit/selected_runs_and_token_usage.json"),
  kimi: process.env.KIMI_RESULTS_ROOT
    ?? path.join(uniformTracesRoot, "kimi-k3-max"),
  deepseek: process.env.DEEPSEEK_RESULTS_ROOT
    ?? path.join(uniformTracesRoot, "deepseek-v4-pro-max"),
  glm: process.env.GLM_SELECTION_FILE
    ?? path.join(benchmarkRoot, "reports/glm-5.2-max-with_auxiliary-002-120-audit/selected_runs_and_evidence.json"),
  qwen: process.env.QWEN_SELECTION_FILE
    ?? path.join(benchmarkRoot, "reports/qwen3.8-27b-responses-withaux-002-120-audit/selected_runs_and_token_usage.json"),
  gpt: process.env.GPT_MAX_RESULTS_FILE
    ?? "/Users/fnlp/Downloads/task_results_gpt56_sol_max_with_aux.csv",
};

function read(file) {
  if (!fs.existsSync(file)) throw new Error(`Missing source file: ${file}`);
  return fs.readFileSync(file, "utf8");
}

function metric(value, passedKey = "passed", totalKey = "collected") {
  if (!value || value[passedKey] === undefined || value[totalKey] === undefined) return null;
  return { passed: Number(value[passedKey]), total: Number(value[totalKey]) };
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
      } else if (character === '"') quoted = false;
      else field += character;
    } else if (character === '"') quoted = true;
    else if (character === ",") {
      row.push(field);
      field = "";
    } else if (character === "\n") {
      row.push(field.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      field = "";
    } else field += character;
  }
  if (field.length || row.length) {
    row.push(field.replace(/\r$/, ""));
    rows.push(row);
  }
  const [headers, ...records] = rows;
  return records.filter((record) => record.some(Boolean)).map((record) => (
    Object.fromEntries(headers.map((header, index) => [header, record[index] ?? ""]))
  ));
}

function parseSelectedRuns(file) {
  const raw = JSON.parse(read(file));
  const entries = Array.isArray(raw) ? raw : raw.tasks;
  if (!Array.isArray(entries) || entries.length !== 119) throw new Error(`Expected 119 selected runs in ${file}`);
  const rows = new Map();
  for (const entry of entries) {
    const taskId = String(entry.task_id ?? entry.task ?? "").replace(/^task_/, "").padStart(3, "0");
    if (!/^\d{3}$/.test(taskId)) throw new Error(`Selected run has invalid task id in ${file}`);
    const publicMetric = metric(entry.public)
      ?? metric(entry, "public_passed_count", "public_collected")
      ?? metric(entry, "public_passed", "public_collected");
    const privateMetric = metric(entry.private)
      ?? metric(entry, "private_passed_count", "private_collected")
      ?? metric(entry, "private_passed", "private_collected");
    if (!publicMetric || !privateMetric) throw new Error(`Selected run has incomplete metrics for task ${taskId} in ${file}`);
    rows.set(taskId, { public: publicMetric, private: privateMetric, reward: Number(entry.reward ?? 0) });
  }
  if (rows.size !== 119) throw new Error(`Selected run file has duplicate task ids: ${file}`);
  return rows;
}

function normalizeTaskId(value) {
  return String(value ?? "").replace(/^task_/, "").padStart(3, "0");
}

function parseLocalResults(root, label) {
  if (!fs.existsSync(root)) throw new Error(`Missing ${label} results directory: ${root}`);
  const taskDirectories = fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^task_\d{3}$/.test(entry.name))
    .map((entry) => entry.name);
  if (taskDirectories.length !== 120) throw new Error(`Expected 120 task directories in ${root}, found ${taskDirectories.length}`);

  const rows = new Map();
  for (const directory of taskDirectories) {
    const taskId = normalizeTaskId(directory);
    const directoryRoot = path.join(root, directory);
    const result = JSON.parse(read(path.join(directoryRoot, "result.json")));
    const reward = JSON.parse(read(path.join(directoryRoot, "reward.json")));
    const currentScope = String(result.current_release_scope_001_119);
    const historicalScope = String(result.historical_eval_scope_002_120);

    // The published release uses historical 002-120 IDs, with legacy 120 as
    // published 001. Reject a directory if its producer labels another scope.
    if (taskId === "001" && (currentScope !== "true" || historicalScope !== "false")) {
      throw new Error(`${label} task_001 does not have current-release-only scope`);
    }
    if (taskId === "120" && (currentScope !== "false" || historicalScope !== "true")) {
      throw new Error(`${label} task_120 does not have historical-only scope`);
    }
    if (Number(taskId) >= 2 && Number(taskId) <= 119 && (currentScope !== "true" || historicalScope !== "true")) {
      throw new Error(`${label} task_${taskId} is not shared by both evaluation scopes`);
    }
    if (taskId === "001") continue;

    const publicMetric = metric(reward.public_summary)
      ?? metric(result, "public_passed_count", "public_collected")
      ?? metric(result, "public_passed", "public_collected");
    const privateMetric = metric(reward.private_summary)
      ?? metric(result, "private_passed_count", "private_collected")
      ?? metric(result, "private_passed", "private_collected");
    if (!publicMetric || !privateMetric) throw new Error(`${label} task_${taskId} has incomplete verifier metrics`);
    const rewardValue = Number(reward.reward);
    if (!Number.isFinite(rewardValue)) throw new Error(`${label} task_${taskId} has no numeric reward.json reward`);
    rows.set(taskId, { public: publicMetric, private: privateMetric, reward: rewardValue });
  }

  if (rows.size !== 119 || !rows.has("120") || rows.has("001")) {
    throw new Error(`${label} results do not contain exactly the historical 002-120 scope`);
  }
  return rows;
}

function parseGptMaxRows(file, referenceRows) {
  const records = parseCsv(read(file));
  const rows = new Map();
  for (const record of records) {
    if (record.task === "macro_average") continue;
    const taskId = normalizeTaskId(record.task);
    if (!/^\d{3}$/.test(taskId) || Number(taskId) < 2 || Number(taskId) > 120) {
      throw new Error(`GPT Max CSV has invalid task id: ${record.task}`);
    }
    if (rows.has(taskId)) throw new Error(`GPT Max CSV has duplicate task ${taskId}`);
    const reference = referenceRows.get(taskId);
    if (!reference) throw new Error(`GPT Max CSV task ${taskId} has no canonical test totals`);
    const publicRatio = Number(record.with_aux_public);
    const privateRatio = Number(record.with_aux_private);
    const reward = Number(record.with_aux_pass_at_1);
    if (![publicRatio, privateRatio, reward].every(Number.isFinite)
      || publicRatio < 0 || publicRatio > 1 || privateRatio < 0 || privateRatio > 1
      || ![0, 1].includes(reward)) {
      throw new Error(`GPT Max CSV task ${taskId} has invalid metrics`);
    }
    const publicPassed = publicRatio * reference.public.total;
    const privatePassed = privateRatio * reference.private.total;
    if (Math.abs(publicPassed - Math.round(publicPassed)) > 1e-8
      || Math.abs(privatePassed - Math.round(privatePassed)) > 1e-8) {
      throw new Error(`GPT Max CSV task ${taskId} is incompatible with canonical test totals`);
    }
    if (reward !== Number(Math.round(privatePassed) === reference.private.total)) {
      throw new Error(`GPT Max CSV task ${taskId} Pass@1 disagrees with its private-test ratio`);
    }
    rows.set(taskId, {
      public: { passed: Math.round(publicPassed), total: reference.public.total },
      private: { passed: Math.round(privatePassed), total: reference.private.total },
      reward,
    });
  }
  if (rows.size !== 119 || !rows.has("002") || !rows.has("120")) {
    throw new Error(`Expected GPT Max CSV to contain exactly tasks 002-120, found ${rows.size}`);
  }
  return rows;
}

const benchmark = JSON.parse(read(path.join(repoRoot, "data/benchmark.json")));
const nex = benchmark.models.find((model) => model.id === "nex");
if (!nex) throw new Error("Nex N2 reference model is missing from benchmark.json");
const targetIds = benchmark.models.filter((model) => model.scores.overall > nex.scores.overall).map((model) => model.id);
const includedIds = ["opus", "deepseek-pro", "gpt", "gpt-6-astra", "kimi", "glm", "qwen-3-8-27b"];
const pendingIds = targetIds.filter((id) => !includedIds.includes(id));

const selectedSources = [
  { id: "opus", file: paths.opus, source: "Selected Claude Opus Max public/private audit" },
  { id: "deepseek-pro", root: paths.deepseek, source: "Selected DeepSeek-V4-Pro public/private audit" },
  { id: "kimi", root: paths.kimi, source: "Selected Kimi-K3 public/private audit" },
  { id: "glm", file: paths.glm, source: "Selected GLM-5.2 public/private audit" },
  { id: "qwen-3-8-27b", file: paths.qwen, source: "Selected Qwen3.8-27B public/private audit" },
].map((entry) => ({ ...entry, rows: entry.root ? parseLocalResults(entry.root, entry.id) : parseSelectedRuns(entry.file) }));
const gptRows = parseGptMaxRows(paths.gpt, selectedSources[0].rows);
const astraRows = parseSelectedRuns(paths.astra);

const taskIds = [...selectedSources[0].rows.keys()].sort();
if (taskIds.length !== 119) throw new Error(`Expected 119 tasks, found ${taskIds.length}`);
const ablationIds = new Set();
for (let id = 2; id <= 82; id += 1) ablationIds.add(String(id).padStart(3, "0"));
[84, 86, 90, 111, 114].forEach((id) => ablationIds.add(String(id).padStart(3, "0")));
for (let id = 97; id <= 101; id += 1) ablationIds.add(String(id).padStart(3, "0"));

const results = {};
for (const taskId of taskIds) {
  const publishedId = taskId === "120" ? "001" : taskId;
  const taskResults = {};
  for (const entry of selectedSources) {
    const result = entry.rows.get(taskId);
    if (!result) throw new Error(`Missing selected result for ${entry.id} task ${taskId}`);
    taskResults[entry.id] = { ...result, transition: null, source: entry.source };
  }

  const gpt = gptRows.get(taskId);
  if (!gpt) throw new Error(`Missing selected result for GPT Max task ${taskId}`);
  taskResults.gpt = { ...gpt, transition: null, source: "Offline GPT-5.6-sol Max rerun audit" };

  const astra = astraRows.get(taskId);
  if (!astra) throw new Error(`Missing selected result for GPT-6 Astra Max task ${taskId}`);
  taskResults["gpt-6-astra"] = { ...astra, transition: null, source: "GPT-6 Astra official Max audit" };

  results[publishedId] = {
    publishedTaskId: publishedId,
    legacyTaskId: taskId,
    scientificKnowledgeAblation: ablationIds.has(publishedId),
    results: taskResults,
  };
}

const models = includedIds.map((id) => benchmark.models.find((model) => model.id === id)).filter(Boolean);
const output = {
  version: 1,
  generatedAt: new Date().toISOString().slice(0, 10),
  referenceModel: { id: "nex", label: "Nex N2", overallPassAt1: nex.scores.overall, note: "Reference threshold from the current leaderboard snapshot; no complete Feishu per-task table is available." },
  selectionRule: "Models with benchmark.json overall Pass@1 above Nex N2 (24.37%).",
  includedModels: includedIds,
  pendingModels: pendingIds,
  models,
  tasks: Object.values(results).sort((a, b) => a.publishedTaskId.localeCompare(b.publishedTaskId)),
};

fs.writeFileSync(path.join(repoRoot, "data/task-matrix.json"), `${JSON.stringify(output, null, 2)}\n`);
console.log(`Wrote ${output.tasks.length} tasks for ${output.includedModels.length} target models.`);
console.log(`Pending target models: ${output.pendingModels.join(", ") || "none"}`);
