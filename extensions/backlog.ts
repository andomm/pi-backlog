import { spawn } from "node:child_process";
import type { ExtensionAPI, Theme } from "@mariozechner/pi-coding-agent";
import { CURSOR_MARKER, Key, matchesKey, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { Type } from "typebox";
import { BacklogManager, getBacklogPath, BacklogTask, subtaskEditText, subtaskProgress, subtaskState } from "../src/lib/backlog.js";

function tildify(p: string): string {
  const home = process.env.HOME ?? "";
  return home && p.startsWith(home + "/") ? "~" + p.slice(home.length) : p;
}

type Filter = "all" | "open" | "done";

// "2026-11-06T10:20+02:00" -> "2026-11-06 10:20"
function shortStamp(stamp: string): string {
  const m = stamp.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/);
  return m ? `${m[1]} ${m[2]}` : stamp;
}

// Copy text to the system clipboard: wl-copy on Wayland, xclip on X11 (with fallback).
function copyToClipboard(text: string): void {
  const cmds: [string, string[]][] = process.env.WAYLAND_DISPLAY
    ? [["wl-copy", []], ["xclip", ["-selection", "clipboard"]]]
    : [["xclip", ["-selection", "clipboard"]], ["wl-copy", []]];
  const [cmd, args] = cmds[0];
  const [cmd2, args2] = cmds[1];
  const run = (c: string, a: string[], fallback?: () => void) => {
    const child = spawn(c, a, { stdio: ["pipe", "ignore", "ignore"] });
    child.on("error", () => fallback?.());
    child.stdin.on("error", () => {});
    child.stdin.end(text);
  };
  run(cmd, args, () => run(cmd2, args2));
}

// A visible list row is either a task or one of its subtasks.
type Row = { kind: "task"; task: BacklogTask } | { kind: "sub"; task: BacklogTask; index: number };

// add/edit: task form (title, section, priority). subadd/subedit: subtask title only.
type Mode = "list" | "add" | "edit" | "subadd" | "subedit";

class BacklogApp {
  focused = false;
  private manager: BacklogManager;
  private selected = 0;
  private filter: Filter = "open";
  private selectedSection: string = "all";
  private mode: Mode = "list";
  // Task ids whose subtasks are hidden. Subtasks are shown by default.
  private collapsed = new Set<string>();
  private message = "";

  // Add / Edit mode
  private inputTitle = "";
  private inputCursor = 0;
  private inputSection = "";
  private inputPriority: "high" | "med" | "low" | undefined = undefined;
  private editId: string | null = null;

  // Subtask modes: parent task id, and subtask index for subedit
  private subParentId: string | null = null;
  private editSubIndex: number | null = null;

  private cachedWidth?: number;
  private cachedLines?: string[];

  onClose?: () => void;

  constructor(private theme: Theme) {
    this.manager = new BacklogManager(getBacklogPath());
    const sections = this.manager.getTasks().map(t => t.section);
    if (sections.length > 0) {
      this.inputSection = sections[0];
    }
  }

  private get visible(): BacklogTask[] {
    const tasks = this.manager.getTasks({
      done: this.filter === "open" ? false : this.filter === "done" ? true : undefined,
    });
    if (this.selectedSection !== "all") {
      return tasks.filter(t => t.section.toLowerCase() === this.selectedSection.toLowerCase());
    }
    return tasks;
  }

  private get rows(): Row[] {
    const out: Row[] = [];
    for (const task of this.visible) {
      out.push({ kind: "task", task });
      if (!this.collapsed.has(task.id)) {
        task.subtasks.forEach((_, index) => out.push({ kind: "sub", task, index }));
      }
    }
    return out;
  }

  private get sections(): string[] {
    const set = new Set<string>();
    for (const t of this.manager.getTasks()) {
      set.add(t.section);
    }
    return Array.from(set);
  }

  private clampSelection(): void {
    this.selected = Math.min(this.selected, Math.max(0, this.rows.length - 1));
  }

  handleInput(data: string): void {
    this.message = "";
    if (this.mode === "list") {
      this.handleList(data);
    } else {
      this.handleForm(data);
    }
    this.clampSelection();
    this.invalidate();
  }

  private handleList(data: string): void {
    const rows = this.rows;
    const row = rows[this.selected];
    const parent = row?.task;

    if (matchesKey(data, Key.up) || data === "k") {
      this.selected = Math.max(0, this.selected - 1);
    } else if (matchesKey(data, Key.down) || data === "j") {
      this.selected = Math.min(Math.max(0, rows.length - 1), this.selected + 1);
    } else if (matchesKey(data, Key.space) || matchesKey(data, Key.enter)) {
      if (row?.kind === "task") {
        this.manager.updateTask(row.task.id, { done: !row.task.done });
      } else if (row?.kind === "sub") {
        this.manager.updateSubtask(row.task.id, String(row.index + 1), { done: !row.task.subtasks[row.index].done });
      }
    } else if (data === "n" || data === "N") {
      if (parent) {
        this.collapsed.delete(parent.id);
        this.mode = "subadd";
        this.subParentId = parent.id;
        this.editSubIndex = null;
        this.inputTitle = "";
        this.inputCursor = 0;
      }
    } else if (data === "y" || data === "Y") {
      if (row) {
        const text = row.kind === "task" ? row.task.title : row.task.subtasks[row.index].title;
        copyToClipboard(text);
        this.message = `Copied: ${text}`;
      }
    } else if (data === "t" || data === "T") {
      if (parent && parent.subtasks.length > 0) {
        if (this.collapsed.has(parent.id)) this.collapsed.delete(parent.id);
        else this.collapsed.add(parent.id);
      }
    } else if (data === "d" || data === "D") {
      if (row?.kind === "task") {
        this.manager.deleteTask(row.task.id);
      } else if (row?.kind === "sub") {
        this.manager.deleteSubtask(row.task.id, String(row.index + 1));
      }
    } else if (data === "a" || data === "A") {
      this.mode = "add";
      this.inputTitle = "";
      this.inputCursor = 0;
      this.inputPriority = undefined;
      const secs = this.sections;
      this.inputSection = this.selectedSection !== "all" ? this.selectedSection : (secs[0] || "General");
      this.editId = null;
    } else if (data === "e" || data === "E") {
      if (row?.kind === "task") {
        const t = row.task;
        this.mode = "edit";
        this.inputTitle = t.title;
        this.inputCursor = t.title.length;
        this.inputSection = t.section;
        this.inputPriority = t.priority;
        this.editId = t.id;
      } else if (row?.kind === "sub") {
        this.mode = "subedit";
        this.subParentId = row.task.id;
        this.editSubIndex = row.index;
        this.inputTitle = subtaskEditText(row.task.subtasks[row.index]);
        this.inputCursor = this.inputTitle.length;
      }
    } else if (matchesKey(data, Key.tab)) {
      const filters: Filter[] = ["open", "done", "all"];
      this.filter = filters[(filters.indexOf(this.filter) + 1) % filters.length];
      this.selected = 0;
    } else if (data === "s" || data === "S") {
      const secs = ["all", ...this.sections];
      const curIdx = secs.indexOf(this.selectedSection);
      this.selectedSection = secs[(curIdx + 1) % secs.length];
      this.selected = 0;
    } else if (matchesKey(data, Key.escape) || data === "q" || data === "Q") {
      this.onClose?.();
    }
  }

  // Task and subtask forms share the same text input.
  private handleForm(data: string): void {
    if (matchesKey(data, Key.escape)) {
      this.mode = "list";
      this.editId = null;
      this.subParentId = null;
      this.editSubIndex = null;
    } else if (matchesKey(data, Key.enter)) {
      const title = this.inputTitle.trim();
      try {
        if (title) {
          if (this.mode === "subadd" && this.subParentId) {
            this.manager.addSubtask(this.subParentId, title);
          } else if (this.mode === "subedit" && this.subParentId && this.editSubIndex !== null) {
            this.manager.updateSubtask(this.subParentId, String(this.editSubIndex + 1), { title });
          } else if (this.mode === "edit" && this.editId !== null) {
            this.manager.updateTask(this.editId, {
              title,
              section: this.inputSection,
              priority: this.inputPriority,
            });
          } else if (this.mode === "add") {
            this.manager.addTask({
              title,
              section: this.inputSection || "General",
              priority: this.inputPriority,
            });
            this.selected = 0;
          }
        }
      } catch (err) {
        this.message = err instanceof Error ? err.message : String(err);
      }
      this.editId = null;
      this.subParentId = null;
      this.editSubIndex = null;
      this.mode = "list";
    } else if (matchesKey(data, Key.tab)) {
      if (this.mode === "add" || this.mode === "edit") {
        const secs = this.sections;
        if (secs.length > 0) {
          const curIdx = secs.indexOf(this.inputSection);
          this.inputSection = secs[(curIdx + 1) % secs.length];
        }
      }
    } else if (matchesKey(data, Key.backspace)) {
      if (this.inputCursor > 0) {
        this.inputTitle = this.inputTitle.slice(0, this.inputCursor - 1) + this.inputTitle.slice(this.inputCursor);
        this.inputCursor--;
      }
    } else if (matchesKey(data, Key.left)) {
      this.inputCursor = Math.max(0, this.inputCursor - 1);
    } else if (matchesKey(data, Key.right)) {
      this.inputCursor = Math.min(this.inputTitle.length, this.inputCursor + 1);
    } else if (data.length === 1 && data.charCodeAt(0) >= 32) {
      this.inputTitle = this.inputTitle.slice(0, this.inputCursor) + data + this.inputTitle.slice(this.inputCursor);
      this.inputCursor++;
    }
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;

    const th = this.theme;
    const lines: string[] = [];
    const rows = this.rows;
    const allTasks = this.manager.getTasks();
    const openCount = allTasks.filter((t) => !t.done).length;

    // ── Header ──────────────────────────────────────────────────────
    const titlePart = th.fg("accent", ` Backlog (${tildify(this.manager.path)}) `);
    const countPart = th.fg("muted", ` ${openCount} open / ${allTasks.length} total `);
    const divLen = Math.max(0, width - visibleWidth(titlePart) - visibleWidth(countPart));
    lines.push(truncateToWidth(titlePart + th.fg("dim", "─".repeat(divLen)) + countPart, width));

    // ── Filters & Section ───────────────────────────────────────────
    const filters: Filter[] = ["open", "done", "all"];
    const filterStr = filters
      .map((f) => (f === this.filter ? th.fg("accent", `[${f}]`) : th.fg("dim", ` ${f} `)))
      .join(" ");

    const secLabel = th.fg("muted", " Section: ") + th.fg("accent", `[${this.selectedSection}]`);
    lines.push(truncateToWidth(` ${filterStr}   ${secLabel} (s to cycle)`, width));
    lines.push(th.fg("dim", "─".repeat(width)));

    // ── Rows: tasks and their subtasks ──────────────────────────────
    if (rows.length === 0) {
      lines.push("");
      lines.push("  " + th.fg("muted", "No backlog items found."));
      lines.push("");
    } else {
      let lastSection = "";
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const isSel = i === this.selected && this.mode === "list";
        const prefix = isSel ? th.fg("accent", "▶") : " ";

        if (row.kind === "sub") {
          const sub = row.task.subtasks[row.index];
          const check = sub.done ? th.fg("success", "●") : th.fg("dim", "○");
          const text = sub.done
            ? th.fg("muted", "\x1b[9m" + sub.title + "\x1b[29m")
            : th.fg("text", sub.title);
          const state = subtaskState(row.task, row.index);
          const blockedBadge = state.blocked
            ? th.fg("warning", ` ⛔ blocked by ${[...state.openBlockers, ...state.unknownBlockers].join(", ")}`)
            : "";
          lines.push(truncateToWidth(`${prefix}     ${check} ${text}${blockedBadge}`, width));
          continue;
        }

        const task = row.task;
        if (this.selectedSection === "all" && task.section !== lastSection) {
          lastSection = task.section;
          lines.push(th.fg("dim", ` ── ${task.section} ` + "─".repeat(Math.max(0, width - visibleWidth(task.section) - 6))));
        }

        const check = task.done ? th.fg("success", "●") : th.fg("dim", "○");
        const priorityBadge = task.priority
          ? task.priority === "high"
            ? th.fg("error", " [high]")
            : task.priority === "med"
            ? th.fg("warning", " [med]")
            : th.fg("dim", " [low]")
          : "";

        const ticketBadge = task.ticket ? th.fg("accent", ` [${task.ticket}]`) : "";

        let foldBadge = "";
        const progress = subtaskProgress(task);
        if (progress.total > 0) {
          const folded = this.collapsed.has(task.id);
          const done = progress.done === progress.total;
          foldBadge = th.fg(done ? "success" : "muted", ` ${folded ? "▸" : "▾"} ${progress.done}/${progress.total}`);
        }

        const textColored = task.done
          ? th.fg("muted", "\x1b[9m" + task.title + "\x1b[29m")
          : th.fg("text", task.title);

        const doneStamp = task.done && task.meta.done ? th.fg("dim", ` ✓ ${shortStamp(task.meta.done)}`) : "";

        const row2 = `${prefix} ${check} ${textColored}${doneStamp}${priorityBadge}${ticketBadge}${foldBadge}`;
        lines.push(truncateToWidth(row2, width));
      }
    }

    // ── Footer / forms ──────────────────────────────────────────────
    lines.push(th.fg("dim", "─".repeat(width)));

    if (this.mode === "add" || this.mode === "edit" || this.mode === "subadd" || this.mode === "subedit") {
      const isSub = this.mode === "subadd" || this.mode === "subedit";
      const isEdit = this.mode === "edit" || this.mode === "subedit";
      const before = this.inputTitle.slice(0, this.inputCursor);
      const atCursor = this.inputTitle[this.inputCursor] ?? " ";
      const after = this.inputTitle.slice(this.inputCursor + 1);
      const cursorMark = this.focused ? CURSOR_MARKER : "";
      const inputLine =
        th.fg("accent", isEdit ? " ~ " : " + ") +
        (isSub ? th.fg("muted", "subtask: ") : "") +
        before +
        cursorMark +
        "\x1b[7m" + atCursor + "\x1b[27m" +
        after;

      lines.push(truncateToWidth(inputLine, width));
      if (isSub) {
        const parentTitle = this.manager.getTask(this.subParentId ?? "")?.title ?? "?";
        lines.push(th.fg("dim", "   parent: ") + th.fg("accent", truncateToWidth(parentTitle, Math.max(10, width - 14))));
      } else {
        lines.push(
          th.fg("dim", "   section: ") +
          th.fg("accent", this.inputSection || "General") +
          th.fg("muted", "  (tab to cycle sections)")
        );
      }
      lines.push(th.fg("dim", `   ${isEdit ? "editing" : "adding"}${isSub ? " subtask" : ""}  •  enter confirm  •  esc cancel`));
    } else {
      if (this.message) {
        lines.push(truncateToWidth(th.fg("error", " " + this.message), width));
      }
      lines.push(
        th.fg("dim", " a add • n subtask • e edit • spc toggle • y copy • d delete • t fold • tab filter • s section • q close")
      );
    }

    this.cachedLines = lines;
    this.cachedWidth = width;
    return lines;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }
}

export default function (pi: ExtensionAPI) {
  // 1. Tool for AI
  pi.registerTool({
    name: "backlog_manage",
    label: "Backlog Manager",
    description:
      "Query or modify tasks in the backlog file (default ~/wiki/backlog.md, override with PI_BACKLOG_PATH). " +
      "Actions: 'list' (query open/done tasks), 'add' (create task, optional subtasks), 'update' (toggle done or edit task), 'delete' (remove task), " +
      "'subtask_add' (add subtask to task id), 'subtask_update' (toggle done or rename subtask), 'subtask_delete' (remove subtask). " +
      "Subtasks are addressed by 'subtask': 1-based number or title. " +
      "Subtasks can be blocked by other subtasks of the same task: pass 'blocked_by' (1-based numbers) to subtask_add/subtask_update " +
      "(empty array clears). Subtasks can carry detail lines (acceptance criteria, notes): pass 'details' to subtask_add; " +
      "subtask_update 'details' replaces them (empty array clears). 'list' shows 'details' per subtask, and 'blocked_by', 'ready' and 'open_blockers' per subtask, derived from current done flags.",
    promptSnippet: "Read or manage backlog tasks and subtasks in the backlog file",
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("list"),
        Type.Literal("add"),
        Type.Literal("update"),
        Type.Literal("delete"),
        Type.Literal("subtask_add"),
        Type.Literal("subtask_update"),
        Type.Literal("subtask_delete"),
      ], { description: "Operation to perform" }),
      id: Type.Optional(Type.String({ description: "Task ID (slug) for update/delete/subtask actions" })),
      title: Type.Optional(Type.String({ description: "Task title for add/update, or subtask title for subtask_add/subtask_update" })),
      section: Type.Optional(Type.String({ description: "Section heading (e.g. 'Engineering learning')" })),
      done: Type.Optional(Type.Boolean({ description: "Task status (true for done, false for open); for subtask_update, the subtask status" })),
      priority: Type.Optional(Type.Union([Type.Literal("high"), Type.Literal("med"), Type.Literal("low")])),
      ticket: Type.Optional(Type.String({ description: "Linked ticket, e.g. PROJ-123" })),
      details: Type.Optional(Type.Array(Type.String(), { description: "Bullet points / details for the task; for subtask_add/subtask_update, the detail lines of the subtask" })),
      subtasks: Type.Optional(Type.Array(Type.String(), { description: "Subtask titles for add" })),
      subtask: Type.Optional(Type.String({ description: "Subtask reference for subtask_update/subtask_delete: 1-based number or title" })),
      blocked_by: Type.Optional(Type.Array(Type.Number(), { description: "For subtask_add/subtask_update: 1-based numbers of subtasks of the same task that must be done first" })),
      query: Type.Optional(Type.String({ description: "Search query string for 'list' action" })),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const manager = new BacklogManager(getBacklogPath());
      const text = (msg: string) => ({ content: [{ type: "text" as const, text: msg }], details: {} });

      if (params.action === "list") {
        const tasks = manager.getTasks({
          section: params.section,
          done: params.done,
          query: params.query,
        });
        const summary = tasks.map(t => {
          const progress = subtaskProgress(t);
          return {
            id: t.id,
            title: t.title,
            section: t.section,
            done: t.done,
            priority: t.priority,
            ticket: t.ticket,
            detailsCount: t.details.length,
            subtaskProgress: progress.total > 0 ? `${progress.done}/${progress.total}` : undefined,
            subtasks: t.subtasks.map((s, i) => {
              const state = subtaskState(t, i);
              return {
                n: i + 1,
                title: s.title,
                done: s.done,
                ...(s.details.length > 0 ? { details: s.details } : {}),
                ...(s.blockedBy.length > 0
                  ? {
                      blocked_by: s.blockedBy,
                      ready: !state.blocked,
                      open_blockers: state.openBlockers,
                      ...(state.unknownBlockers.length > 0 ? { unknown_blockers: state.unknownBlockers } : {}),
                    }
                  : {}),
              };
            }),
          };
        });
        return {
          content: [{ type: "text", text: JSON.stringify(summary, null, 2) }],
          details: { count: tasks.length },
        };
      }

      if (params.action === "add") {
        if (!params.title) {
          return text("Error: 'title' is required to add a task.");
        }
        const created = manager.addTask({
          title: params.title,
          section: params.section || "General",
          priority: params.priority,
          ticket: params.ticket,
          details: params.details,
          subtasks: params.subtasks,
        });
        const subNote = created.subtasks.length > 0 ? `\nSubtasks: ${created.subtasks.length}` : "";
        return {
          content: [{ type: "text", text: `Task created successfully:\nID: ${created.id}\nTitle: ${created.title}\nSection: ${created.section}${subNote}` }],
          details: { id: created.id },
        };
      }

      if (params.action === "update") {
        if (!params.id) {
          return text("Error: 'id' is required to update a task.");
        }
        const updated = manager.updateTask(params.id, {
          title: params.title,
          done: params.done,
          section: params.section,
          priority: params.priority,
          ticket: params.ticket,
          details: params.details,
        });
        if (!updated) {
          return text(`Error: Task with id '${params.id}' not found.`);
        }
        return {
          content: [{ type: "text", text: `Task '${params.id}' updated:\nStatus: ${updated.done ? "done" : "open"}\nTitle: ${updated.title}` }],
          details: { task: updated },
        };
      }

      if (params.action === "delete") {
        if (!params.id) {
          return text("Error: 'id' is required to delete a task.");
        }
        const ok = manager.deleteTask(params.id);
        if (!ok) {
          return text(`Error: Task with id '${params.id}' not found.`);
        }
        return text(`Task '${params.id}' deleted.`);
      }

      if (params.action === "subtask_add") {
        if (!params.id || !params.title) {
          return text("Error: 'id' and 'title' are required to add a subtask.");
        }
        try {
          const sub = manager.addSubtask(params.id, params.title, params.blocked_by, params.details);
          const progress = subtaskProgress(manager.getTask(params.id)!);
          const blockNote = sub.blockedBy.length > 0 ? `\nBlocked by: ${sub.blockedBy.join(", ")}` : "";
          return text(`Subtask added to '${params.id}':\nTitle: ${sub.title}${blockNote}\nProgress: ${progress.done}/${progress.total}`);
        } catch (err) {
          return text(`Error: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      if (params.action === "subtask_update") {
        if (!params.id || !params.subtask) {
          return text("Error: 'id' and 'subtask' are required to update a subtask.");
        }
        try {
          const sub = manager.updateSubtask(params.id, params.subtask, { title: params.title, done: params.done, blockedBy: params.blocked_by, details: params.details });
          const progress = subtaskProgress(manager.getTask(params.id)!);
          const blockNote = sub.blockedBy.length > 0 ? `\nBlocked by: ${sub.blockedBy.join(", ")}` : "";
          return text(`Subtask updated on '${params.id}':\nStatus: ${sub.done ? "done" : "open"}\nTitle: ${sub.title}${blockNote}\nProgress: ${progress.done}/${progress.total}`);
        } catch (err) {
          return text(`Error: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      if (params.action === "subtask_delete") {
        if (!params.id || !params.subtask) {
          return text("Error: 'id' and 'subtask' are required to delete a subtask.");
        }
        try {
          const removed = manager.deleteSubtask(params.id, params.subtask);
          return text(`Subtask '${removed.title}' deleted from '${params.id}'.`);
        } catch (err) {
          return text(`Error: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      return text("Unknown action.");
    },
  });

  // 2. Interactive TUI command: /backlog
  pi.registerCommand("backlog", {
    description: "Open interactive backlog manager (default ~/wiki/backlog.md, or $PI_BACKLOG_PATH)",
    handler: async (_args, ctx) => {
      await ctx.ui.custom<void>(
        (tui, theme, _kb, done) => {
          const app = new BacklogApp(theme);
          app.onClose = () => done(undefined);

          return {
            focused: false,
            get focused() { return app.focused; },
            set focused(v: boolean) { app.focused = v; },
            render: (w: number) => app.render(w),
            invalidate: () => app.invalidate(),
            handleInput: (data: string) => {
              app.handleInput(data);
              tui.requestRender();
            },
          };
        },
        {
          overlay: true,
          overlayOptions: {
            width: "80%",
            minWidth: 70,
            anchor: "center",
          },
        }
      );
    },
  });
}
