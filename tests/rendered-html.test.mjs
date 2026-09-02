import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

test("renders the SWE-bench Science project page", async () => {
  const html = await readFile(new URL("../out/index.html", import.meta.url), "utf8");
  assert.match(html, /<title>SWE-bench Science — Leaderboard<\/title>/i);
  assert.match(html, /Leaderboard/);
  assert.match(html, /Model results/);
  assert.match(html, /119/);
  assert.match(html, /huggingface\.co\/datasets\/OpenMOSS-Team\/SWE-bench-Science/);
  assert.match(html, /github\.com\/OpenMOSS\/SWE-bench-Science/);
  assert.match(html, /task-matrix\/gradient/);
  assert.match(html, /Hard70/);
  assert.match(html, /id="hard70"/);
  assert.match(html, /Models above 20% on the full benchmark, evaluated on the Hard70 subset/);
  assert.match(html, /As of August 28, 2026, 16:31 UTC/);
  assert.match(html, /select the 70 tasks with the lowest mean reward as this subset/);
  assert.match(html, /href="#hard70">Hard70 subset/);
  assert.match(html, /21\.43%/);
  assert.match(html, /20\.00%/);
  assert.match(html, /14\.29%/);
  assert.match(html, /Input tokens \/ task/);
  assert.match(html, /21\.990/);
  assert.match(html, /Nex N2/);
  assert.match(html, /DeepSeek-V4-flash \(max\)/);
  assert.match(html, /Intern-S2-Preview-397B \(max\)/);
  assert.match(html, /<summary>Tasks in Hard70/);
  assert.match(html, /001, 002, 003, 005/);
  assert.match(html, /114, 116, 117, 119/);
  assert.doesNotMatch(html, /task-matrix\/trace/);
});

test("computes the Hard70 leaderboard from task-level results", async () => {
  const hard70 = JSON.parse(await readFile(new URL("../data/hard70.json", import.meta.url), "utf8"));
  const benchmark = JSON.parse(await readFile(new URL("../data/benchmark.json", import.meta.url), "utf8"));
  const matrix = JSON.parse(await readFile(new URL("../data/task-matrix.json", import.meta.url), "utf8"));
  const supplemental = JSON.parse(await readFile(new URL("../data/hard70-model-results.json", import.meta.url), "utf8"));
  assert.equal(hard70.taskIds.length, 70);
  assert.equal(new Set(hard70.taskIds).size, 70);
  assert.deepEqual(hard70.modelIds, benchmark.models.filter((model) => model.scores.overall > 20).map((model) => model.id));

  const expectedPassCounts = { opus: 15, "deepseek-pro": 14, gpt: 10, kimi: 5, glm: 4, "qwen-3-8-27b": 4, nex: 2, "deepseek-max": 1, "intern-s2-preview-397b": 1 };
  for (const [modelId, expected] of Object.entries(expectedPassCounts)) {
    const supplementalPasses = new Set(supplemental.modelPasses[modelId] ?? []);
    const passed = hard70.taskIds.filter((taskId) => {
      const task = matrix.tasks.find((candidate) => candidate.publishedTaskId === taskId);
      return task.results[modelId]?.reward === 1 || supplementalPasses.has(taskId);
    }).length;
    assert.equal(passed, expected, `${modelId} Hard70 pass count`);
  }

  for (const [modelId, passedTaskIds] of Object.entries(supplemental.modelPasses)) {
    const model = benchmark.models.find((candidate) => candidate.id === modelId);
    assert.equal(Number(((passedTaskIds.length / supplemental.taskCount) * 100).toFixed(2)), model.scores.overall);
  }
});

test("exports the task trace viewer", async () => {
  const html = await readFile(new URL("../out/task-matrix/trace/index.html", import.meta.url), "utf8");
  assert.match(html, /SWE-bench Science/);
  assert.match(html, /Loading trace index and task record/);
  assert.match(html, /Task matrix/);
  assert.doesNotMatch(html, /Workspace/);
  assert.doesNotMatch(html, /legacy|UCloud|linux\/amd64|api\.modelverse\.cn/);

  const traceViewer = await readFile(new URL("../app/TraceViewer.tsx", import.meta.url), "utf8");
  assert.match(traceViewer, /useState<"focus" \| "full">\("full"\)/);
  assert.doesNotMatch(traceViewer, />Focus\s*</);
});

test("keeps trace entry points inside task details", async () => {
  const html = await readFile(new URL("../out/task-matrix/gradient/index.html", import.meta.url), "utf8");
  assert.match(html, /#task-details/);
  assert.match(html, /Open trace/);
  assert.match(html, /href="\/"/);
  assert.doesNotMatch(html, /Trace browser/);
});

test("publishes the current model trace records per task", async () => {
  const registry = JSON.parse(await readFile(new URL("../public/traces/index.json", import.meta.url), "utf8"));
  assert.deepEqual(registry.experiments.map((experiment) => experiment.id), [
    "claude-opus-5-max",
    "gpt-5-6-sol-max",
    "deepseek-v4-pro-max",
    "kimi-k3-max",
    "glm-5-2-max",
    "qwen3-8-27b-xhigh",
  ]);

  const builder = await readFile(new URL("../scripts/build-traces.mjs", import.meta.url), "utf8");
  assert.match(builder, /legacyTaskId === "120" \? "001" : legacyTaskId/);

  for (const experiment of registry.experiments) {
    const root = new URL(`../public/traces/${experiment.path}/`, import.meta.url);
    const index = JSON.parse(await readFile(new URL("index.json", root), "utf8"));
    assert.equal(index.taskCount, 119);
    assert.equal(index.tasks.length, 119);
    assert.equal(index.tasks[0].publishedTaskId, "001");
    assert.equal(index.tasks[1].publishedTaskId, "002");
    assert.equal(index.tasks.at(-1).publishedTaskId, "119");

    for (const entry of index.tasks) {
      await access(new URL(entry.file, root));
      const text = await readFile(new URL(entry.file, root), "utf8");
      const trace = JSON.parse(text);
      const nonReasoningText = JSON.stringify({ ...trace, events: trace.events.filter((event) => event.kind !== "thinking") });
      assert.equal(trace.task.publishedTaskId, entry.publishedTaskId);
      assert.equal(Object.hasOwn(trace, "workspace"), false);
      assert.equal(typeof trace.evaluation.verifierLog, "string");
      assert.match(trace.evaluation.verifierLog, /science-bench/);
      assert.equal(trace.events.some((event) => event.truncated || event.result?.truncated), false, "Trace events retain complete text");
      assert.doesNotMatch(nonReasoningText, /\/Users\/fnlp/);
      assert.doesNotMatch(nonReasoningText, /(?:artifacts\/)?model\.patch/);
      assert.doesNotMatch(nonReasoningText, /api\.modelverse\.cn|\.sii\.edu\.cn|linux\/amd64|UCloud|host\.docker\.internal/);
    }
  }

  const glmTask = JSON.parse(await readFile(new URL("../public/traces/glm-5-2-max/task-002.json", import.meta.url), "utf8"));
  assert.ok(glmTask.events.some((event) => event.kind === "thinking"), "GLM reasoning from .codex-home should be represented");
  assert.ok(glmTask.events.some((event) => event.kind === "thinking" && event.text && event.redacted === false), "Readable GLM reasoning should be published");
  assert.ok(glmTask.events.some((event) => event.elapsedSec > 0), "GLM rollout timestamps should produce elapsed event times");
  assert.match(glmTask.events.find((event) => event.kind === "lifecycle").timestamp ?? "", /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(glmTask.events.some((event) => Object.hasOwn(event, "position")), false, "Reasoning anchor positions stay internal");
  const glmRerunUsageTask = JSON.parse(await readFile(new URL("../public/traces/glm-5-2-max/task-004.json", import.meta.url), "utf8"));
  assert.deepEqual(
    {
      input: glmRerunUsageTask.usage.inputTokens,
      output: glmRerunUsageTask.usage.outputTokens,
      total: glmRerunUsageTask.usage.totalTokens,
      cacheRead: glmRerunUsageTask.usage.cacheReadTokens,
      calls: glmRerunUsageTask.usage.callCount,
    },
    { input: 6099057, output: 179227, total: 6278284, cacheRead: 5667520, calls: 121 },
    "GLM trace usage should come from the Feishu token-source table",
  );
  assert.equal(glmRerunUsageTask.evaluation.private.passed, 2, "GLM evaluation should remain from the selected evaluation run");
  const opusTask = JSON.parse(await readFile(new URL("../public/traces/claude-opus-5-max/task-002.json", import.meta.url), "utf8"));
  assert.equal(opusTask.events.some((event) => event.kind === "thinking" && event.reasoningStatus === "unavailable"), false, "Empty Opus thinking markers should not be published");
  const kimiTask = JSON.parse(await readFile(new URL("../public/traces/kimi-k3-max/task-002.json", import.meta.url), "utf8"));
  assert.ok(kimiTask.events.some((event) => event.kind === "thinking" && event.redacted === false && event.text), "Kimi thinking.jsonl reasoning should be published");
  assert.ok(kimiTask.events.some((event) => event.kind === "thinking" && event.elapsedSec > 0), "Kimi wire timestamps should produce elapsed event times");
  const gptTask = JSON.parse(await readFile(new URL("../public/traces/gpt-5-6-sol-max/task-002.json", import.meta.url), "utf8"));
  assert.ok(gptTask.events.some((event) => event.kind === "thinking" && event.redacted === true && event.reasoningStatus === "encrypted"), "GPT encrypted reasoning should remain explicitly marked");
  assert.ok(gptTask.events.some((event) => event.kind === "thinking" && event.elapsedSec > 0), "GPT rollout timestamps should produce elapsed event times");
});

test("keeps matrix metrics aligned with every published trace", async () => {
  const matrix = JSON.parse(await readFile(new URL("../data/task-matrix.json", import.meta.url), "utf8"));
  const experiments = {
    opus: "claude-opus-5-max",
    gpt: "gpt-5-6-sol-max",
    "deepseek-pro": "deepseek-v4-pro-max",
    kimi: "kimi-k3-max",
    glm: "glm-5-2-max",
    "qwen-3-8-27b": "qwen3-8-27b-xhigh",
  };
  assert.equal(matrix.tasks.length, 119);
  assert.deepEqual(matrix.tasks.map((task) => task.publishedTaskId), Array.from({ length: 119 }, (_, index) => String(index + 1).padStart(3, "0")));
  assert.equal(matrix.tasks.find((task) => task.publishedTaskId === "001").legacyTaskId, "120");
  assert.equal(matrix.tasks.find((task) => task.publishedTaskId === "076").legacyTaskId, "076");

  for (const task of matrix.tasks) {
    for (const [modelId, experiment] of Object.entries(experiments)) {
      const trace = JSON.parse(await readFile(new URL(`../public/traces/${experiment}/task-${task.publishedTaskId}.json`, import.meta.url), "utf8"));
      const result = task.results[modelId];
      assert.deepEqual(
        [result.public.passed, result.public.total, result.private.passed, result.private.total, result.reward],
        [trace.evaluation.public.passed, trace.evaluation.public.collected, trace.evaluation.private.passed, trace.evaluation.private.collected, trace.evaluation.reward],
        `${modelId} task ${task.publishedTaskId} matrix/trace mismatch`,
      );
    }
  }
});

test("keeps GPT, Kimi, and DeepSeek trace aggregates aligned with the homepage", async () => {
  const benchmark = JSON.parse(await readFile(new URL("../data/benchmark.json", import.meta.url), "utf8"));
  const expected = {
    gpt: ["gpt-5-6-sol-max", 40.34],
    "deepseek-pro": ["deepseek-v4-pro-max", 42.02],
    kimi: ["kimi-k3-max", 35.29],
  };

  for (const [modelId, [experiment, homepageScore]] of Object.entries(expected)) {
    const index = JSON.parse(await readFile(new URL(`../public/traces/${experiment}/index.json`, import.meta.url), "utf8"));
    const passCount = index.tasks.filter((task) => task.evaluation.reward === 1).length;
    const score = Number(((passCount / index.taskCount) * 100).toFixed(2));
    assert.equal(score, homepageScore, `${modelId} trace aggregate should match homepage`);
    assert.equal(benchmark.models.find((model) => model.id === modelId)?.scores.overall, homepageScore);
  }
});

test("publishes the offline GPT Max rerun in the matrix with a matching trace entry", async () => {
  const benchmark = JSON.parse(await readFile(new URL("../data/benchmark.json", import.meta.url), "utf8"));
  const matrix = JSON.parse(await readFile(new URL("../data/task-matrix.json", import.meta.url), "utf8"));
  const registry = JSON.parse(await readFile(new URL("../public/traces/index.json", import.meta.url), "utf8"));
  const component = await readFile(new URL("../app/TaskMatrix.tsx", import.meta.url), "utf8");
  const gpt = benchmark.models.find((model) => model.id === "gpt");
  const passCount = matrix.tasks.filter((task) => task.results.gpt.reward === 1).length;

  assert.ok(matrix.includedModels.includes("gpt"));
  assert.ok(!matrix.pendingModels.includes("gpt"));
  assert.equal(passCount, 48);
  assert.equal(Number(((passCount / matrix.tasks.length) * 100).toFixed(2)), gpt.scores.overall);
  assert.equal(gpt.scores.overall, 40.34);
  assert.equal(matrix.tasks[0].results.gpt.source, "Offline GPT-5.6-sol Max rerun audit");
  assert.ok(registry.experiments.some((experiment) => experiment.id === "gpt-5-6-sol-max"));
  assert.match(component, /gpt:\s*"gpt-5-6-sol-max"/);
});
