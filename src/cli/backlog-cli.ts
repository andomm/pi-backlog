import { BacklogManager, getBacklogPath } from "../lib/backlog.js";

const args = process.argv.slice(2);

// Global option: --file <path> (overrides PI_BACKLOG_PATH). Removed before command parsing.
const fileIdx = args.indexOf("--file");
if (fileIdx !== -1) {
  const file = args[fileIdx + 1];
  if (!file) {
    console.error("--file requires a path");
    process.exit(1);
  }
  process.env.PI_BACKLOG_PATH = file;
  args.splice(fileIdx, 2);
}
const manager = new BacklogManager(getBacklogPath());

function usage() {
  console.log(`
Usage: pi-backlog [--file <path>] <command> [options]

Backlog file: --file, else $PI_BACKLOG_PATH, else ~/wiki/backlog.md (created if missing).

Commands:
  list [--open|--done|--all] [--section <name>] [--json] [--query <text>]
  add <title> [--section <name>] [--priority high|med|low] [--ticket <key>] [--detail <text>]... [--subtask <text>]...
  done <id>
  undone <id>
  delete <id>
  show <id>
  sections
  subtask-add <id> <title>
  subtask-done <id> <subtask>
  subtask-undone <id> <subtask>
  subtask-delete <id> <subtask>

  <subtask> is a 1-based number (see list/show) or a title (exact, then unique substring).
`);
  process.exit(0);
}

if (args.length === 0 || args.includes("-h") || args.includes("--help")) {
  usage();
}

const cmd = args[0];

function getOpt(name: string): string | undefined {
  const idx = args.indexOf(name);
  if (idx !== -1 && idx + 1 < args.length) {
    return args[idx + 1];
  }
  return undefined;
}

function getArrayOpts(name: string): string[] {
  const result: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === name && i + 1 < args.length) {
      result.push(args[i + 1]);
    }
  }
  return result;
}

switch (cmd) {
  case "list": {
    const isJson = args.includes("--json");
    const openOnly = args.includes("--open");
    const doneOnly = args.includes("--done");
    const section = getOpt("--section");
    const query = getOpt("--query");

    const tasks = manager.getTasks({
      done: openOnly ? false : doneOnly ? true : undefined,
      section,
      query,
    });

    if (isJson) {
      console.log(JSON.stringify(tasks, null, 2));
    } else {
      if (tasks.length === 0) {
        console.log("No tasks found.");
        break;
      }
      let currentSection = "";
      for (const t of tasks) {
        if (t.section !== currentSection) {
          currentSection = t.section;
          console.log(`\n\x1b[1m\x1b[36m## ${currentSection}\x1b[0m`);
        }
        const mark = t.done ? "\x1b[32m[x]\x1b[0m" : "\x1b[33m[ ]\x1b[0m";
        const meta = [
          t.priority ? `\x1b[35m[${t.priority}]\x1b[0m` : "",
          t.ticket ? `\x1b[34m[${t.ticket}]\x1b[0m` : "",
        ].filter(Boolean).join(" ");
        const progress = t.subtasks.length > 0
          ? `\x1b[2m[${t.subtasks.filter((s) => s.done).length}/${t.subtasks.length}]\x1b[0m`
          : "";
        console.log(`  ${mark} \x1b[1m${t.title}\x1b[0m \x1b[2m(${t.id})\x1b[0m ${meta} ${progress}`);
        t.subtasks.forEach((s, i) => {
          const subMark = s.done ? "\x1b[32m[x]\x1b[0m" : "\x1b[33m[ ]\x1b[0m";
          console.log(`      ${i + 1}. ${subMark} ${s.title}`);
          for (const d of s.details) console.log(`           \x1b[2m- ${d}\x1b[0m`);
        });
        for (const d of t.details) {
          console.log(`    ${d.trim()}`);
        }
      }
    }
    break;
  }

  case "sections": {
    const sections = Array.from(new Set(manager.getTasks().map(t => t.section)));
    console.log(sections.join("\n"));
    break;
  }

  case "show": {
    const id = args[1];
    if (!id) {
      console.error("Error: Missing task id");
      process.exit(1);
    }
    const task = manager.getTask(id);
    if (!task) {
      console.error(`Task '${id}' not found.`);
      process.exit(1);
    }
    console.log(JSON.stringify(task, null, 2));
    break;
  }

  case "add": {
    const title = args[1];
    if (!title || title.startsWith("-")) {
      console.error("Error: Task title required as first argument after add");
      process.exit(1);
    }
    const section = getOpt("--section") || "General";
    const priority = getOpt("--priority") as "high" | "med" | "low" | undefined;
    const ticket = getOpt("--ticket");
    const details = getArrayOpts("--detail");
    const subtasks = getArrayOpts("--subtask");

    const created = manager.addTask({
      title,
      section,
      priority,
      ticket,
      details,
      subtasks,
    });
    console.log(`Created task [${created.id}] in ## ${created.section}`);
    break;
  }

  case "done": {
    const id = args[1];
    if (!id) {
      console.error("Error: Missing task id");
      process.exit(1);
    }
    const updated = manager.updateTask(id, { done: true });
    if (!updated) {
      console.error(`Task '${id}' not found.`);
      process.exit(1);
    }
    console.log(`Marked [${id}] done.`);
    break;
  }

  case "undone": {
    const id = args[1];
    if (!id) {
      console.error("Error: Missing task id");
      process.exit(1);
    }
    const updated = manager.updateTask(id, { done: false });
    if (!updated) {
      console.error(`Task '${id}' not found.`);
      process.exit(1);
    }
    console.log(`Marked [${id}] open.`);
    break;
  }

  case "delete": {
    const id = args[1];
    if (!id) {
      console.error("Error: Missing task id");
      process.exit(1);
    }
    const ok = manager.deleteTask(id);
    if (!ok) {
      console.error(`Task '${id}' not found.`);
      process.exit(1);
    }
    console.log(`Deleted [${id}].`);
    break;
  }

  case "subtask-add":
  case "subtask-done":
  case "subtask-undone":
  case "subtask-delete": {
    const id = args[1];
    const ref = args[2];
    const title = cmd === "subtask-add" ? args.slice(2).join(" ") : undefined;
    if (!id || (!ref && cmd !== "subtask-add") || (cmd === "subtask-add" && !title)) {
      console.error(`Error: Usage: pi-backlog ${cmd} <id> ${cmd === "subtask-add" ? "<title>" : "<subtask>"}`);
      process.exit(1);
    }
    try {
      if (cmd === "subtask-add") {
        const sub = manager.addSubtask(id, title!);
        console.log(`Added subtask to [${id}]: ${sub.title}`);
      } else if (cmd === "subtask-delete") {
        const removed = manager.deleteSubtask(id, ref!);
        console.log(`Deleted subtask from [${id}]: ${removed.title}`);
      } else {
        const sub = manager.updateSubtask(id, ref!, { done: cmd === "subtask-done" });
        console.log(`Marked subtask [${sub.title}] of [${id}] ${sub.done ? "done" : "open"}.`);
      }
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
    break;
  }

  default:
    console.error(`Unknown command: ${cmd}`);
    usage();
}
