import hard70Data from "@/data/hard70.json";
import hard70ModelResults from "@/data/hard70-model-results.json";
import matrixData from "@/data/task-matrix.json";
import { benchmarkData, getModelDisplayName } from "@/lib/benchmark";

type MatrixTask = {
  publishedTaskId: string;
  results: Record<string, { reward: number }>;
};

const hard70 = hard70Data as { taskIds: string[]; modelIds: string[] };
const matrix = matrixData as { tasks: MatrixTask[] };
const supplementalPasses = new Map(
  Object.entries(hard70ModelResults.modelPasses).map(([modelId, taskIds]) => [modelId, new Set(taskIds)]),
);

export function Hard70Leaderboard() {
  const tasksById = new Map(matrix.tasks.map((task) => [task.publishedTaskId, task]));
  const rows = hard70.modelIds.map((modelId, order) => {
    const model = benchmarkData.models.find((candidate) => candidate.id === modelId);
    if (!model) throw new Error(`Hard70 model is missing from benchmark data: ${modelId}`);

    const passed = hard70.taskIds.reduce((total, taskId) => {
      const matrixReward = tasksById.get(taskId)?.results[modelId]?.reward;
      const reward = matrixReward ?? (supplementalPasses.get(modelId)?.has(taskId) ? 1 : 0);
      return total + (reward === 1 ? 1 : 0);
    }, 0);

    return {
      model,
      order,
      passed,
      score: (passed / hard70.taskIds.length) * 100,
    };
  }).sort((left, right) => right.passed - left.passed || left.order - right.order);

  return (
    <section className="hard70-section" id="hard70" aria-labelledby="hard70-title">
      <div className="section-heading">
        <div>
          <span className="section-number">03</span>
          <h2 id="hard70-title">Hard70</h2>
        </div>
        <p>Models above 20% on the full benchmark, evaluated on the Hard70 subset.</p>
      </div>

      <p className="hard70-methodology">
        As of August 28, 2026, 16:31 UTC, we estimated task difficulty using the 12 models with complete results for all 119 tasks available at that time: Claude Opus 5 Max, GLM-5.2, Qwen3.8-27B, GPT-5.6-sol, Nex-N2-Pro, DeepSeek V4 Flash, Intern-S2-Preview-397B, Qwen3.6-35B-A3B, Nex-N2-mini, agents-a1, BigBang-v1, and Qwen3.5-9B. For each task, a model receives a binary reward of <code>1</code> if it passes the complete task evaluation and <code>0</code> otherwise. We average these rewards across the 12 models and select the 70 tasks with the lowest mean reward as this subset.
      </p>

      <div className="hard70-table-wrap">
        <table className="hard70-table">
          <thead>
            <tr>
              <th scope="col" className="hard70-rank-column">Rank</th>
              <th scope="col" className="hard70-model-column">Model</th>
              <th scope="col" className="hard70-agent-column">Agent</th>
              <th scope="col" className="hard70-score-column">Pass@1</th>
              <th scope="col" className="hard70-input-column">Input tokens / task</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const rank = rows.findIndex((candidate) => candidate.passed === row.passed) + 1;
              const score = `${row.score.toFixed(2)}%`;
              return (
                <tr key={row.model.id}>
                  <td className="hard70-rank-column"><span className={rank <= 3 ? "top-rank" : ""}>{String(rank).padStart(2, "0")}</span></td>
                  <th scope="row" className="hard70-model-column">{getModelDisplayName(row.model)}</th>
                  <td className="hard70-agent-column">{row.model.harness}</td>
                  <td className="hard70-score-column">
                    <div className="hard70-score" title={`${row.passed} of ${hard70.taskIds.length} tasks passed`}>
                      <strong>{score}</strong>
                      <span
                        className="hard70-bar"
                        role="progressbar"
                        aria-label={`${getModelDisplayName(row.model)} Hard70 Pass@1`}
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={Number(row.score.toFixed(2))}
                      >
                        <i style={{ width: score }} />
                      </span>
                    </div>
                  </td>
                  <td className="hard70-input-column" title="Mean input tokens per task on the full benchmark">
                    {row.model.tokens.input.toFixed(3)}M
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <details className="hard70-task-list">
        <summary>Tasks in Hard70 ({hard70.taskIds.length})</summary>
        <p>{hard70.taskIds.join(", ")}</p>
      </details>
    </section>
  );
}
