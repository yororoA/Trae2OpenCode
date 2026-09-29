import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseTraeSubagentRuns } from "../trae/subagent-runs.js";

function content(overrides: Record<string, unknown> = {}) {
  const shared = {
    agent_run_id: "run-child",
    parent_agent_run_ids: ["run-parent"],
    agent_id: "reviewer",
    agent_display_name: "Reviewer",
    sub_agent_call_description: "Review the change",
  };
  return {
    messages: [
      {
        type: "plan_item",
        plan_item: {
          ...shared,
          id: "plan-child-start",
          agent_status: { status: "running", run_mode: "foreground" },
          timing: {
            generated_at_ms: 1_700_000_001_000,
            tool_call_started_at_ms: 1_700_000_001_100,
            tool_call_finished_at_ms: 1_700_000_001_500,
          },
          ...overrides,
        },
      },
      {
        type: "plan_item",
        plan_item: {
          ...shared,
          id: "plan-child-complete",
          agent_status: { status: "completed", run_mode: "foreground" },
          thought: "Review complete",
          timing: { generated_at_ms: 1_700_000_002_000 },
          tool_call_info: { name: "", params: null, result: {} },
        },
      },
    ],
  };
}

describe("parseTraeSubagentRuns", () => {
  it("requires consistent parent, agent, description and completion evidence", () => {
    const report = parseTraeSubagentRuns(content(), "task", "3.3.104");
    assert.deepEqual(report.issues, []);
    assert.equal(report.runs.length, 1);
    assert.deepEqual(report.runs[0], {
      sourceRunId: "run-child",
      parentRunIds: ["run-parent"],
      agentId: "reviewer",
      agentDisplayName: "Reviewer",
      description: "Review the change",
      runMode: "foreground",
      entryIndexes: [0, 1],
      responseEntryIndex: 1,
      createdAt: 1_700_000_001_000,
      completedAt: 1_700_000_002_000,
      sources: report.runs[0].sources,
    });
    assert.equal(report.runs[0].sources.length, 2);
  });

  it("keeps conflicting or incomplete runs out of reconstruction", () => {
    const conflict = content({ parent_agent_run_ids: ["another-parent"] });
    const conflictReport = parseTraeSubagentRuns(conflict, "task", "3.3.104");
    assert.deepEqual(conflictReport.runs, []);
    assert.ok(conflictReport.issues.some((issue) =>
      issue.code === "T2O_TRAE_SUBAGENT_RUN_CONFLICT"));

    const incomplete = content();
    const terminal = incomplete.messages[1].plan_item as Record<string, unknown>;
    terminal.agent_status = { status: "running", run_mode: "foreground" };
    const incompleteReport = parseTraeSubagentRuns(incomplete, "task", "3.3.104");
    assert.deepEqual(incompleteReport.runs, []);
    assert.ok(incompleteReport.issues.some((issue) =>
      issue.code === "T2O_TRAE_SUBAGENT_RUN_INCOMPLETE"));
  });

  it("ignores ordinary plan items and rejects unsupported product versions", () => {
    assert.deepEqual(parseTraeSubagentRuns({
      messages: [{ type: "plan_item", plan_item: { id: "ordinary-plan" } }],
    }, "task", "3.3.104"), { runs: [], issues: [] });
    assert.deepEqual(parseTraeSubagentRuns(content(), "general", "3.3.104"), {
      runs: [],
      issues: [],
    });
    assert.throws(
      () => parseTraeSubagentRuns(content(), "task", "3.4.0"),
      { code: "T2O_TRAE_ASSISTANT_MESSAGE_VERSION_UNSUPPORTED" },
    );
  });
});
