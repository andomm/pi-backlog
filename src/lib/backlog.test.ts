import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { BacklogManager, parseSubtaskText, subtaskState } from "./backlog.js";

function makeManager(): { manager: BacklogManager; file: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "backlog-test-"));
  const file = path.join(dir, "backlog.md");
  fs.writeFileSync(file, "# Backlog\n\n## Work\n\n");
  const manager = new BacklogManager(file);
  manager.addTask({
    title: "Parent",
    section: "Work",
    subtasks: ["First", "Second [blocked-by: 1]", "Third [blocked-by: 1, 2]"],
  });
  return { manager, file };
}

test("parseSubtaskText splits title and blockers", () => {
  assert.deepEqual(parseSubtaskText("Do it [blocked-by: 3, 1, 3]"), { title: "Do it", blockedBy: [1, 3] });
  assert.deepEqual(parseSubtaskText("Plain"), { title: "Plain", blockedBy: [] });
  assert.deepEqual(parseSubtaskText("Empty [blocked-by: ]"), { title: "Empty", blockedBy: [] });
});

test("blocked state follows done flags without rewriting", () => {
  const { manager, file } = makeManager();
  const task = () => manager.getTask("parent")!;
  assert.equal(subtaskState(task(), 1).blocked, true);
  assert.deepEqual(subtaskState(task(), 2).openBlockers, [1, 2]);

  manager.updateSubtask("parent", "1", { done: true });
  assert.equal(subtaskState(task(), 1).blocked, false);
  assert.deepEqual(subtaskState(task(), 2).openBlockers, [2]);
  assert.match(fs.readFileSync(file, "utf-8"), /Second \[blocked-by: 1\]/);

  manager.updateSubtask("parent", "1", { done: false });
  assert.equal(subtaskState(task(), 1).blocked, true);
});

test("tag round-trips through the file", () => {
  const { file } = makeManager();
  const reloaded = new BacklogManager(file).getTask("parent")!;
  assert.deepEqual(reloaded.subtasks.map((s) => s.blockedBy), [[], [1], [1, 2]]);
  assert.equal(reloaded.subtasks[2].title, "Third");
});

test("deleting a subtask renumbers and drops references", () => {
  const { manager } = makeManager();
  manager.deleteSubtask("parent", "1");
  const subs = manager.getTask("parent")!.subtasks;
  assert.deepEqual(subs.map((s) => s.title), ["Second", "Third"]);
  assert.deepEqual(subs.map((s) => s.blockedBy), [[], [1]]);
});

test("add and update validate blocker numbers", () => {
  const { manager } = makeManager();
  assert.throws(() => manager.addSubtask("parent", "Bad", [9]), /does not exist/);
  assert.throws(() => manager.updateSubtask("parent", "2", { blockedBy: [2] }), /cannot block itself/);
  manager.addSubtask("parent", "Fourth", [3]);
  assert.deepEqual(manager.getTask("parent")!.subtasks[3].blockedBy, [3]);
  manager.updateSubtask("parent", "4", { blockedBy: [] });
  assert.deepEqual(manager.getTask("parent")!.subtasks[3].blockedBy, []);
});

test("plain title update keeps blockers; tag in title replaces them", () => {
  const { manager } = makeManager();
  manager.updateSubtask("parent", "3", { title: "Renamed" });
  assert.deepEqual(manager.getTask("parent")!.subtasks[2].blockedBy, [1, 2]);
  manager.updateSubtask("parent", "3", { title: "Renamed [blocked-by: 2]" });
  assert.deepEqual(manager.getTask("parent")!.subtasks[2].blockedBy, [2]);
});

test("unknown blocker keeps subtask blocked", () => {
  const { manager, file } = makeManager();
  fs.appendFileSync(file, "");
  const task = manager.getTask("parent")!;
  task.subtasks[0].blockedBy = [7];
  assert.deepEqual(subtaskState(task, 0).unknownBlockers, [7]);
  assert.equal(subtaskState(task, 0).blocked, true);
});

test("subtask details round-trip and stay apart from task details", () => {
  const { manager, file } = makeManager();
  manager.updateTask("parent", { details: ["Spec: somewhere"] });
  manager.updateSubtask("parent", "1", { details: ["- Criterion A", "  Criterion B", ""] });
  manager.addSubtask("parent", "Fourth", [1], ["Note"]);

  const text = fs.readFileSync(file, "utf-8");
  assert.match(text, /  - \[ \] First\n    - Criterion A\n    - Criterion B\n  - \[ \] Second/);

  const task = new BacklogManager(file).getTask("parent")!;
  assert.deepEqual(task.subtasks.map((s) => s.details), [["Criterion A", "Criterion B"], [], [], ["Note"]]);
  assert.deepEqual(task.subtasks[3].blockedBy, [1]);
  assert.equal(task.details.length, 1);
  assert.match(task.details[0], /Spec: somewhere/);
});

test("update replaces details, empty array clears, plain rename keeps them", () => {
  const { manager } = makeManager();
  manager.updateSubtask("parent", "1", { details: ["one", "two"] });
  manager.updateSubtask("parent", "1", { title: "Renamed" });
  assert.deepEqual(manager.getTask("parent")!.subtasks[0].details, ["one", "two"]);
  manager.updateSubtask("parent", "1", { details: ["only"] });
  assert.deepEqual(manager.getTask("parent")!.subtasks[0].details, ["only"]);
  manager.updateSubtask("parent", "1", { details: [] });
  assert.deepEqual(manager.getTask("parent")!.subtasks[0].details, []);
});

test("deeper detail lines under a task detail are not taken by a subtask", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "backlog-test-"));
  const file = path.join(dir, "backlog.md");
  fs.writeFileSync(file, "## Work\n\n- [ ] **T** <!-- id: t -->\n  - [ ] Sub\n  - Detail\n    - nested\n\n");
  const task = new BacklogManager(file).getTask("t")!;
  assert.deepEqual(task.subtasks[0].details, []);
  assert.equal(task.details.length, 2);
});

test("done tasks are written to a trailing Done section grouped by origin section", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "backlog-test-"));
  const file = path.join(dir, "backlog.md");
  fs.writeFileSync(
    file,
    "# B\n\n## A\n\n- [x] **A1** <!-- id: a1 -->\n\n- [ ] **A2** <!-- id: a2 -->\n\n## B\n\n- [ ] **B1** <!-- id: b1 -->\n",
  );
  const manager = new BacklogManager(file);
  manager.addTask({ title: "A3", section: "A" });
  manager.updateTask("b1", { done: true });
  const text = fs.readFileSync(file, "utf-8");
  const headings = [...text.matchAll(/^#{2,3} .+$/gm)].map((m) => m[0]);
  assert.deepEqual(headings, ["## A", "## B", "## Done", "### A", "### B"]);
  const ids = [...text.matchAll(/id: (\w+)/g)].map((m) => m[1]);
  assert.deepEqual(ids, ["a2", "a3", "a1", "b1"]);

  // Round trip: origin sections survive reload, and reopening moves a task back.
  const again = new BacklogManager(file);
  assert.equal(again.getTask("b1")!.section, "B");
  assert.equal(again.getTask("b1")!.done, true);
  assert.equal(again.getTasks().some((t) => t.section === "Done"), false);
  again.updateTask("a1", { done: false });
  const after = fs.readFileSync(file, "utf-8");
  assert.deepEqual([...after.matchAll(/^#{2,3} .+$/gm)].map((m) => m[0]), ["## A", "## B", "## Done", "### B"]);
});
