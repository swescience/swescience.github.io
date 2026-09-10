"use client";

import matrixData from "@/data/task-matrix.json";
import { getModelDisplayName } from "@/lib/benchmark";
import Link from "next/link";
import { useMemo, useState } from "react";

type Metric = { passed: number; total: number };
type MatrixResult = {
  public: Metric;
  private: Metric;
  reward: number;
  transition: null;
  source: string;
};
type MatrixModel = {
  id: string;
  family: string;
  reasoningDepth: "default" | "high" | "max" | "xhigh";
  harness: string;
  scores: { overall: number };
};
type MatrixTask = {
  publishedTaskId: string;
  legacyTaskId: string;
  scientificKnowledgeAblation?: boolean;
  results: Record<string, MatrixResult>;
};
type MatrixPayload = {
  referenceModel: { label: string; overallPassAt1: number };
  includedModels: string[];
  pendingModels: string[];
  models: MatrixModel[];
  tasks: MatrixTask[];
};

const data = matrixData as MatrixPayload;
const MODEL_COLORS: Record<string, string> = {
  opus: "#a96f62",
  gpt: "#527fa4",
  "gpt-6-astra": "#3f7f79",
  "deepseek-pro": "#7d8f9f",
  kimi: "#8a806b",
  glm: "#96758a",
  "qwen-3-8-27b": "#628d82",
};

function MatrixCell({ result }: { result: MatrixResult }) {
  const ratio = result.private.total ? result.private.passed / result.private.total : 0;
  const passed = result.reward === 1;
  const style = { "--matrix-intensity": ratio } as React.CSSProperties;

  return (
    <div
      className={`matrix-cell ${passed ? "is-pass" : "is-fail"}`}
      style={style}
      title={`${passed ? "PASS" : "FAIL"} | private ${result.private.passed}/${result.private.total}`}
    >
      <strong>{passed ? "PASS" : "FAIL"}</strong>
    </div>
  );
}

function formatMetric(metric: Metric) {
  if (!metric.total) return "-";
  return `${metric.passed}/${metric.total} (${((metric.passed / metric.total) * 100).toFixed(1)}%)`;
}

function traceHref(taskId: string, modelId: string, harness: string) {
  const experimentByModel: Record<string, string> = {
    opus: "claude-opus-5-max",
    gpt: "gpt-5-6-sol-max",
    "gpt-6-astra": "gpt-6-astra-max",
    "deepseek-pro": "deepseek-v4-pro-max",
    kimi: "kimi-k3-max",
    glm: "glm-5-2-max",
    "qwen-3-8-27b": "qwen3-8-27b-xhigh",
  };
  const params = new URLSearchParams({ task: taskId, experiment: experimentByModel[modelId] ?? "", model: modelId, harness });
  return `/task-matrix/trace?${params.toString()}`;
}

function TaskDetail({ task, models }: { task: MatrixTask; models: MatrixModel[] }) {
  const rows = models.map((model) => ({ model, result: task.results[model.id] })).filter((row) => row.result);
  const passedModels = rows.filter(({ result }) => result.reward === 1).length;

  return (
    <details className="task-detail">
      <summary className="task-detail-summary">
        <span className="task-detail-title">
          <strong>{task.publishedTaskId}</strong>
          {task.scientificKnowledgeAblation && <span className="task-detail-ablation">Ablation</span>}
        </span>
        <span className="task-detail-meta">{passedModels}/{rows.length} model Pass@1</span>
        <span className="task-detail-caret" aria-hidden="true">›</span>
      </summary>
      <div className="task-detail-body">
        <div className="task-detail-table-wrap">
          <table className="task-detail-table">
            <thead>
              <tr>
                <th scope="col">Model</th>
                <th scope="col">Harness</th>
                <th scope="col">Public</th>
                <th scope="col">Private</th>
                <th scope="col">Pass@1</th>
                <th scope="col">Trace</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ model, result }) => (
                <tr key={model.id}>
                  <th scope="row">{getModelDisplayName(model)}</th>
                  <td>{model.harness}</td>
                  <td className="task-detail-metric">{formatMetric(result.public)}</td>
                  <td className="task-detail-metric">{formatMetric(result.private)}</td>
                  <td>
                    <span className={`task-result-badge ${result.reward === 1 ? "is-pass" : "is-fail"}`}>
                      {result.reward === 1 ? "PASS" : "FAIL"}
                    </span>
                  </td>
                  <td>
                    {["opus", "gpt", "gpt-6-astra", "deepseek-pro", "kimi", "glm", "qwen-3-8-27b"].includes(model.id) ? (
                      <a className="task-trace-link" href={traceHref(task.publishedTaskId, model.id, model.harness)}>
                        Open trace <span aria-hidden="true">↗</span>
                      </a>
                    ) : <span className="task-trace-unavailable">Not available</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </details>
  );
}

export function TaskMatrix() {
  const [query, setQuery] = useState("");
  const [ablationOnly, setAblationOnly] = useState(false);
  const models = useMemo(() => data.models.filter((model) => data.includedModels.includes(model.id)), []);
  const tasks = useMemo(() => data.tasks.filter((task) => {
    const matchesQuery = !query || task.publishedTaskId.includes(query.padStart(3, "0"));
    return matchesQuery && (!ablationOnly || task.scientificKnowledgeAblation);
  }), [ablationOnly, query]);

  return (
    <main className="matrix-page matrix-gradient">
      <header className="matrix-header">
        <Link className="matrix-wordmark" href="/">SWE-bench Science</Link>
        <nav className="matrix-nav" aria-label="Matrix navigation">
          <Link href="/">Home</Link>
        </nav>
      </header>

      <section className="matrix-intro">
        <div className="matrix-kicker">Task-level results</div>
        <h1>Pass@1 matrix</h1>
        <p>
          One row per published task and one column per available model. The cell label is the task-level private-test Pass@1 result.
          Background intensity adds private-test progress as a visual cue.
        </p>
      </section>

      <section className="matrix-controls" aria-label="Matrix controls">
        <label className="matrix-search">
          <span>Find task</span>
          <input value={query} inputMode="numeric" onChange={(event) => setQuery(event.target.value.replace(/[^0-9]/g, "").slice(0, 3))} placeholder="001" />
        </label>
        <label className="matrix-check">
          <input type="checkbox" checked={ablationOnly} onChange={(event) => setAblationOnly(event.target.checked)} />
          <span>Scientific-knowledge ablation only</span>
        </label>
        <a className="matrix-jump-link" href="#task-details">Task details <span aria-hidden="true">↓</span></a>
      </section>

      <section className="matrix-legend" aria-label="Legend">
        <span className="matrix-scale-legend">
          <span>Private test pass fraction</span>
          <i className="matrix-scale" />
          <span>0%</span>
          <span>100%</span>
        </span>
        <span className="matrix-legend-note">Continuous scale; PASS / FAIL labels remain authoritative.</span>
      </section>

      <div className="matrix-table-wrap">
        <table className="matrix-table">
          <thead>
            <tr>
              <th scope="col" className="matrix-task-heading">Task</th>
              {models.map((model) => (
                <th scope="col" key={model.id} style={{ "--model-color": MODEL_COLORS[model.id] } as React.CSSProperties}>
                  <span className="matrix-model-dot" />
                  {getModelDisplayName(model)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {tasks.map((task) => (
              <tr key={task.publishedTaskId}>
                <th scope="row" className="matrix-task-id">{task.publishedTaskId}</th>
                {models.map((model) => (
                  <td key={model.id}><MatrixCell result={task.results[model.id]} /></td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <section className="task-details-section" id="task-details" aria-label="Task-level run details">
        <div className="task-details-heading">
          <h2>Task details</h2>
          <p>Expand a task to compare model, harness, test, and trace entries.</p>
        </div>
        <div className="task-details-list">
          {tasks.map((task) => <TaskDetail key={task.publishedTaskId} task={task} models={models} />)}
        </div>
      </section>

      <p className="matrix-footnote">
        Shading reflects the private-test pass fraction for each task; PASS@1 labels show whether the task passed.
      </p>
    </main>
  );
}
